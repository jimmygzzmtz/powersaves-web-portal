// app.js — PowerSaves & Power Tag Web Portal
//
// Attributions:
// - Reverse engineering & protocol by malc0mn (https://github.com/malc0mn/amiigo)
// - Initial WebHID implementation by pathawks (https://github.com/pathawks/amiigo-web)
// - Amiibo metadata & artwork from AmiiboAPI (https://github.com/N3evin/AmiiboAPI)

import { render } from 'preact';
import { signal, computed, effect } from '@preact/signals';
import { html } from 'htm/preact';
import { Portal, NTAG215_SIZE } from './portal.js';
import { parseAmiibo, formatHexDump, fetchAmiiboMetadata, downloadBin, toHex, formatUid } from './amiibo.js';

// Hardware Portal Instance
const portal = new Portal();

// Reactive State Signals (No Hooks)
const device = signal({ connected: false, name: '', vendorId: '', productId: '' });
const status = signal({ text: 'Portal Disconnected', type: 'info' });
const logs = signal([]);
const toasts = signal([]);

// Tag resting on the portal hardware
const activeTag = signal({
  raw: null,
  parsed: null,
  metadata: null,
  isReading: false,
});

// Staged dump file to write
const stagedFile = signal({
  filename: '',
  raw: null,
  parsed: null,
  metadata: null,
  error: null,
});

// Write operation state
const writing = signal({
  active: false,
  progress: 0,
  total: 100,
  label: '',
});

// Modal dialog state
const modal = signal({
  open: false,
  type: 'analysis',
  title: '',
  message: '',
  mode: 'full',
});

// Unified Lower Deck Navigation Signals
const deckTab = signal('hex'); // 'hex' | 'console'
const hexSource = signal('tag'); // 'tag' | 'staged'
const logFilter = signal('all'); // 'all' | 'nfc' | 'write'
const copiedLog = signal(false);

// Toast Notification System
const showToast = (text, type = 'info') => {
  const id = Date.now() + Math.random();
  toasts.value = [...toasts.value, { id, text, type }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 4000);
};

// Activity Log Writer
const addLog = (msg) => {
  const time = new Date().toLocaleTimeString();
  let category = 'sys';
  if (msg.includes('USB') || msg.includes('Connected') || msg.includes('WebHID')) category = 'usb';
  else if (msg.includes('Token') || msg.includes('tag') || msg.includes('Tag') || msg.includes('NFC') || msg.includes('handshake')) category = 'nfc';
  else if (msg.includes('Write') || msg.includes('Writing') || msg.includes('flash') || msg.includes('Flash')) category = 'write';
  else if (msg.includes('verif') || msg.includes('Complete') || msg.includes('SUCCESS')) category = 'ok';
  if (msg.includes('Error') || msg.includes('error') || msg.includes('failed') || msg.includes('mismatch')) category = 'err';

  logs.value = [{ id: Date.now() + Math.random(), time, category, text: msg }, ...logs.value.slice(0, 149)];
};

const handleCopyLog = () => {
  if (!logs.value || logs.value.length === 0) return;
  const text = logs.value
    .slice()
    .reverse()
    .map((l) => `[${l.time}] [${l.category.toUpperCase()}] ${l.text}`)
    .join('\n');
  navigator.clipboard.writeText(text).then(() => {
    copiedLog.value = true;
    showToast('Activity log copied to clipboard', 'success');
    setTimeout(() => {
      copiedLog.value = false;
    }, 2000);
  });
};

// Connect / Disconnect Portal Hardware
const handleToggleConnect = async () => {
  if (device.value.connected) {
    portal.disconnect();
    device.value = { connected: false, name: '', vendorId: '', productId: '' };
    status.value = { text: 'Portal Disconnected', type: 'info' };
    activeTag.value = { raw: null, parsed: null, metadata: null, isReading: false };
    addLog('Disconnected from portal.');
    showToast('Portal disconnected', 'info');
    return;
  }

  try {
    status.value = { text: 'Selecting portal device...', type: 'info' };
    const dev = await portal.connect({
      onDisconnect: () => {
        device.value = { connected: false, name: '', vendorId: '', productId: '' };
        status.value = { text: 'Portal Disconnected', type: 'error' };
        activeTag.value = { raw: null, parsed: null, metadata: null, isReading: false };
        addLog('Portal unplugged.');
        showToast('Portal hardware unplugged', 'error');
      },
      onLog: addLog,
    });

    device.value = {
      connected: true,
      name: dev.productName,
      vendorId: dev.vendorId,
      productId: dev.productId,
    };
    status.value = { text: 'Portal Ready', type: 'success' };
    addLog(`Connected: ${dev.productName} (${dev.vendorId}:${dev.productId})`);
    showToast(`Connected to ${dev.productName || 'PowerSaves Portal'}`, 'success');
  } catch (err) {
    status.value = { text: `Connection failed: ${err.message}`, type: 'error' };
    addLog(`Error: ${err.message}`);
    showToast(err.message, 'error');
  }
};

