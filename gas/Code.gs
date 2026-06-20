/**
 * Rhythm Trainer — Google Apps Script backend.
 * Paste this into a new Apps Script project bound to a Google Sheet,
 * set SECRET below, then deploy as a Web App (Execute as: Me,
 * Who has access: Anyone). See docs/GAS-SETUP.md in the repo.
 *
 * Storage layout:
 *  - "state" tab:    A1 = lastModified, B1..Bn = JSON blob chunks (<=45k chars
 *                    each). This is the COMPLETE backup — the whole app state
 *                    (settings, custom songs, every session) round-trips here,
 *                    so any new field is captured automatically.
 *  - "sessions" tab: human-readable append-only log, one row per session.
 *  - "songs" tab:    human-readable snapshot of custom songs (rewritten each push).
 *  - "settings" tab: human-readable snapshot of preferences/offsets (rewritten
 *                    each push; secrets/API keys are kept out of this view but
 *                    still live in the state blob).
 */

var SECRET = 'CHANGE-ME-to-a-long-random-string';

var CHUNK = 45000; // stay under the 50k cell character limit

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.secret !== SECRET) {
      out = { ok: false, error: 'Bad secret' };
    } else if (req.action === 'ping') {
      out = { ok: true, pong: true };
    } else if (req.action === 'pull') {
      out = { ok: true, state: readState() };
    } else if (req.action === 'sync') {
      out = handleSync(req.state);
    } else if (req.action === 'push') {
      out = handlePush(req.state, req.force);
    } else {
      out = { ok: false, error: 'Unknown action: ' + req.action };
    }
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function sheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function readState() {
  var sh = sheet('state');
  var lastRow = sh.getRange(1, 1).getValue();
  if (!lastRow) return null;
  var values = sh.getRange(1, 2, 1, Math.max(1, sh.getLastColumn() - 1)).getValues()[0];
  var json = values.join('');
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}

// Merge the incoming device state with the stored cloud state and persist the
// union (atomic under a script lock). Returns the merged state for the client
// to adopt, so both sides converge without losing history.
function handleSync(incoming) {
  if (!incoming || typeof incoming !== 'object') return { ok: false, error: 'No state' };
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var stored = readState();
    var merged = stored ? mergeStates(stored, incoming) : incoming;
    writeState(merged);
    appendNewSessions(stored, merged);
    writeSongs(merged);
    writeSettings(merged);
    return { ok: true, state: merged };
  } finally {
    lock.releaseLock();
  }
}

// Overwrite the cloud with the incoming state. With force=true this replaces
// unconditionally (used by "Push" to propagate deletions). Without force it
// keeps the old last-write-wins guard.
function handlePush(state, force) {
  if (!state || typeof state !== 'object') return { ok: false, error: 'No state' };
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var remote = readState();
    if (!force) {
      var remoteLM = remote && remote.lastModified ? remote.lastModified : 0;
      if (remoteLM > (state.lastModified || 0)) return { ok: true, stale: true, state: remote };
    }
    writeState(state);
    appendNewSessions(remote, state);
    writeSongs(state);
    writeSettings(state);
    return { ok: true, stale: false };
  } finally {
    lock.releaseLock();
  }
}

// --- merge ---------------------------------------------------------------

function mergeStates(a, b) {
  // a = stored (cloud), b = incoming (this device).
  var deleted = {};
  (a.deletedIds || []).forEach(function (id) { deleted[id] = true; });
  (b.deletedIds || []).forEach(function (id) { deleted[id] = true; });
  return {
    schemaVersion: 1,
    lastModified: Math.max(a.lastModified || 0, b.lastModified || 0),
    deletedIds: keys(deleted),
    sessions: unionById(a.sessions, b.sessions, deleted),
    customSongs: unionById(a.customSongs, b.customSongs, deleted),
    settings: mergeSettings(a, b),
  };
}

// Union two lists keyed by id; incoming (second) wins on collision; drop
// anything tombstoned; sort by date/createdAt.
function unionById(listA, listB, deleted) {
  var byId = {};
  (listA || []).forEach(function (x) { if (x && x.id) byId[x.id] = x; });
  (listB || []).forEach(function (x) { if (x && x.id) byId[x.id] = x; });
  var out = [];
  keys(byId).forEach(function (id) { if (!deleted[id]) out.push(byId[id]); });
  out.sort(function (x, y) { return (x.date || x.createdAt || 0) - (y.date || y.createdAt || 0); });
  return out;
}

