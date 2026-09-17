# PowerSaves Web Portal (with Power Tag Flashing)

A modern, browser-based Amiibo and **Power Tag** manager using **WebHID** to communicate directly with Datel PowerSaves for Amiibo (and compatible) NFC hardware portals.

Built with **Preact 11 (`preact@11.0.0-rc.2`)** and **HTM** using native browser ES Module import maps — **zero build step required!**

---

## ✨ Features

- **⚡ Full Power Tag (PUC) Flashing**:
  - Rewrites the entire 540-byte tag (pages `0x00` through `0x86`), changing the Amiibo character identity, UID, and save data.
  - Implements the reverse-engineered Datel authentication handshake (`0x11` -> `0x10` -> `0x12` -> `0x1c 0x10` -> `0x30 MakeKey` -> `0x1e Unknown4` -> `0x1b Unlock`).
  - **Safe page write order**: writes page `0x86` first, pages `0x01` through `0x85` sequentially, and page `0x00` last to prevent UID/framing issues mid-write.
  - Post-write verification ensures byte-for-byte fidelity.
- **🔄 Userdata / Save Data Restore Mode**:
  - Safely restores pages `0x04` through `0x81` (504 bytes user memory) without touching locked OTP pages. Ideal for updating save data on existing tags or retail figures.
- **📡 Live Tag Reader**:
  - Dual-pass verification reading (`readTokenWithValidation`) prevents corrupted dumps.
  - Automatically identifies Amiibo character name, series, figure type, model number, and artwork.
- **💾 One-Click Dump Download**:
  - Export any placed tag to a standard 540-byte `.bin` file.
- **🔍 Hex Dump Inspector**:
  - Real-time address, byte, and ASCII representation for both active portal tags and staged write files.
- **📜 Live Activity Feed**:
  - Timestamped operational log of portal commands, handshakes, and write status.

---

## 🚀 Quick Start (Zero Build Step)

Since the app uses native browser ES Module import maps with Preact 11 and HTM from `esm.sh`, there is no `npm install` or build step needed.

Simply serve the repository folder over HTTP/HTTPS:

```bash
# Using Python 3:
python3 -m http.server 8080

# Or using Node.js / npx:
npx serve .
```

Then open `http://localhost:8080` in **Google Chrome**, **Microsoft Edge**, **Brave**, or any Chromium-based browser supporting **WebHID**.

---

## 🔌 Requirements & Supported Hardware

- **Browser**: Chrome 89+, Edge 89+, Brave, or any Chromium browser with WebHID support.
- **Protocol**: Must run on `localhost` or over `HTTPS` (browser security requirement for WebHID).
- **Supported Hardware**:
  - **Datel PowerSaves for Amiibo** (`1c1a:03d9`)
  - **MaxLander / NaMiio** (`5c60:dead`)
- **Tags**:
  - **Datel Power Tag / PUC**: Fully rewritable token. Supports both Full Rewrite and Userdata Restore.
  - **Retail Amiibo figures / cards**: Read-only UID & lock bytes. Supports reading, dumping, and Userdata Restore only.

---

## 🐧 Linux udev Permissions

On Linux, create `/etc/udev/rules.d/70-powersaves.rules` to allow non-root browser access to the USB portal:

```udev
# Datel PowerSaves for Amiibo
SUBSYSTEM=="usb", ATTRS{idVendor}=="1c1a", ATTRS{idProduct}=="03d9", MODE="0660", TAG+="uaccess"

# MaxLander / NaMiio
SUBSYSTEM=="usb", ATTRS{idVendor}=="5c60", ATTRS{idProduct}=="dead", MODE="0660", TAG+="uaccess"
```

Reload the rules:
```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

---

## 🏷️ Attributions & Credits

This project builds directly upon the reverse-engineering research and open-source contributions of:

- **[malc0mn/amiigo](https://github.com/malc0mn/amiigo)** by **[malc0mn](https://github.com/malc0mn)**: The original Go reverse-engineering effort that decoded the Datel PowerSaves USB protocol, the STM32F0 driver command set, the authentication handshakes, and the safe Power Tag (PUC) writing sequence.
- **[pathawks/amiigo-web](https://github.com/pathawks/amiigo-web)** by **[pathawks](https://github.com/pathawks)**: The pioneering WebHID port that brought the portal read capabilities and browser-based USB communication to modern Chromium browsers.
- **[AmiiboAPI](https://github.com/N3evin/AmiiboAPI)** by **[N3evin](https://github.com/N3evin)**: Open Amiibo database used for character names, series metadata, and official artwork image URLs.

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

Copyright (c) 2026 jimmygzzmtz