// Background Tag Polling Loop using Preact Signals Effect
effect(() => {
  if (!device.value.connected || writing.value.active) {
    return;
  }

  let timer = null;
  let isCancelled = false;
  let pollState = 'polling';
  let failedUid = null;

  const poll = async () => {
    if (isCancelled) return;

    if (!portal.isConnected || portal.isBusy || pollState === 'reading' || writing.value.active) {
      if (!isCancelled) timer = setTimeout(poll, 300);
      return;
    }

    try {
      if (pollState === 'polling') {
        const { found, uid } = await portal.pollOnce();
        const uidHex = uid ? toHex(uid) : null;

        if (found && uidHex && uidHex !== failedUid) {
          pollState = 'reading';
          activeTag.value = { ...activeTag.value, isReading: true };
          status.value = { text: `Reading tag (${uidHex})...`, type: 'info' };
          addLog(`Token detected: ${uidHex}. Performing handshake...`);

          try {
            await portal.initDance(uid);
            const data = await portal.readTokenWithValidation((cur, tot, step) => {
              status.value = { text: `Reading tag: ${step} (${Math.round((cur / tot) * 100)}%)`, type: 'info' };
            });

            const parsed = parseAmiibo(data);
            let meta = null;
            if (parsed.isAmiibo && parsed.modelInfo) {
              meta = await fetchAmiiboMetadata(parsed.modelInfo);
            }

            activeTag.value = {
              raw: data,
              parsed,
              metadata: meta,
              isReading: false,
            };

            failedUid = null;
            pollState = 'done';
            const charName = meta?.name || (parsed.isAmiibo ? parsed.modelInfo?.seriesName : 'NFC Tag');
            status.value = { text: `Tag verified: ${charName}`, type: 'success' };
            addLog(`Read complete: ${parsed.uidFormatted} (${charName})`);
            showToast(`Verified: ${charName}`, 'success');
          } catch (readErr) {
            addLog(`Read error: ${readErr.message}`);
            failedUid = uidHex;
            pollState = 'failed';
            status.value = { text: 'Tag read incomplete. Ready to flash fresh dump.', type: 'error' };
            activeTag.value = {
              raw: null,
              parsed: { uidHex, uidFormatted: formatUid(uid), uidValid: true, isAmiibo: false },
              metadata: null,
              isReading: false,
            };
            addLog('Tag is resting on portal. Click Flash / Recover Power Tag to write.');
          }
        } else if (!found && failedUid) {
          failedUid = null;
          pollState = 'polling';
          activeTag.value = { raw: null, parsed: null, metadata: null, isReading: false };
          await portal.ledOff();
          status.value = { text: 'Portal Ready', type: 'info' };
          addLog('Token removed.');
        }
      } else if (pollState === 'done' || pollState === 'failed') {
        const { found } = await portal.pollOnce();
        if (!found) {
          pollState = 'polling';
          failedUid = null;
          activeTag.value = { raw: null, parsed: null, metadata: null, isReading: false };
          await portal.ledOff();
          status.value = { text: 'Portal Ready', type: 'info' };
          addLog('Token removed.');
        }
      }
    } catch (pollErr) {
      // Suppress transient poll error
    }

    if (!isCancelled) {
      const delay = pollState === 'done' || pollState === 'failed' ? 400 : 200;
      timer = setTimeout(poll, delay);
    }
  };

  timer = setTimeout(poll, 150);

  return () => {
    isCancelled = true;
    if (timer) clearTimeout(timer);
  };
});

