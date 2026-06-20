// sync.js — Google Apps Script backend client.
// Requests are sent as Content-Type: text/plain so the browser treats them as
// "simple" requests and skips the CORS preflight (which GAS cannot answer).
// The GAS web app 302-redirects to googleusercontent.com; fetch follows it.
//
// Three operations:
//   • syncMerge  — server unions this device's data with the cloud (honoring
//                  tombstones) and returns the combined state. Safe both ways.
//   • pushReplace— overwrite the cloud with this device's data (propagates deletes).
//   • pullReplace— overwrite this device with the cloud's data.
// Auto-sync (optional) runs syncMerge, debounced, after each local change.

import { getData, replace, onChange, DEFAULT_GAS_URL } from './storage.js';

const TIMEOUT_MS = 20000;
const RETRIES = 2;

let pushTimer = null;
let inFlight = false;
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

function autoSyncOn() {
  return getData().settings.autoSync !== false;
}

// POST with a timeout and a couple of retries on transient failures. GAS cold
// starts and flaky networks are the common cause of the old "failed to upload".
async function call(action, payload = {}, attempt = 0) {
  const cfg = config();
  if (!cfg) throw new Error('Sync not configured — add the secret in Settings.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(cfg.gasUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, secret: cfg.gasSecret, ...payload }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Unexpected response — is the Web app deployed to "Anyone" and the URL the /exec one?');
    }
    if (!json.ok) throw new Error(json.error || 'Server error');
    return json;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const retriable = e.name === 'AbortError' || /Failed to fetch|HTTP 5\d\d|network/i.test(msg);
    if (attempt < RETRIES && retriable) {
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      return call(action, payload, attempt + 1);
    }
    throw e.name === 'AbortError' ? new Error('Timed out — check your connection and the deployment') : e;
  } finally {
    clearTimeout(timer);
  }
}

export async function testConnection() {
  const r = await call('ping');
  setStatus('ok', 'Connected');
  return r;
}

// Merge with the cloud and adopt the combined result. Nothing is lost.
export async function syncMerge() {
  if (!config()) {
    setStatus('idle', 'Sync not configured');
    return;
  }
  if (inFlight) return;
  inFlight = true;
  try {
    setStatus('syncing', 'Syncing…');
    const r = await call('sync', { state: getData() });
    if (r.state) replace(r.state); // schedulePush is suppressed while inFlight
    setStatus('ok', `Synced ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setStatus('error', `Sync failed: ${e.message}`);
    throw e;
  } finally {
    inFlight = false;
  }
}

// Make the cloud exactly match this device (propagates deletions).
export async function pushReplace() {
  if (!config()) {
    setStatus('idle', 'Sync not configured');
    return;
  }
  if (inFlight) return;
  inFlight = true;
  try {
    setStatus('syncing', 'Pushing…');
    await call('push', { state: getData(), force: true });
    setStatus('ok', `Pushed to cloud ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setStatus('error', `Push failed: ${e.message}`);
    throw e;
  } finally {
    inFlight = false;
  }
}

// Make this device exactly match the cloud (discards unsynced local changes).
export async function pullReplace() {
  if (!config()) {
    setStatus('idle', 'Sync not configured');
    return;
  }
  if (inFlight) return;
  inFlight = true;
  try {
    setStatus('syncing', 'Pulling…');
    const r = await call('pull');
    if (r.state) replace(r.state);
    setStatus('ok', 'Pulled from cloud');
  } catch (e) {
    setStatus('error', `Pull failed: ${e.message}`);
    throw e;
  } finally {
    inFlight = false;
  }
}

export function schedulePush() {
  if (!config() || !autoSyncOn() || inFlight) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncMerge().catch(() => {}), 3000);
}

let started = false;
export function startSync() {
  if (started) return;
  started = true;
  // Any local mutation schedules a debounced merge-sync (when auto-sync is on).
  // The replace() inside a sync also fires onChange, but schedulePush ignores it
  // while a sync is in flight, so there's no feedback loop.
  onChange(() => schedulePush());
  if (config() && autoSyncOn()) syncMerge().catch(() => {});
}
