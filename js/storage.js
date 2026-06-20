// storage.js — localStorage persistence, schema v1, export/import.
// localStorage is always the source of truth; sync.js mirrors it remotely.

const KEY = 'rhythmTrainer.v1';

const DEFAULT_STATE = {
  schemaVersion: 1,
  lastModified: 0,
  settings: {
    inputOffset: 0, // ms; subtracted from tap times (positive = you tap late)
    gasUrl: '',
    gasSecret: '',
    anchorTapCount: 8,
    lastBlindMode: 'off',
    lastCalibration: null, // { offset, stdDev, date }
    videoOverrides: {}, // songId -> replacement videoId
    startOverrides: {}, // songId -> start time in seconds (skip intro)
    getSongBpmKey: '', // getsongbpm.com API key (BPM lookup)
    youtubeApiKey: '', // YouTube Data API v3 key (video search)
    polyrhythm: false, // experimental: accept triplet-grid taps too
  },
  customSongs: [],
  sessions: [],
};

let state = null;
let storageWarning = null;
const listeners = new Set();

function deepMergeDefaults(target, defaults) {
  const out = { ...defaults, ...target };
  out.settings = { ...defaults.settings, ...(target.settings || {}) };
  out.customSongs = Array.isArray(target.customSongs) ? target.customSongs : [];
  out.sessions = Array.isArray(target.sessions) ? target.sessions : [];
  return out;
}

export function load() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schemaVersion === 1) {
        state = deepMergeDefaults(parsed, DEFAULT_STATE);
        return state;
      }
    }
  } catch (e) {
    console.warn('storage: failed to load, starting fresh', e);
  }
  state = structuredClone(DEFAULT_STATE);
  return state;
}

export function getData() {
  return load();
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    storageWarning = null;
  } catch (e) {
    storageWarning = 'Could not save to localStorage (quota?). Recent data may be lost on reload.';
    console.error('storage: save failed', e);
  }
  for (const fn of listeners) fn(state);
}

// All mutations go through here so lastModified and sync stay correct.
export function update(mutator) {
  load();
  mutator(state);
  state.lastModified = Date.now();
  persist();
  return state;
}

// Replace wholesale (import / remote pull). Skips lastModified bump when the
// incoming blob already carries its own.
export function replace(newState) {
  state = deepMergeDefaults(newState, DEFAULT_STATE);
  persist();
  return state;
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getStorageWarning() {
  return storageWarning;
}

export function exportJSON() {
  return JSON.stringify(load(), null, 2);
}

// Validates an imported blob; throws with a readable message on bad input.
export function validateImport(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a JSON object.');
  if (parsed.schemaVersion !== 1) throw new Error(`Unsupported schemaVersion: ${parsed.schemaVersion}`);
  if (parsed.sessions && !Array.isArray(parsed.sessions)) throw new Error('"sessions" must be an array.');
  if (parsed.customSongs && !Array.isArray(parsed.customSongs)) throw new Error('"customSongs" must be an array.');
  return parsed;
}

export function importJSON(text) {
  const parsed = validateImport(text);
  return replace(parsed);
}

export function addSession(session) {
  return update((s) => {
    s.sessions.push(session);
  });
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
