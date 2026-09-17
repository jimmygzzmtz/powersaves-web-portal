// portal.js — WebHID communication with Datel PowerSaves for Amiibo & compatible portals
//
// Attributions & Credits:
// - Reverse-engineered protocol by malc0mn (https://github.com/malc0mn/amiigo)
// - Initial WebHID read port by pathawks (https://github.com/pathawks/amiigo-web)

export const CMD_GET_DEVICE_NAME = 0x02;
export const CMD_RESET = 0x08;
export const CMD_RF_FIELD_ON = 0x10;
export const CMD_RF_FIELD_OFF = 0x11;
export const CMD_GET_TOKEN_UID = 0x12;
export const CMD_UNLOCK = 0x1b;
export const CMD_READ = 0x1c;
export const CMD_WRITE = 0x1d;
export const CMD_UNKNOWN4 = 0x1e;
export const CMD_UNKNOWN1 = 0x1f;
export const CMD_SET_LED_STATE = 0x20;
export const CMD_READ_SIGNATURE = 0x21;
export const CMD_MAKE_KEY = 0x30;

export const PACKET_SIZE = 64;
export const PAD_BYTE = 0xcd;
export const NTAG215_SIZE = 540;
export const COMMAND_TIMEOUT_MS = 2500;

export const DEVICE_FILTERS = [
  { vendorId: 0x1c1a, productId: 0x03d9 }, // Datel PowerSaves for Amiibo
  { vendorId: 0x5c60, productId: 0xdead }, // MaxLander / NaMiio
];

export class Portal {
  constructor() {
    this.device = null;
    this._responseResolver = null;
    this._onDisconnect = null;
    this._inputReportHandler = this._onInputReport.bind(this);
    this._log = () => {};
    this.isBusy = false;
  }

  get isConnected() {
    return this.device !== null && this.device.opened;
  }

  async connect({ onDisconnect, onLog } = {}) {
    if (!navigator.hid) {
      throw new Error("WebHID is not supported in this browser. Please use Chrome 89+, Edge, or Chromium over HTTPS or localhost.");
    }

    this._onDisconnect = onDisconnect;
    this._log = onLog || (() => {});

    const devices = await navigator.hid.requestDevice({ filters: DEVICE_FILTERS });
    if (!devices || devices.length === 0) {
      throw new Error("No compatible NFC portal was selected.");
    }

    this.device = devices[0];
    this._log(`Selected device: ${this.device.productName || "NFC Portal"} (${hex16(this.device.vendorId)}:${hex16(this.device.productId)})`);

    await this.device.open();
    this.device.addEventListener("inputreport", this._inputReportHandler);

    navigator.hid.addEventListener("disconnect", (e) => {
      if (e.device === this.device) {
        this._log("Portal hardware disconnected.");
        this.device = null;
        this._onDisconnect?.();
      }
    });

    this._log("WebHID connection established.");
    return {
      productName: this.device.productName || "NFC Portal",
      vendorId: hex16(this.device.vendorId),
      productId: hex16(this.device.productId),
    };
  }

  disconnect() {
    if (this.device) {
      this.device.removeEventListener("inputreport", this._inputReportHandler);
      try {
        this.device.close();
      } catch (e) {
        // Ignore close errors
      }
      this.device = null;
      this._log("Portal disconnected.");
    }
  }

  buildPacket(command, args = []) {
    const packet = new Uint8Array(PACKET_SIZE);
    packet.fill(PAD_BYTE);
    packet[0] = command;
    for (let i = 0; i < args.length && i < PACKET_SIZE - 1; i++) {
      packet[1 + i] = args[i];
    }
    return packet;
  }