// Newer side wins per field; never let an empty credential clobber a set one;
// override maps are unioned.
function mergeSettings(a, b) {
  var aNewer = (a.lastModified || 0) >= (b.lastModified || 0);
  var older = (aNewer ? b.settings : a.settings) || {};
  var newer = (aNewer ? a.settings : b.settings) || {};
  var out = {};
  var k;
  for (k in older) out[k] = older[k];
  for (k in newer) out[k] = newer[k];
  ['gasSecret', 'getSongBpmKey', 'youtubeApiKey', 'gasUrl'].forEach(function (key) {
    if (!out[key]) out[key] = newer[key] || older[key] || '';
  });
  ['videoOverrides', 'startOverrides'].forEach(function (key) {
    var m = {}, src, i;
    src = (a.settings && a.settings[key]) || {};
    for (i in src) m[i] = src[i];
    src = (b.settings && b.settings[key]) || {};
    for (i in src) m[i] = src[i];
    out[key] = m;
  });
  return out;
}

function keys(obj) {
  var out = [];
  for (var k in obj) if (obj.hasOwnProperty(k)) out.push(k);
  return out;
}

function writeState(state) {
  var sh = sheet('state');
  var json = JSON.stringify(state);
  var chunks = [];
  for (var i = 0; i < json.length; i += CHUNK) chunks.push(json.substring(i, i + CHUNK));
  sh.clearContents();
  sh.getRange(1, 1).setValue(state.lastModified || Date.now());
  sh.getRange(1, 2, 1, chunks.length).setValues([chunks]);
}

// Append sessions that the remote copy hadn't seen yet to the readable log.
function appendNewSessions(oldState, newState) {
  var sh = sheet('sessions');
  if (sh.getLastRow() === 0) {
    sh.appendRow([
      'date', 'song', 'bpm', 'blindMode', 'grade', 'accuracy', 'score',
      'meanDelta', 'stdDev', 'driftSlope', 'taps',
      'perfect', 'good', 'okay', 'miss', 'extra',
      'blindAccuracy', 'blindStreak', 'beatsSurvived',
    ]);
  }
  var known = {};
  ((oldState && oldState.sessions) || []).forEach(function (s) {
    known[s.id] = true;
  });
  ((newState && newState.sessions) || []).forEach(function (s) {
    if (known[s.id]) return;
    var c = s.counts || {};
    var b = s.blind || null;
    sh.appendRow([
      new Date(s.date).toISOString(),
      s.songId,
      s.bpm,
      s.blindMode || 'off',
      s.grade,
      s.accuracy,
      s.score,
      s.meanDelta,
      s.stdDev,
      s.driftSlope,
      s.tapCount,
      c.perfect != null ? c.perfect : '',
      c.good != null ? c.good : '',
      c.okay != null ? c.okay : '',
      c.miss != null ? c.miss : '',
      c.extra != null ? c.extra : '',
      b ? b.accuracy : '',
      b ? b.longestStreak : '',
      b && b.beatsSurvived != null ? b.beatsSurvived : '',
    ]);
  });
}

// Readable snapshot of custom songs (rewritten in full each push).
function writeSongs(state) {
  var sh = sheet('songs');
  sh.clearContents();
  var rows = [['id', 'title', 'artist', 'bpm', 'startSec', 'videoId', 'created']];
  ((state && state.customSongs) || []).forEach(function (s) {
    rows.push([
      s.id,
      s.title,
      s.artist,
      s.bpm,
      s.startSec || 0,
      s.videoId,
      s.createdAt ? new Date(s.createdAt).toISOString() : '',
    ]);
  });
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
}

// Readable snapshot of preferences/offsets (rewritten each push). Secrets and
// API keys are intentionally omitted here — they remain in the state blob.
function writeSettings(state) {
  var sh = sheet('settings');
  sh.clearContents();
  var s = (state && state.settings) || {};
  var cal = s.lastCalibration;
  var rows = [
    ['setting', 'value'],
    ['inputOffset (ms)', s.inputOffset != null ? s.inputOffset : ''],
    ['anchorTapCount', s.anchorTapCount != null ? s.anchorTapCount : ''],
    ['lastBlindMode', s.lastBlindMode || 'off'],
    ['polyrhythm', s.polyrhythm ? 'on' : 'off'],
    ['clapSensitivity', s.clapSensitivity != null ? s.clapSensitivity : ''],
    ['lastCalibration', cal ? cal.offset + 'ms +/-' + cal.stdDev + 'ms on ' + new Date(cal.date).toISOString().slice(0, 10) : ''],
    ['customSongs', ((state && state.customSongs) || []).length],
    ['sessions', ((state && state.sessions) || []).length],
    ['videoOverrides', Object.keys(s.videoOverrides || {}).length],
    ['startOverrides', Object.keys(s.startOverrides || {}).length],
    ['lastModified', state && state.lastModified ? new Date(state.lastModified).toISOString() : ''],
  ];
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
}