// Load .bin Dump for Flashing
const handleFileLoad = async (file) => {
  if (!file) return;

  try {
    addLog(`Analyzing dump: ${file.name} (${file.size} B)...`);
    const buffer = new Uint8Array(await file.arrayBuffer());

    if (buffer.length !== NTAG215_SIZE) {
      throw new Error(`Expected 540-byte dump, got ${buffer.length} bytes.`);
    }

    const parsed = parseAmiibo(buffer);
    let meta = null;
    if (parsed.isAmiibo && parsed.modelInfo) {
      meta = await fetchAmiiboMetadata(parsed.modelInfo);
    }

    stagedFile.value = {
      filename: file.name,
      raw: buffer,
      parsed,
      metadata: meta,
      error: null,
    };
    hexSource.value = 'staged';

    const charName = meta?.name || (parsed.isAmiibo ? `${parsed.modelInfo?.seriesName} Amiibo` : 'Standard Tag');
    addLog(`Dump Staged: ${charName} (UID: ${parsed.uidFormatted})`);
    showToast(`Staged: ${charName}`, 'success');

    modal.value = {
      open: true,
      type: 'analysis',
      title: 'Amiibo Identified — Flash to Tag?',
      message: '',
      mode: 'full',
    };
  } catch (err) {
    stagedFile.value = {
      filename: file.name,
      raw: null,
      parsed: null,
      metadata: null,
      error: err.message,
    };
    addLog(`File error: ${err.message}`);
    showToast(err.message, 'error');
  }
};

const handleDrop = (e) => {
  e.preventDefault();
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    handleFileLoad(e.dataTransfer.files[0]);
  }
};

// Download Active Tag .bin
const handleDownloadActive = () => {
  const current = activeTag.value;
  if (!current.raw || !current.parsed) return;
  const name = current.metadata?.name || current.parsed.modelInfo?.seriesName || 'Amiibo';
  const cleanName = name.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_');
  const filename = `${cleanName}_${current.parsed.uidHex}.bin`;
  downloadBin(current.raw, filename);
  addLog(`Dump exported: ${filename}`);
  showToast(`Saved ${filename}`, 'success');
};

// Manual Re-Read
const handleRetryRead = async () => {
  if (!device.value.connected || !portal.isConnected) return;
  if (portal.isBusy || writing.value.active) return;

  try {
    activeTag.value = { ...activeTag.value, isReading: true };
    status.value = { text: 'Re-reading tag...', type: 'info' };
    addLog('Re-reading tag with safe pacing...');

    const { found, uid } = await portal.pollOnce();
    if (!found || !uid) {
      throw new Error('No tag detected on portal base.');
    }

    await portal.initDance(uid);
    const data = await portal.readTokenWithValidation((cur, tot, step) => {
      status.value = { text: `Reading tag: ${step} (${Math.round((cur / tot) * 100)}%)`, type: 'info' };
    });

    const parsed = parseAmiibo(data);
    let meta = null;
    if (parsed.isAmiibo && parsed.modelInfo) {
      meta = await fetchAmiiboMetadata(parsed.modelInfo);
    }

    activeTag.value = {
      raw: data,
      parsed,
      metadata: meta,
      isReading: false,
    };

    const charName = meta?.name || (parsed.isAmiibo ? parsed.modelInfo?.seriesName : 'NFC Tag');
    status.value = { text: `Tag verified: ${charName}`, type: 'success' };
    addLog(`Read complete: ${parsed.uidFormatted} (${charName})`);
    showToast(`Verified: ${charName}`, 'success');
  } catch (err) {
    activeTag.value = { ...activeTag.value, isReading: false };
    status.value = { text: `Read failed: ${err.message}`, type: 'error' };
    addLog(`Read error: ${err.message}`);
    showToast(err.message, 'error');
  }
};