  async sendCommand(command, args = []) {
    if (!this.device || !this.device.opened) {
      throw new Error("Portal is not connected.");
    }

    const packet = this.buildPacket(command, args);

    // SetLedState command never returns a response packet from the MCU
    if (command === CMD_SET_LED_STATE) {
      await this.device.sendReport(0x00, packet);
      return { data: null, isError: false };
    }

    let timer = null;
    const responsePromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this._responseResolver = null;
        reject(new Error(`Command 0x${command.toString(16).padStart(2, "0")} timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      this._responseResolver = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });

    try {
      await this.device.sendReport(0x00, packet);
    } catch (err) {
      clearTimeout(timer);
      this._responseResolver = null;
      throw err;
    }

    const data = await responsePromise;
    const isError = data[0] === 0x01 && data[1] === 0x02;
    return { data, isError };
  }

  _onInputReport(event) {
    const data = new Uint8Array(event.data.buffer);
    if (this._responseResolver) {
      const resolve = this._responseResolver;
      this._responseResolver = null;
      resolve(data);
    }
  }

  extractUid(response) {
    if (!response || response.length < 5) return null;
    const length = response[4]; // byte 4 = NUID length (4 or 7 bytes)
    if (length !== 4 && length !== 7) return null;
    if (response.length < 5 + length) return null;
    return response.slice(5, 5 + length);
  }

  // Poll for a newly placed token on an empty base (RF cycle -> GetTokenUid)
  async pollForNewToken() {
    if (this.isBusy || !this.isConnected) return { found: false, uid: null };

    await this.sendCommand(CMD_RF_FIELD_OFF);
    await this.sendCommand(CMD_RF_FIELD_ON);
    const { data, isError } = await this.sendCommand(CMD_GET_TOKEN_UID);

    if (isError) return { found: false, uid: null };

    const uid = this.extractUid(data);
    return { found: uid !== null, uid };
  }

  // Check if a token is STILL resting on the portal WITHOUT cutting RF power!
  // Matches amiigo driver_stm32f0: when token is placed, only query GetTokenUid (0x12)
  async pollTokenPresent() {
    if (this.isBusy || !this.isConnected) return { present: true, uid: null };

    const { data, isError } = await this.sendCommand(CMD_GET_TOKEN_UID);
    if (isError) return { present: false, uid: null };

    const uid = this.extractUid(data);
    return { present: uid !== null, uid };
  }

  async pollOnce() {
    return this.pollForNewToken();
  }

  // Token initialization handshake required before reading tokens
  async initDance(uid) {
    await this.setLed(0xff);
    await this.sendCommand(CMD_UNKNOWN1);
    await this.sendCommand(CMD_READ_SIGNATURE);

    // Read page 0x10 with retry
    let page16 = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: page16Resp, isError } = await this.sendCommand(CMD_READ, [0x10]);
      if (!isError && page16Resp && page16Resp.length >= 18) {
        page16 = page16Resp.slice(2, 18);
        break;
      }
      await sleep(25);
    }
    if (!page16) throw new Error("Failed to read page 0x10 during handshake.");

    const mkArgs = new Uint8Array(uid.length + page16.length);
    mkArgs.set(uid);
    mkArgs.set(page16, uid.length);
    const { data: keyResp } = await this.sendCommand(CMD_MAKE_KEY, mkArgs);
    const key = keyResp.slice(2, 18);

    const u4Args = new Uint8Array(1 + key.length);
    u4Args[0] = 0x00;
    u4Args.set(key, 1);
    await this.sendCommand(CMD_UNKNOWN4, u4Args);

    await this.sendCommand(CMD_UNKNOWN1);

    // Power cycle — essential for authentic Amiibo tags, given settling delay for Power Tags
    await sleep(20);
    await this.sendCommand(CMD_RF_FIELD_OFF);
    await sleep(35);
    await this.sendCommand(CMD_RF_FIELD_ON);
    await sleep(35);
    const { data: uidResp, isError } = await this.sendCommand(CMD_GET_TOKEN_UID);

    if (isError) {
      throw new Error("Token was lost during initialization power cycle.");
    }

    return true;
  }

  // Read all 540 bytes (pages 0x00 to 0x84, 16 bytes per read) with pacing & backoff
  async readToken(onProgress = null) {
    const token = new Uint8Array(NTAG215_SIZE);
    let offset = 0;
    const totalPages = 0x88;

    for (let page = 0x00; page < totalPages; page += 4) {
      let pageErrors = 0;
      while (true) {
        const { data, isError } = await this.sendCommand(CMD_READ, [page]);
        if (isError || !data || data.length < 18) {
          if (++pageErrors > 4) {
            throw new Error(`Failed to read page 0x${page.toString(16).padStart(2, "0")} after ${pageErrors} attempts.`);
          }
          // Back off before retry to allow RF carrier and NFC demodulator to recover
          await sleep(25 + pageErrors * 15);
          continue;
        }

        const bytesToCopy = Math.min(16, NTAG215_SIZE - offset);
        token.set(data.slice(2, 2 + bytesToCopy), offset);
        offset += bytesToCopy;
        break;
      }

      // Pacing delay between read chunks prevents overloading USB & RF framing
      await sleep(8);

      if (onProgress) {
        onProgress(Math.min(offset, NTAG215_SIZE), NTAG215_SIZE);
      }
    }

    return token;
  }

  // 2-pass read verification with targeted retry resolution
  async readTokenWithValidation(onProgress = null) {
    this.isBusy = true;
    try {
      this._log("Reading tag data (pass 1)...");
      const first = await this.readToken((cur, tot) => onProgress?.(cur, tot * 2, "Pass 1/2"));

      // Inter-pass delay
      await sleep(60);

      this._log("Reading tag data (pass 2, verification)...");
      const second = await this.readToken((cur, tot) => onProgress?.(tot + cur, tot * 2, "Pass 2/2"));

      // Check for mismatches between pass 1 and pass 2 (RF glitches)
      const mismatchedPages = new Set();
      for (let i = 0; i < NTAG215_SIZE; i++) {
        if (first[i] !== second[i]) {
          const page = Math.floor(i / 16) * 4;
          mismatchedPages.add(page);
        }
      }

      if (mismatchedPages.size > 0) {
        this._log(`Resolving ${mismatchedPages.size} unstable page(s) via targeted re-read...`);
        for (const page of mismatchedPages) {
          const offset = page * 4;
          let retries = 0;
          let resolved = false;
          while (retries++ < 4) {
            await sleep(30);
            const { data, isError } = await this.sendCommand(CMD_READ, [page]);
            if (!isError && data && data.length >= 18) {
              const bytesToCopy = Math.min(16, NTAG215_SIZE - offset);
              const slice = data.slice(2, 2 + bytesToCopy);
              first.set(slice, offset);
              second.set(slice, offset);
              resolved = true;
              break;
            }
          }
          if (!resolved) {
            this._log(`Warning: Page 0x${page.toString(16).padStart(2, "0")} remained unstable after re-reads.`);
          }
        }
      }

      // Final check
      for (let i = 0; i < NTAG215_SIZE; i++) {
        if (first[i] !== second[i]) {
          throw new Error(`Tag verification failed: data mismatch at byte index ${i} (0x${first[i].toString(16)} vs 0x${second[i].toString(16)}).`);
        }
      }

      this._log("Dual-pass verification successful: tag data verified.");
      return first;
    } finally {
      this.isBusy = false;
    }
  }

  // Safe Power Tag / Amiibo Writing Sequence
  // Implemented from malc0mn's reverse-engineering in driver_stm32f0.go
  async writeToken(data, { userdataOnly = false, onProgress = null } = {}) {
    if (!data || data.length !== NTAG215_SIZE) {
      throw new Error(`Invalid dump size: expected ${NTAG215_SIZE} bytes, got ${data?.length ?? 0}`);
    }

    this.isBusy = true;
    try {
      this._log(`Starting ${userdataOnly ? "userdata" : "full"} write procedure...`);

      // 1. Power cycle token
      this._log("Write Init: Power cycling NFC field...");
      await this.sendCommand(CMD_RF_FIELD_OFF);
      await sleep(35);
      await this.sendCommand(CMD_RF_FIELD_ON);
      await sleep(35);

      // 2. Query token UID
      const { data: uidResp, isError: uidErr } = await this.sendCommand(CMD_GET_TOKEN_UID);
      if (uidErr) {
        throw new Error("Failed to detect token on portal during write initialization.");
      }
      const uid = this.extractUid(uidResp);
      if (!uid) {
        throw new Error("Invalid token UID returned during write initialization.");
      }
      this._log(`Write Init: Token detected with UID ${toHex(uid)}`);

      // 3. Handshake
      if (!userdataOnly) {
        this._log("Write Init: Reading page 0x10 for auth handshake...");
        let page16 = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const { data: page16Resp, isError: p16Err } = await this.sendCommand(CMD_READ, [0x10]);
          if (!p16Err && page16Resp && page16Resp.length >= 18) {
            page16 = page16Resp.slice(2, 18);
            break;
          }
          await sleep(25);
        }
        if (!page16) throw new Error("Failed to read page 0x10 during write authentication.");

        this._log("Write Init: Generating auth key (MakeKey)...");
        const mkArgs = new Uint8Array(uid.length + page16.length);
        mkArgs.set(uid);
        mkArgs.set(page16, uid.length);
        const { data: keyResp, isError: keyErr } = await this.sendCommand(CMD_MAKE_KEY, mkArgs);
        if (keyErr) throw new Error("Portal failed to generate authentication key.");
        const key = keyResp.slice(2, 18);

        this._log("Write Init: Sending auth key (Unknown4)...");
        const u4Args = new Uint8Array(1 + key.length);
        u4Args[0] = 0x00;
        u4Args.set(key, 1);
        const { isError: u4Err } = await this.sendCommand(CMD_UNKNOWN4, u4Args);
        if (u4Err) throw new Error("Portal rejected authentication key parameter.");
      }

      // 4. Unlock tag for writing
      this._log("Write Init: Unlocking tag (0x1b)...");
      const { data: unlockResp, isError: unlockErr } = await this.sendCommand(CMD_UNLOCK);
      if (unlockErr) {
        throw new Error("Tag rejected unlock command (0x1b). The tag may be locked or not rewritable.");
      }
      this._log("Tag unlocked successfully.");

      // 5. Determine write page order
      //
      // CRITICAL SAFETY SEQUENCE FROM AMIIGO REVERSE ENGINEERING:
      // For Full Write (135 pages):
      //   - Write page 0x86 FIRST (PACK & RFUI)
      //   - Write pages 0x01 through 0x85 sequentially
      //   - Write page 0x00 LAST (UID0..UID2 + BCC0)
      // Writing page 0 last ensures the tag's identity and NFC framing
      // are not altered mid-write while communicating with the portal.
      //
      // For Userdata Restore:
      //   - Write pages 0x04 through 0x81 (NTAG215 user memory area)
      const pageSequence = [];
      if (userdataOnly) {
        for (let p = 0x04; p <= 0x81; p++) {
          pageSequence.push(p);
        }
      } else {
        pageSequence.push(0x86); // First
        for (let p = 0x01; p <= 0x85; p++) {
          pageSequence.push(p);
        }
        pageSequence.push(0x00); // Last
      }

      const totalPages = pageSequence.length;
      this._log(`Writing ${totalPages} pages to tag...`);

      for (let step = 0; step < totalPages; step++) {
        const page = pageSequence[step];
        const offset = page * 4;
        const pageData = data.slice(offset, offset + 4);

        const args = new Uint8Array(5);
        args[0] = page;
        args.set(pageData, 1);

        let pageErrors = 0;
        while (true) {
          const { isError } = await this.sendCommand(CMD_WRITE, args);
          if (isError) {
            if (++pageErrors > 3) {
              throw new Error(`Failed to write page 0x${page.toString(16).padStart(2, "0")} after ${pageErrors} attempts.`);
            }
            this._log(`Retry writing page 0x${page.toString(16).padStart(2, "0")} (attempt ${pageErrors + 1})...`);
            await sleep(35);
            continue;
          }
          break;
        }

        // Pacing delay (15ms) allows Power Tag EEPROM/flash to complete write cycle
        await sleep(15);

        onProgress?.(step + 1, totalPages, `Page 0x${page.toString(16).padStart(2, "0")} (${step + 1}/${totalPages})`);
      }

      this._log("All pages written successfully. Settling EEPROM before post-write verification...");
      await sleep(120);

      // 6. Post-write validation read-back
      const readBack = await this.readTokenWithValidation((cur, tot, pass) => {
        onProgress?.(cur, tot, `Verifying: ${pass}`);
      });

      // Byte-for-byte check against input data
      if (userdataOnly) {
        for (let i = 16; i < 520; i++) {
          if (readBack[i] !== data[i]) {
            throw new Error(`Verification mismatch in userdata at byte ${i} (expected 0x${data[i].toString(16)}, got 0x${readBack[i].toString(16)})`);
          }
        }
      } else {
        for (let i = 0; i < NTAG215_SIZE; i++) {
          if (readBack[i] !== data[i]) {
            throw new Error(`Verification mismatch at byte ${i} (expected 0x${data[i].toString(16)}, got 0x${readBack[i].toString(16)})`);
          }
        }
      }

      this._log("Write operation completely verified!");
      return readBack;
    } finally {
      this.isBusy = false;
    }
  }

  async setLed(brightness = 0xff) {
    const val = Math.max(0, Math.min(255, brightness));
    await this.sendCommand(CMD_SET_LED_STATE, [val]);
  }

  async ledOff() {
    await this.setLed(0x00);
  }
}

function hex16(n) {
  return "0x" + n.toString(16).padStart(4, "0");
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


