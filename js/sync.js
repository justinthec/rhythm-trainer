// sync.js — Google Apps Script backend client.
// Requests are sent as Content-Type: text/plain so the browser treats them as
// "simple" requests and skips the CORS preflight (which GAS cannot answer).
// The GAS web app 302-redirects to googleusercontent.com; fetch follows it.

import { getData, replace, onChange, DEFAULT_GAS_URL } from './storage.js';

let pushTimer = null;
let status = { state: 'idle', message: 'Sync not configured', at: null };
const statusListeners = new Set();

function setStatus(state, message) {
  status = { state, message, at: Date.now() };
  for (const fn of statusListeners) fn(status);
}

export function getSyncStatus() {
  return status;
}

export function onSyncStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function config() {
  const { gasUrl, gasSecret } = getData().settings;
  const url = (gasUrl || DEFAULT_GAS_URL || '').trim();
  return url && gasSecret ? { gasUrl: url, gasSecret } : null;
}

async function call(action, payload = {}) {
  const cfg = config();
  if (!cfg) throw new Error('Sync not configured');
  const res = await fetch(cfg.gasUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, secret: cfg.gasSecret, ...payload }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Server error');
  return json;
}

export async function testConnection() {
  const r = await call('ping');
  setStatus('ok', 'Connected');
  return r;
}

// On app load: adopt remote state if it is newer than local.
export async function pullOnLoad() {
  if (!config()) return;
  try {
    setStatus('syncing', 'Pulling…');
    const r = await call('pull');
    const local = getData();
    if (r.state && (r.state.lastModified || 0) > (local.lastModified || 0)) {
      replace(r.state);
      setStatus('ok', 'Restored newer data from remote');
    } else {
      setStatus('ok', 'Local data is up to date');
    }
  } catch (e) {
    setStatus('error', `Pull failed: ${e.message}`);
  }
}

async function pushNow() {
  if (!config()) return;
  try {
    setStatus('syncing', 'Pushing…');
    const local = getData();
    const r = await call('push', { state: local });
    if (r.stale && r.state) {
      // Remote was newer (edited elsewhere) — last-write-wins says adopt it.
      replace(r.state);
      setStatus('ok', 'Remote was newer; adopted remote data');
    } else {
      setStatus('ok', `Synced ${new Date().toLocaleTimeString()}`);
    }
  } catch (e) {
    setStatus('error', `Push failed: ${e.message}`);
  }
}

export function schedulePush() {
  if (!config()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 3000);
}

let started = false;
export function startSync() {
  if (started) return;
  started = true;
  // Any local mutation schedules a debounced push. replace() during a pull
  // also fires onChange, but pushing identical state back is harmless.
  onChange(() => schedulePush());
  pullOnLoad();
}
