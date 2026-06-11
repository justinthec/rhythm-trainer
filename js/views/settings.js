// Settings: input offset + calibration mini-game, sync config, export/import.

import { getData, update, exportJSON, importJSON, getStorageWarning } from '../storage.js';
import { testConnection, pullOnLoad, getSyncStatus, onSyncStatus } from '../sync.js';
import { createCalibration } from '../calibration.js';

let calib = null;
let calibKeyHandler = null;
let unsubStatus = null;

export function render(el) {
  const s = getData().settings;
  const warn = getStorageWarning();

  el.innerHTML = `
    <h1>Settings</h1>
    ${warn ? `<p class="form-error">${warn}</p>` : ''}

    <h2>Timing</h2>
    <div class="form-grid">
      <label>Input offset (ms) — positive if you tap late
        <input id="inputOffset" type="number" step="1" value="${s.inputOffset}">
      </label>
      <label>Anchor taps to lock in
        <input id="anchorTapCount" type="number" min="4" max="16" step="1" value="${s.anchorTapCount}">
      </label>
    </div>
    <div class="calib-box">
      <p>Not sure of your offset? Run the calibration: tap <strong>Spacebar</strong> along with 24 metronome clicks and we'll measure your average lag (hardware + reflex).</p>
      ${s.lastCalibration ? `<p class="hint">Last calibration: ${s.lastCalibration.offset}ms ± ${s.lastCalibration.stdDev}ms on ${new Date(s.lastCalibration.date).toLocaleDateString()}</p>` : ''}
      <button id="calibBtn" class="btn primary">🎯 Start calibration</button>
      <div id="calibStatus" class="hint"></div>
      <div id="calibResult"></div>
    </div>

    <h2>Cloud sync (Google Sheets)</h2>
    <p class="hint">Free, no account system: your data syncs to your own Google Sheet via Apps Script. <a href="docs/GAS-SETUP.md" target="_blank">Setup guide</a> (5 minutes, one time).</p>
    <div class="form-grid">
      <label>Apps Script Web App URL
        <input id="gasUrl" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(s.gasUrl)}">
      </label>
      <label>Shared secret
        <input id="gasSecret" type="password" placeholder="same SECRET as in Code.gs" value="${esc(s.gasSecret)}">
      </label>
      <div>
        <button id="testBtn" class="btn">Test connection</button>
        <button id="pullBtn" class="btn">Pull now</button>
      </div>
      <div id="syncStatus" class="hint"></div>
    </div>

    <h2>Data</h2>
    <div class="form-grid">
      <div>
        <button id="exportBtn" class="btn">⬇ Export JSON</button>
        <button id="importBtn" class="btn">⬆ Import JSON</button>
        <input id="importFile" type="file" accept="application/json" class="hidden">
      </div>
      <div id="dataStatus" class="hint"></div>
    </div>
  `;

  // Persist timing fields on change.
  el.querySelector('#inputOffset').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v)) update((d) => (d.settings.inputOffset = v));
  });
  el.querySelector('#anchorTapCount').addEventListener('change', (e) => {
    const v = Math.max(4, Math.min(16, parseInt(e.target.value, 10) || 8));
    e.target.value = v;
    update((d) => (d.settings.anchorTapCount = v));
  });

  // Sync fields.
  el.querySelector('#gasUrl').addEventListener('change', (e) => update((d) => (d.settings.gasUrl = e.target.value.trim())));
  el.querySelector('#gasSecret').addEventListener('change', (e) => update((d) => (d.settings.gasSecret = e.target.value.trim())));

  const syncStatusEl = el.querySelector('#syncStatus');
  const renderStatus = (st) => {
    syncStatusEl.textContent = st.message;
    syncStatusEl.className = `hint sync-${st.state}`;
  };
  renderStatus(getSyncStatus());
  unsubStatus = onSyncStatus(renderStatus);

  el.querySelector('#testBtn').addEventListener('click', async () => {
    syncStatusEl.textContent = 'Testing…';
    try {
      await testConnection();
    } catch (e2) {
      syncStatusEl.textContent = `Connection failed: ${e2.message}`;
    }
  });
  el.querySelector('#pullBtn').addEventListener('click', () => pullOnLoad().then(() => render(el)));

  // Export / import.
  el.querySelector('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rhythm-trainer-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  el.querySelector('#importBtn').addEventListener('click', () => el.querySelector('#importFile').click());
  el.querySelector('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = el.querySelector('#dataStatus');
    try {
      const text = await file.text();
      if (!confirm('Replace ALL current data with this file?')) return;
      importJSON(text);
      status.textContent = 'Imported successfully.';
      render(el);
    } catch (err) {
      status.textContent = `Import failed: ${err.message}`;
    }
  });

  // Calibration.
  el.querySelector('#calibBtn').addEventListener('click', () => startCalibration(el));
}

export function leave() {
  if (calib) calib.cancel();
  calib = null;
  if (calibKeyHandler) window.removeEventListener('keydown', calibKeyHandler);
  calibKeyHandler = null;
  if (unsubStatus) unsubStatus();
  unsubStatus = null;
}

function startCalibration(el) {
  if (calib) calib.cancel();
  const statusEl = el.querySelector('#calibStatus');
  const resultEl = el.querySelector('#calibResult');
  resultEl.innerHTML = '';
  statusEl.textContent = 'Listen for the clicks and tap Spacebar with each one…';

  calib = createCalibration({
    onProgress: ({ click, total }) => {
      statusEl.textContent = `Click ${click}/${total} — tap with every click (first ${4} are warm-up)`;
    },
    onFinish: (res) => {
      calib = null;
      window.removeEventListener('keydown', calibKeyHandler);
      calibKeyHandler = null;
      if (!res.ok) {
        statusEl.textContent = `Not enough clean taps (${res.validTaps}/${res.needed}). Try again and tap with every click.`;
        return;
      }
      statusEl.textContent = '';
      resultEl.innerHTML = `
        <p>Measured offset: <strong>${res.offset}ms ± ${res.stdDev}ms</strong> over ${res.validTaps} taps.</p>
        <button id="applyCalib" class="btn primary">Apply ${res.offset}ms as input offset</button>
      `;
      resultEl.querySelector('#applyCalib').addEventListener('click', () => {
        update((d) => {
          d.settings.inputOffset = res.offset;
          d.settings.lastCalibration = { offset: res.offset, stdDev: res.stdDev, date: Date.now() };
        });
        render(el);
      });
    },
  });

  calibKeyHandler = (e) => {
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      const ts = !e.timeStamp || e.timeStamp > 1e12 ? performance.now() : e.timeStamp;
      if (calib) calib.tap(ts);
    }
  };
  window.addEventListener('keydown', calibKeyHandler);
  calib.start();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