// Confirmation Modal Trigger
const promptWrite = (mode) => {
  if (!device.value.connected) {
    showToast('Connect portal hardware first', 'error');
    return;
  }
  if (!stagedFile.value.raw || !stagedFile.value.parsed) {
    showToast('Stage a 540-byte .bin dump file first', 'error');
    return;
  }

  const stagedName = stagedFile.value.metadata?.name || 'Amiibo dump';
  const currentName = activeTag.value.metadata?.name || 'Current tag';

  if (mode === 'userdata') {
    if (!activeTag.value.raw) {
      showToast('Place an Amiibo on the portal first to restore userdata', 'error');
      return;
    }
    const idMatch = activeTag.value.parsed.modelInfo?.idHex === stagedFile.value.parsed.modelInfo?.idHex;
    modal.value = {
      open: true,
      type: 'confirm',
      mode: 'userdata',
      title: 'Restore User Save Data Only',
      message: idMatch
        ? `Write user save data from "${stagedName}" to "${currentName}"? Only pages 0x04–0x81 will be written. Header, UID, and lock bytes will remain untouched.`
        : `CAUTION: Character ID on staged file (${stagedFile.value.parsed.modelInfo?.idHex}) does not match tag on portal (${activeTag.value.parsed.modelInfo?.idHex})! Restoring mismatched user save data can invalidate cryptographic HMACs. Proceed?`,
    };
  } else {
    modal.value = {
      open: true,
      type: 'confirm',
      mode: 'full',
      title: activeTag.value.raw ? 'Full Power Tag Rewrite' : 'Flash / Recover Power Tag',
      message: activeTag.value.raw
        ? `This will completely overwrite the Power Tag with "${stagedName}" (UID: ${stagedFile.value.parsed.uidHex}), rewriting all 135 pages (0x00 to 0x86). Ensure your tag is a rewritable Datel Power Tag (PUC). Continue?`
        : `Ensure your Power Tag is placed on the portal base. This will execute the unlock handshake (0x1b) and write all 540 bytes of "${stagedName}", completely restoring the tag. Continue?`,
    };
  }
};

// Execute Write
const executeWrite = async (modeOverride) => {
  const mode = modeOverride || modal.value.mode;
  modal.value = { open: false, type: 'confirm', title: '', message: '', mode: 'full' };

  writing.value = {
    active: true,
    progress: 0,
    total: 100,
    label: 'Initializing write sequence...',
  };
  status.value = { text: 'Writing to tag — do not remove tag...', type: 'busy' };
  addLog(`Starting ${mode === 'full' ? 'Full Power Tag Write' : 'Userdata Restore'}...`);

  try {
    const verifiedData = await portal.writeToken(stagedFile.value.raw, {
      userdataOnly: mode === 'userdata',
      onProgress: (cur, tot, lbl) => {
        writing.value = {
          active: true,
          progress: cur,
          total: tot,
          label: lbl,
        };
      },
    });

    const parsed = parseAmiibo(verifiedData);
    activeTag.value = {
      raw: verifiedData,
      parsed,
      metadata: stagedFile.value.metadata,
      isReading: false,
    };

    status.value = { text: 'Write & verification successful!', type: 'success' };
    addLog(`Write SUCCESS: Tag verified against ${stagedFile.value.filename}!`);
    showToast(`Flashed "${stagedFile.value.metadata?.name || 'Amiibo'}" successfully!`, 'success');
  } catch (err) {
    status.value = { text: `Write failed: ${err.message}`, type: 'error' };
    addLog(`WRITE ERROR: ${err.message}`);
    showToast(`Write error: ${err.message}`, 'error');
  } finally {
    writing.value = { active: false, progress: 0, total: 100, label: '' };
  }
};

