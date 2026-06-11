/**
 * Rhythm Trainer — Google Apps Script backend.
 * Paste this into a new Apps Script project bound to a Google Sheet,
 * set SECRET below, then deploy as a Web App (Execute as: Me,
 * Who has access: Anyone). See docs/GAS-SETUP.md in the repo.
 *
 * Storage layout:
 *  - "state" tab:    A1 = lastModified, B1..Bn = JSON blob chunks (<=45k chars each)
 *  - "sessions" tab: human-readable append-only log, one row per session
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
    } else if (req.action === 'push') {
      out = handlePush(req.state);
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

function handlePush(state) {
  if (!state || typeof state !== 'object') return { ok: false, error: 'No state' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var remote = readState();
    var remoteLM = remote && remote.lastModified ? remote.lastModified : 0;
    var localLM = state.lastModified || 0;
    if (remoteLM > localLM) {
      // Client is stale — hand back the newer remote state instead.
      return { ok: true, stale: true, state: remote };
    }
    writeState(state);
    appendNewSessions(remote, state);
    return { ok: true, stale: false };
  } finally {
    lock.releaseLock();
  }
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
      'meanDelta', 'stdDev', 'driftSlope', 'taps', 'blindAccuracy', 'blindStreak',
    ]);
  }
  var known = {};
  ((oldState && oldState.sessions) || []).forEach(function (s) {
    known[s.id] = true;
  });
  ((newState && newState.sessions) || []).forEach(function (s) {
    if (known[s.id]) return;
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
      s.blind ? s.blind.accuracy : '',
      s.blind ? s.blind.longestStreak : '',
    ]);
  });
}