export function App() {
  const currentDev = device.value;
  const currentStatus = status.value;
  const currentActive = activeTag.value;
  const currentStaged = stagedFile.value;
  const currentWriting = writing.value;
  const currentModal = modal.value;
  const currentDeck = deckTab.value;
  const currentHexSrc = hexSource.value;
  const currentLogFilter = logFilter.value;
  const currentCopied = copiedLog.value;
  const currentToasts = toasts.value;
  const allLogs = logs.value;

  const filteredLogs = allLogs.filter((l) => {
    if (currentLogFilter === 'all') return true;
    if (currentLogFilter === 'nfc') return l.category === 'nfc';
    if (currentLogFilter === 'write') return l.category === 'write';
    return true;
  });

  return html`
    <div class="container">
      <!-- Toasts -->
      <div class="toast-container">
        ${currentToasts.map(
          (t) => html`
            <div key=${t.id} class=${`toast toast-${t.type}`}>
              <span>${t.text}</span>
            </div>
          `
        )}
      </div>

      <!-- Minimalist Top Navigation (No App Icon) -->
      <header>
        <div class="brand">
          <span class="brand-title">PowerSaves Portal</span>
          <span class="brand-badge">Power Tag Utility</span>
        </div>

        <div class="header-actions">
          <div class="status-pill">
            <span
              class=${`status-dot ${
                currentDev.connected ? (currentWriting.active ? 'busy' : 'connected') : ''
              }`}
            ></span>
            <span>${currentStatus.text}</span>
          </div>

          <button
            class=${`btn ${currentDev.connected ? 'btn-danger' : 'btn-primary'}`}
            onClick=${handleToggleConnect}
            disabled=${currentWriting.active}
          >
            ${currentDev.connected ? 'Disconnect' : 'Connect Portal'}
          </button>
        </div>
      </header>

      <!-- Main Stage Grid -->
      <div class="stage-grid">
        <!-- Column 1: Hardware Tag (Target) -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">Hardware Tag</span>
            ${currentActive.raw && html`
              <div style="display: flex; gap: 0.4rem;">
                <button
                  class="btn btn-ghost"
                  style="padding: 0.25rem 0.6rem; font-size: 0.76rem;"
                  onClick=${handleRetryRead}
                  disabled=${currentWriting.active || currentActive.isReading}
                >
                  🔄 Re-Read
                </button>
                <button
                  class="btn"
                  style="padding: 0.25rem 0.65rem; font-size: 0.76rem;"
                  onClick=${handleDownloadActive}
                  disabled=${currentWriting.active}
                >
                  💾 Backup .bin
                </button>
              </div>
            `}
          </div>

          ${currentActive.raw
            ? html`
                <div class="tag-card">
                  <div class="tag-figure-box">
                    ${currentActive.metadata?.imageUrl
                      ? html`<img src=${currentActive.metadata.imageUrl} alt="Artwork" />`
                      : html`<div class="tag-figure-placeholder">🎮</div>`}
                  </div>
                  <div class="tag-info-col">
                    <div class="tag-header-area">
                      <span class="tag-series">
                        ${currentActive.parsed?.modelInfo?.seriesName || 'Amiibo'}
                      </span>
                      <span class="tag-name">
                        ${currentActive.metadata?.name || (currentActive.parsed?.isAmiibo ? 'Amiibo Tag' : 'NFC Tag')}
                      </span>
                    </div>

                    <div class="tag-meta-grid">
                      <div class="meta-chip">
                        <span class="meta-chip-label">UID</span>
                        <span class="meta-chip-val" style="color: var(--cyan);">${currentActive.parsed?.uidFormatted}</span>
                      </div>
                      <div class="meta-chip">
                        <span class="meta-chip-label">Type</span>
                        <span class="meta-chip-val">${currentActive.parsed?.modelInfo?.figureTypeName || 'NTAG215'}</span>
                      </div>
                      ${currentActive.parsed?.isAmiibo && html`
                        <div class="meta-chip">
                          <span class="meta-chip-label">ID</span>
                          <span class="meta-chip-val">${currentActive.parsed.modelInfo?.idHex}</span>
                        </div>
                        <div class="meta-chip">
                          <span class="meta-chip-label">Model</span>
                          <span class="meta-chip-val">${currentActive.parsed.modelInfo?.modelNumber}</span>
                        </div>
                      `}
                    </div>
                  </div>
                </div>
              `
            : html`
                <div class="portal-resting-deck">
                  <div class=${`portal-disc ${currentDev.connected ? (currentActive.parsed?.uidHex ? 'active' : 'ready') : ''}`}>
                    ${currentActive.parsed?.uidHex ? '⚡' : currentDev.connected ? '📡' : '🔌'}
                  </div>
                  <div>
                    ${currentActive.parsed?.uidHex
                      ? html`
                          <div style="font-weight: 700; color: var(--purple); font-size: 0.95rem;">
                            Power Tag Detected
                          </div>
                          <div style="font-family: var(--font-mono); font-size: 0.8rem; color: var(--cyan); margin: 0.2rem 0;">
                            ${currentActive.parsed.uidFormatted}
                          </div>
                          <div style="font-size: 0.78rem; color: var(--text-muted); margin-bottom: 0.75rem;">
                            Tag is responding on portal. You can read it or flash a fresh dump from the right.
                          </div>
                          <button
                            class="btn btn-primary"
                            style="padding: 0.35rem 0.9rem; font-size: 0.8rem;"
                            onClick=${handleRetryRead}
                            disabled=${currentWriting.active || currentActive.isReading}
                          >
                            ${currentActive.isReading ? 'Reading...' : '🔄 Read Tag'}
                          </button>
                        `
                      : html`
                          <div style="font-weight: 600; color: var(--text-heading); font-size: 0.9rem;">
                            ${currentDev.connected ? 'Place Tag on Portal' : 'Portal Disconnected'}
                          </div>
                          <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.2rem;">
                            ${currentDev.connected
                              ? 'Supports retail Amiibo figures, cards, and rewritable Datel Power Tags'
                              : 'Click "Connect Portal" above to establish WebHID connection'}
                          </div>
                        `}
                  </div>
                </div>
              `}
        </div>

        <!-- Column 2: Flash & Restore (Source) -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">Flash & Restore</span>
            ${currentStaged.raw && html`
              <span style="font-size: 0.75rem; color: var(--cyan); font-weight: 600;">
                Dump Ready
              </span>
            `}
          </div>

          <!-- Staging Dropzone -->
          <div
            class="dropzone"
            onDragOver=${(e) => e.preventDefault()}
            onDrop=${handleDrop}
            onClick=${() => document.getElementById('file-picker')?.click()}
          >
            <input
              type="file"
              id="file-picker"
              accept=".bin"
              style="display: none;"
              onChange=${(e) => handleFileLoad(e.target.files[0])}
            />
            <div class="dropzone-icon">📂</div>
            <div style="font-weight: 600; font-size: 0.88rem; color: var(--text-heading);">
              Drop a 540-byte Amiibo .bin dump
            </div>
            <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 0.2rem;">
              or click to browse retail backup files
            </div>
          </div>

          <!-- Staged File Card -->
          ${currentStaged.raw && html`
            <div class="tag-card">
              <div class="tag-figure-box">
                ${currentStaged.metadata?.imageUrl
                  ? html`<img src=${currentStaged.metadata.imageUrl} alt="Staged" />`
                  : html`<div class="tag-figure-placeholder">💾</div>`}
              </div>
              <div class="tag-info-col">
                <div class="tag-header-area">
                  <span class="tag-series">
                    ${currentStaged.parsed?.modelInfo?.seriesName || 'Dump'}
                  </span>
                  <span class="tag-name">
                    ${currentStaged.metadata?.name || 'Amiibo Dump'}
                  </span>
                </div>

                <div class="tag-meta-grid">
                  <div class="meta-chip">
                    <span class="meta-chip-label">File</span>
                    <span class="meta-chip-val" style="font-size: 0.7rem;">${currentStaged.filename}</span>
                  </div>
                  <div class="meta-chip">
                    <span class="meta-chip-label">Dump UID</span>
                    <span class="meta-chip-val" style="color: var(--cyan);">${currentStaged.parsed?.uidFormatted}</span>
                  </div>
                </div>

                <!-- Primary Action Buttons -->
                <div style="display: flex; gap: 0.6rem; flex-wrap: wrap; margin-top: 0.35rem;">
                  <button
                    class="btn btn-flash"
                    style="flex: 1;"
                    onClick=${() => promptWrite('full')}
                    disabled=${!currentDev.connected || !currentStaged.raw || currentWriting.active}
                  >
                    ${currentActive.raw ? '⚡ Flash to Power Tag' : '⚡ Flash / Recover Power Tag'}
                  </button>
                  <button
                    class="btn"
                    style="flex: 1;"
                    onClick=${() => promptWrite('userdata')}
                    disabled=${!currentDev.connected || !currentActive.raw || currentWriting.active}
                    title="Only write pages 0x04–0x81 (save data). Safe for existing retail Amiibo figures."
                  >
                    🔄 Restore Save Data
                  </button>
                </div>
              </div>
            </div>
          `}

          <!-- Progress -->
          ${currentWriting.active && html`
            <div class="progress-container">
              <div class="progress-header">
                <span>${currentWriting.label}</span>
                <span style="font-family: var(--font-mono); color: var(--cyan);">
                  ${Math.round((currentWriting.progress / (currentWriting.total || 1)) * 100)}%
                </span>
              </div>
              <div class="progress-track">
                <div
                  class="progress-fill"
                  style="width: ${Math.min(100, Math.round((currentWriting.progress / (currentWriting.total || 1)) * 100))}%;"
                ></div>
              </div>
            </div>
          `}
        </div>
      </div>

      <!-- Lower Deck: Unified Tabbed Inspector (Hex & Activity Console) -->
      <div class="deck-panel">
        <div class="deck-nav">
          <div class="deck-tabs">
            <button
              class=${`deck-tab-btn ${currentDeck === 'hex' ? 'active' : ''}`}
              onClick=${() => {
                deckTab.value = 'hex';
              }}
            >
              Hex Inspector
            </button>
            <button
              class=${`deck-tab-btn ${currentDeck === 'console' ? 'active' : ''}`}
              onClick=${() => {
                deckTab.value = 'console';
              }}
            >
              Activity Console (${allLogs.length})
            </button>
          </div>

          <!-- Tab-specific toolbar actions -->
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            ${currentDeck === 'hex' && html`
              <div style="display: flex; gap: 0.3rem;">
                <button
                  class=${`btn ${currentHexSrc === 'tag' ? 'btn-primary' : 'btn-ghost'}`}
                  style="padding: 0.2rem 0.6rem; font-size: 0.74rem;"
                  onClick=${() => {
                    hexSource.value = 'tag';
                  }}
                >
                  Hardware Tag (${currentActive.raw ? '540B' : 'Empty'})
                </button>
                <button
                  class=${`btn ${currentHexSrc === 'staged' ? 'btn-primary' : 'btn-ghost'}`}
                  style="padding: 0.2rem 0.6rem; font-size: 0.74rem;"
                  onClick=${() => {
                    hexSource.value = 'staged';
                  }}
                >
                  Staged Dump (${currentStaged.raw ? '540B' : 'Empty'})
                </button>
              </div>
            `}

            ${currentDeck === 'console' && html`
              <div style="display: flex; gap: 0.3rem; align-items: center;">
                <button
                  class=${`btn ${currentLogFilter === 'all' ? 'btn-primary' : 'btn-ghost'}`}
                  style="padding: 0.2rem 0.55rem; font-size: 0.72rem;"
                  onClick=${() => {
                    logFilter.value = 'all';
                  }}
                >
                  All
                </button>
                <button
                  class=${`btn ${currentLogFilter === 'nfc' ? 'btn-primary' : 'btn-ghost'}`}
                  style="padding: 0.2rem 0.55rem; font-size: 0.72rem;"
                  onClick=${() => {
                    logFilter.value = 'nfc';
                  }}
                >
                  NFC
                </button>
                <button
                  class=${`btn ${currentLogFilter === 'write' ? 'btn-primary' : 'btn-ghost'}`}
                  style="padding: 0.2rem 0.55rem; font-size: 0.72rem;"
                  onClick=${() => {
                    logFilter.value = 'write';
                  }}
                >
                  Writes
                </button>
                <button
                  class="btn"
                  style="padding: 0.2rem 0.6rem; font-size: 0.74rem;"
                  onClick=${handleCopyLog}
                >
                  ${currentCopied ? '✓ Copied' : '📋 Copy'}
                </button>
                <button
                  class="btn btn-ghost"
                  style="padding: 0.2rem 0.4rem; font-size: 0.74rem;"
                  onClick=${() => {
                    logs.value = [];
                  }}
                >
                  Clear
                </button>
              </div>
            `}
          </div>
        </div>

        <div class="deck-content">
          ${currentDeck === 'hex' && html`
            <div>
              <div class="sector-ribbon">
                <span class="sector-chip sec-uid" title="Pages 0x00-0x03: Serial number UID, BCC, internal lock">
                  [0x00–0x03] UID & Lock
                </span>
                <span class="sector-chip sec-crypto" title="Pages 0x04-0x14: Character ID, Model Info, HMAC">
                  [0x04–0x14] Crypto & Model
                </span>
                <span class="sector-chip sec-data" title="Pages 0x15-0x51: User save data area">
                  [0x15–0x51] User Save Data
                </span>
                <span class="sector-chip sec-cfg" title="Pages 0x52-0x86: Dynamic lock bits, CFG, PWD, PACK">
                  [0x52–0x86] CFG, PWD & PACK
                </span>
              </div>
              <div class="hex-box">
                ${currentHexSrc === 'tag'
                  ? currentActive.raw
                    ? formatHexDump(currentActive.raw)
                    : '// Place a tag on the portal hardware to view raw hex bytes'
                  : currentStaged.raw
                  ? formatHexDump(currentStaged.raw)
                  : '// Stage a 540-byte .bin dump file to view raw hex bytes'}
              </div>
            </div>
          `}

          ${currentDeck === 'console' && html`
            <div class="console-box">
              ${filteredLogs.map(
                (l) => html`
                  <div key=${l.id} class="log-line">
                    <span class="log-timestamp">${l.time}</span>
                    <span class=${`log-badge log-badge-${l.category}`}>${l.category}</span>
                    <span class="log-msg">${l.text}</span>
                  </div>
                `
              )}
            </div>
          `}
        </div>
      </div>

      <!-- Confirmation / Analysis Modal -->
      ${currentModal.open && html`
        <div class="modal-overlay" onClick=${() => {
          modal.value = { ...modal.value, open: false };
        }}>
          <div class="modal-card" onClick=${(e) => e.stopPropagation()}>
            <div class="modal-header">
              <span class="modal-title">${currentModal.title}</span>
              <button
                class="btn btn-ghost"
                style="padding: 0.2rem 0.4rem; font-size: 0.9rem;"
                onClick=${() => {
                  modal.value = { ...modal.value, open: false };
                }}
              >
                ✕
              </button>
            </div>

            <div class="modal-body">
              ${currentModal.type === 'analysis'
                ? html`
                    <div style="display: flex; gap: 1.15rem; align-items: center; margin-bottom: 0.85rem;">
                      <div class="tag-figure-box" style="width: 85px; height: 110px;">
                        ${currentStaged.metadata?.imageUrl
                          ? html`<img src=${currentStaged.metadata.imageUrl} alt="Artwork" />`
                          : html`<div class="tag-figure-placeholder">💾</div>`}
                      </div>
                      <div style="flex: 1;">
                        <div style="font-size: 1.15rem; font-weight: 700; color: var(--text-heading);">
                          ${currentStaged.metadata?.name || 'Amiibo Dump'}
                        </div>
                        <div style="font-size: 0.78rem; color: var(--cyan); margin-bottom: 0.4rem;">
                          ${currentStaged.parsed?.modelInfo?.seriesName}
                        </div>
                        <div style="font-family: var(--font-mono); font-size: 0.74rem; color: var(--text-muted);">
                          UID: ${currentStaged.parsed?.uidFormatted}
                        </div>
                        <div style="font-family: var(--font-mono); font-size: 0.74rem; color: var(--text-muted);">
                          ID: ${currentStaged.parsed?.modelInfo?.idHex}
                        </div>
                      </div>
                    </div>

                    <div class="modal-callout">
                      <div><strong>Flashing to Power Tag (PUC):</strong></div>
                      <div style="color: var(--text-muted);">
                        This will unlock the tag and rewrite all 135 pages with dual-pass verification.
                      </div>
                    </div>
                  `
                : html`
                    <div class="modal-callout">
                      <div>${currentModal.message}</div>
                    </div>
                  `}
            </div>

            <div class="modal-actions">
              <button class="btn btn-ghost" onClick=${() => {
                modal.value = { ...modal.value, open: false };
              }}>
                Cancel
              </button>
              <button class="btn btn-flash" onClick=${() => executeWrite(currentModal.mode)}>
                ${currentModal.mode === 'userdata' ? 'Restore Save Data' : 'Flash Tag Now'}
              </button>
            </div>
          </div>
        </div>
      `}

      <!-- Footer: Attributions Only -->
      <footer>
        <div class="footer-credits">
          <div>
            Reverse engineering: <a href="https://github.com/malc0mn/amiigo" target="_blank" rel="noopener noreferrer">malc0mn/amiigo</a>
          </div>
          <div>
            WebHID Portal: <a href="https://github.com/pathawks/amiigo-web" target="_blank" rel="noopener noreferrer">pathawks/amiigo-web</a>
          </div>
          <div>
            Database: <a href="https://github.com/N3evin/AmiiboAPI" target="_blank" rel="noopener noreferrer">AmiiboAPI</a>
          </div>
        </div>
        <div style="font-size: 0.72rem; color: var(--text-dim); margin-top: 0.2rem;">
          PowerSaves is a trademark of Datel Ltd. Amiibo is a trademark of Nintendo. For personal backup and rewritable Power Tag management.
        </div>
      </footer>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
