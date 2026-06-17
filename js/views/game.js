// Game view: video playback, tap capture, live feedback, Flying Blind mode.

import { findSong } from '../songs.js';
import { getData, update, addSession, newId } from '../storage.js';
import { createEngine } from '../engine.js';
import { createVideoClock, PlayerState } from '../youtube.js';
import { drawHistogram, drawAccuracyTimeline } from '../charts.js';

const BLIND_MODES = {
  off:      { label: 'Off',      desc: 'Full audio the whole song.' },
  intervals:{ label: 'Intervals', audible: 16, blind: [8],           desc: '4 bars of music, then 2 bars muted. Repeat.' },
  hard:     { label: 'Hard',     audible: 16, blind: [16],           desc: '4 bars of music, then 4 bars muted. Repeat.' },
  survival: { label: 'Survival', audible: 16, blind: [8, 16, 32, 64], survivable: true, showBlindFeedback: true,
              desc: 'Growing blind windows — timing feedback visible, 3 misses in a row ends the run.' },
  extreme:  { label: 'Extreme',  audible: 16, blind: [8, 16, 32, 64], survivable: true, showBlindFeedback: false,
              desc: 'Same as Survival but zero feedback while blind — truly flying blind.' },
};
const BAR = 4; // beats per bar (grid bars, not necessarily musical downbeats)
const BLIND_GRACE_TAPS = 8; // scored taps before the first blind window

// --- module state (torn down in leave()) ---
let root = null;
let song = null;
let clock = null;
let engine = null;
let rafId = null;
let focusWatchdog = null;
let keyHandler = null;
let phase = 'start'; // start | loading | anchoring | tracking | results | error
let blind = null;
let blindWindowEndDeltas = [];
let totalBlindBeatsDone = 0;
let lastTapVid = null;
let autotap = null; // { nextPerf } debug
let debugOverlayOn = false;
let toastTimer = null;
let lastPulseBeat = null;

function settings() {
  return getData().settings;
}

function effectiveVideoId() {
  return settings().videoOverrides?.[song.id] || song.videoId;
}

export function render(el, params) {
  leave();
  root = el;
  song = findSong(decodeURIComponent(params.songId || ''), getData().customSongs);
  if (!song) {
    el.innerHTML = `<p>Song not found. <a href="#/select">Back to songs</a></p>`;
    return;
  }
  renderStartPanel();

  keyHandler = (e) => onKey(e);
  window.addEventListener('keydown', keyHandler);
}

export function leave() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  clearInterval(focusWatchdog);
  focusWatchdog = null;
  clearTimeout(toastTimer);
  if (keyHandler) window.removeEventListener('keydown', keyHandler);
  keyHandler = null;
  if (clock) clock.destroy();
  clock = null;
  engine = null;
  blind = null;
  autotap = null;
  phase = 'start';
}

// ---------- panels ----------

function renderStartPanel() {
  phase = 'start';
  const last = settings().lastBlindMode || 'off';
  root.innerHTML = `
    <a class="back" href="#/select">← Songs</a>
    <div class="start-panel">
      <h1>${esc(song.title)}</h1>
      <p class="song-artist">${esc(song.artist)} · <strong>${song.bpm} BPM</strong></p>
      <h2>Flying Blind</h2>
      <div class="blind-picker" id="blindPicker">
        ${Object.entries(BLIND_MODES)
          .map(
            ([key, m]) => `
          <label class="blind-option ${key === last ? 'selected' : ''}">
            <input type="radio" name="blindMode" value="${key}" ${key === last ? 'checked' : ''}>
            <span class="blind-label">${m.label}</span>
            <span class="blind-desc">${m.desc}</span>
          </label>`
          )
          .join('')}
      </div>
      <button id="startBtn" class="btn primary big">▶ Start</button>
      <p class="hint">First, tap ${settings().anchorTapCount} steady beats to lock the grid to the song. Then keep tapping — every tap is scored.</p>
    </div>
  `;
  root.querySelectorAll('input[name=blindMode]').forEach((r) =>
    r.addEventListener('change', () => {
      root.querySelectorAll('.blind-option').forEach((o) => o.classList.toggle('selected', o.querySelector('input').checked));
    })
  );
  root.querySelector('#startBtn').addEventListener('click', () => {
    const mode = root.querySelector('input[name=blindMode]:checked').value;
    update((d) => {
      d.settings.lastBlindMode = mode;
    });
    startGame(mode);
  });
}

function renderPlayPanel() {
  root.innerHTML = `
    <div class="game-top">
      <a class="back" href="#/select">← Quit</a>
      <div class="game-song">${esc(song.title)} · ${song.bpm} BPM</div>
      <div class="game-buttons">
        <button id="reAnchorBtn" class="btn small" title="Redo the lock-in taps — score is kept">↻ Re-lock</button>
        <button id="pauseBtn" class="btn small">⏸</button>
        <button id="finishBtn" class="btn small">Finish</button>
      </div>
    </div>
    <div class="video-wrap" id="videoWrap">
      <div id="ytTarget"></div>
      <div class="click-shield" id="clickShield"></div>
      <div class="blind-overlay hidden" id="blindOverlay">
        <div class="blind-title">FLYING BLIND</div>
        <div class="blind-count" id="blindCount"></div>
        <div class="blind-strikes hidden" id="blindStrikes"></div>
        <div class="blind-blip" id="blindBlip"></div>
      </div>
      <div class="play-gate" id="playGate">
        <button class="play-btn" id="playBtn" disabled>Loading video…</button>
      </div>
      <div class="debug-overlay hidden" id="debugOverlay"></div>
    </div>
    <div class="hud">
      <div class="status-line" id="statusLine">Loading video…</div>
      <div class="feedback" id="feedback">&nbsp;</div>
      <div class="timing-bar" id="timingBar">
        <div class="tb-zone tb-okay"></div>
        <div class="tb-zone tb-good"></div>
        <div class="tb-zone tb-perfect"></div>
        <div class="tb-center"></div>
        <div class="tb-marker hidden" id="tbMarker"></div>
      </div>
      <div class="scoreboard">
        <div><span class="sb-label">Score</span><span id="sbScore">0</span></div>
        <div><span class="sb-label">Combo</span><span id="sbCombo">0</span></div>
        <div><span class="sb-label">Accuracy</span><span id="sbAcc">—</span></div>
        <div class="beat-pulse" id="beatPulse"></div>
      </div>
      <div class="toast hidden" id="toast"></div>
    </div>
    <div class="tap-pad" id="tapPad">
      <span class="tap-pad-label">TAP</span>
      <span class="tap-pad-sub">click here · Space · or F + J for fast subdivisions</span>
    </div>
  `;
  root.querySelector('#tapPad').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    doTap(normalizeStamp(e));
  });
  root.querySelector('#playBtn').addEventListener('click', () => {
    // Must start playback synchronously inside this user gesture — mobile
    // browsers reject playVideo() that fires later (e.g. from a resolved
    // promise), which is why we never autoplay.
    if (clock) clock.play();
  });
  root.querySelector('#reAnchorBtn').addEventListener('click', reAnchorNow);
  root.querySelector('#pauseBtn').addEventListener('click', togglePause);
  root.querySelector('#finishBtn').addEventListener('click', () => finishSession('finished'));
}

function renderErrorPanel(code) {
  phase = 'error';
  const blocked = code === 101 || code === 150;
  root.innerHTML = `
    <a class="back" href="#/select">← Songs</a>
    <div class="start-panel">
      <h1>${esc(song.title)}</h1>
      <p class="form-error">Video failed to load (${blocked ? 'embedding blocked by the uploader' : `error ${code}`}).</p>
      <p>Paste a different YouTube URL for this song (e.g. an audio-only or lyric upload):</p>
      <form id="overrideForm" class="form-grid">
        <input name="url" required placeholder="https://www.youtube.com/watch?v=…">
        <button class="btn primary" type="submit">Use this video</button>
        <span class="form-error" id="overrideError"></span>
      </form>
    </div>
  `;
  root.querySelector('#overrideForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { parseYouTubeId } = await import('../songs.js');
    const id = parseYouTubeId(new FormData(e.target).get('url'));
    if (!id) {
      root.querySelector('#overrideError').textContent = "Couldn't parse that URL.";
      return;
    }
    update((d) => {
      d.settings.videoOverrides = { ...(d.settings.videoOverrides || {}), [song.id]: id };
    });
    renderStartPanel();
  });
}

// ---------- game lifecycle ----------

function startGame(blindMode) {
  phase = 'loading';
  engine = createEngine({ bpm: song.bpm, anchorTapCount: settings().anchorTapCount });
  blind = {
    mode: blindMode,
    active: false,
    nextStart: null, // beat numbers in grid space
    windowEnd: null,
    windowIdx: 0,
    windowTaps: [],
    armed: false,
    survivalOver: false,
    consecutiveMisses: 0,
  };
  blindWindowEndDeltas = [];
  totalBlindBeatsDone = 0;
  lastTapVid = null;
  lastPulseBeat = null;

  renderPlayPanel();

  clock = createVideoClock({
    container: root.querySelector('#ytTarget'),
    videoId: effectiveVideoId(),
    onStateChange: (s) => {
      if (s === PlayerState.ENDED) finishSession('video ended');
      if (s === PlayerState.PLAYING) {
        const gate = root.querySelector('#playGate');
        if (gate) gate.classList.add('hidden');
      }
      if (s === PlayerState.PLAYING && phase === 'loading') {
        phase = 'anchoring';
        setStatus(`TAP ALONG TO LOCK IN — 0/${settings().anchorTapCount}`);
      }
      if (s === PlayerState.PAUSED && (phase === 'anchoring' || phase === 'tracking')) {
        const gate = root.querySelector('#playGate');
        const btn = root.querySelector('#playBtn');
        if (btn) btn.textContent = '▶ Resume';
        if (gate) gate.classList.remove('hidden');
        setStatus('Paused — tap ▶ Resume');
      }
    },
    onError: (code) => {
      if (clock) clock.destroy();
      clock = null;
      renderErrorPanel(code);
    },
    onFlush: () => {
      if (phase === 'tracking') setStatus('Re-syncing to video…');
      if (phase === 'anchoring' && engine.anchorProgress > 0) {
        // Anchor taps spanned a seek/ad — start the count over.
        engine = createEngine({ bpm: song.bpm, anchorTapCount: settings().anchorTapCount });
        setStatus(`Video jumped — tap to lock in again — 0/${settings().anchorTapCount}`);
      }
    },
    onMappingReady: () => {
      if (phase === 'anchoring') setStatus(`TAP ALONG TO LOCK IN — ${engine.anchorProgress}/${settings().anchorTapCount}`);
      if (phase === 'tracking') setStatus(blind.mode === 'off' ? 'Locked in — keep tapping' : 'Locked in — blind windows incoming…');
    },
  });
  clock.ready.then(() => {
    const btn = root.querySelector('#playBtn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '▶ Play';
    }
  });

  focusWatchdog = setInterval(() => {
    const a = document.activeElement;
    if (a && a.tagName === 'IFRAME') {
      a.blur();
      document.body.focus();
    }
  }, 500);

  rafId = requestAnimationFrame(tick);
}

// Redo the lock-in taps without losing score — for when the initial anchor
// was sloppy and every later tap is scored against a misaligned grid.
function reAnchorNow() {
  if (!engine || (phase !== 'anchoring' && phase !== 'tracking')) return;
  if (blind.active) exitBlind(true);
  blind.armed = false; // re-arms after the new lock
  blind.nextStart = null;
  blind.windowEnd = null;
  engine.reAnchor();
  phase = 'anchoring';
  lastTapVid = null;
  lastPulseBeat = null;
  const marker = root.querySelector('#tbMarker');
  if (marker) marker.classList.add('hidden');
  blipFeedback('&nbsp;', '');
  setStatus(`Re-locking — tap ${settings().anchorTapCount} steady beats`);
}

function togglePause() {
  if (!clock) return;
  if (clock.getPlayerState() === PlayerState.PLAYING) clock.pause();
  else clock.play();
}

function finishSession(reason) {
  if (!engine || phase === 'results') return;
  const stats = engine.getStats();
  if (clock) {
    clock.destroy();
    clock = null;
  }
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (stats.tapCount < 4) {
    renderStartPanel();
    return;
  }
  phase = 'results';

  const blindStats = stats.blind
    ? {
        ...stats.blind,
        avgEndDrift: blindWindowEndDeltas.length
          ? blindWindowEndDeltas.reduce((a, b) => a + b, 0) / blindWindowEndDeltas.length
          : 0,
        beatsSurvived: BLIND_MODES[blind.mode]?.survivable ? Math.round(totalBlindBeatsDone) : null,
      }
    : null;

  addSession({
    id: newId('s'),
    songId: song.id,
    date: Date.now(),
    bpm: song.bpm,
    blindMode: blind.mode,
    score: stats.score,
    accuracy: round1(stats.accuracy),
    grade: stats.grade,
    meanDelta: round1(stats.meanDelta),
    stdDev: round1(stats.stdDev),
    driftSlope: round2(stats.driftSlope),
    tapCount: stats.tapCount,
    counts: stats.counts,
    blind: blindStats,
    histogram: stats.histogram,
  });

  renderResults(stats, blindStats, reason);
}

function renderResults(stats, blindStats, reason) {
  const verdictText = {
    steady: 'Steady tempo — nice.',
    rushing: 'You tend to RUSH (speeding up ahead of the beat).',
    dragging: 'You tend to DRAG (falling behind the beat).',
  }[stats.verdict];
  const meanHint =
    Math.abs(stats.meanDelta) > 25
      ? `Average tap is ${Math.abs(stats.meanDelta).toFixed(0)}ms ${stats.meanDelta > 0 ? 'late' : 'early'} — consider recalibrating your input offset in Settings.`
      : '';

  root.innerHTML = `
    <a class="back" href="#/select">← Songs</a>
    <div class="results">
      <div class="grade grade-${stats.grade}">${stats.grade}</div>
      <h1>${esc(song.title)}</h1>
      <p class="hint">${reason === 'survival' ? 'Survival run over!' : ''}</p>
      <div class="results-grid">
        <div><span class="sb-label">Score</span><span>${stats.score.toLocaleString()}</span></div>
        <div><span class="sb-label">Accuracy</span><span>${stats.accuracy.toFixed(1)}%</span></div>
        <div><span class="sb-label">Taps</span><span>${stats.tapCount}</span></div>
        <div><span class="sb-label">Best combo</span><span>${stats.bestCombo}</span></div>
        <div><span class="sb-label">Mean</span><span>${fmtMs(stats.meanDelta)}</span></div>
        <div><span class="sb-label">Consistency (σ)</span><span>±${stats.stdDev.toFixed(0)}ms</span></div>
      </div>
      <p class="verdict">${verdictText}</p>
      ${meanHint ? `<p class="hint">${meanHint}</p>` : ''}
      <div class="counts-row">
        <span class="c-perfect">${stats.counts.perfect} perfect</span>
        <span class="c-good">${stats.counts.good} good</span>
        <span class="c-okay">${stats.counts.okay} okay</span>
        <span class="c-miss">${stats.counts.miss} miss</span>
        ${stats.counts.extra ? `<span class="c-extra">${stats.counts.extra} extra</span>` : ''}
      </div>
      ${
        blindStats
          ? `<div class="blind-results">
              <h2>Flying Blind</h2>
              <div class="results-grid">
                <div><span class="sb-label">Blind taps</span><span>${blindStats.tapCount}</span></div>
                <div><span class="sb-label">Blind accuracy</span><span>${blindStats.accuracy.toFixed(1)}%</span></div>
                <div><span class="sb-label">Longest streak</span><span>${blindStats.longestStreak}</span></div>
                <div><span class="sb-label">Avg end drift</span><span>${fmtMs(blindStats.avgEndDrift)}</span></div>
                ${blindStats.beatsSurvived != null ? `<div><span class="sb-label">Beats survived</span><span>${blindStats.beatsSurvived}</span></div>` : ''}
              </div>
            </div>`
          : ''
      }
      <div class="chart-title">Accuracy over the song — shaded by rush (early) vs drag (late)</div>
      <canvas class="chart" id="accChart"></canvas>
      <div class="chart-title">Tap timing spread</div>
      <canvas class="chart" id="histChart"></canvas>
      <div class="results-actions">
        <button class="btn primary" id="againBtn">Play again</button>
        <a class="btn" href="#/dashboard">Dashboard</a>
      </div>
    </div>
  `;
  drawAccuracyTimeline(root.querySelector('#accChart'), stats.timeline);
  drawHistogram(root.querySelector('#histChart'), stats.histogram);
  root.querySelector('#againBtn').addEventListener('click', () => renderStartPanel());
}

// ---------- input ----------

function normalizeStamp(e) {
  const ts = e.timeStamp;
  // Some browsers hand out epoch-based stamps; fall back to now.
  if (!ts || ts > 1e12) return performance.now();
  return ts;
}

function onKey(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.code === 'Space' || e.code === 'KeyF' || e.code === 'KeyJ') {
    e.preventDefault();
    if (e.repeat) return;
    doTap(normalizeStamp(e));
  } else if (e.key === 'd' || e.key === 'D') {
    debugOverlayOn = !debugOverlayOn;
    const o = root.querySelector('#debugOverlay');
    if (o) o.classList.toggle('hidden', !debugOverlayOn);
  } else if (e.key === 'A' && e.shiftKey) {
    // Shift+A so a stray pinky near F can't toggle it mid-run.
    autotap = autotap ? null : { nextPerf: performance.now() + 500 };
  }
}

function doTap(perfT) {
  if (phase !== 'anchoring' && phase !== 'tracking') return;
  flashTapPad();
  if (!clock || !clock.isMappingReady()) {
    setStatus('Hold on — syncing to the video…');
    return;
  }
  const vid = clock.videoTimeAt(perfT) - settings().inputOffset;
  const isBlind = blind.active;
  const res = engine.addTap(vid, { blind: isBlind });
  lastTapVid = vid;

  switch (res.type) {
    case 'anchor':
      setStatus(`TAP ALONG TO LOCK IN — ${res.count}/${res.needed}`);
      blipFeedback('·', '');
      break;
    case 'anchor-failed':
      setStatus("Couldn't lock on — keep tapping steady beats");
      break;
    case 'locked':
      phase = 'tracking';
      setStatus(`LOCKED IN at ${res.gridBpm} BPM — ${blind.mode === 'off' ? 'keep tapping!' : 'blind windows incoming…'}`);
      break;
    case 'tap':
      lastCombo = res.combo;
      if (isBlind) {
        blind.windowTaps.push(res);
        const cfg = BLIND_MODES[blind.mode];
        if (cfg.showBlindFeedback) {
          showTapFeedback(res);
        } else if (res.rating === 'miss') {
          const dir = res.delta < 0 ? 'EARLY' : 'LATE';
          blipFeedback(`<span class="c-miss">MISS — ${dir}</span>`, '');
        } else {
          neutralBlip();
        }
        if (cfg.survivable) {
          if (res.rating === 'miss') {
            blind.consecutiveMisses++;
            updateSurvivalStrikes();
            if (blind.consecutiveMisses >= 3) endSurvival('miss');
          } else {
            blind.consecutiveMisses = 0;
            updateSurvivalStrikes();
          }
        }
      } else {
        showTapFeedback(res);
      }
      updateScoreboard();
      break;
    case 'extra':
      if (!isBlind) blipFeedback('extra', 'c-extra');
      break;
    case 'ignored':
      break;
  }
}

// ---------- per-frame loop: beat pulse, blind scheduler, debug ----------

function tick() {
  rafId = requestAnimationFrame(tick);
  if (!clock) return;

  if (debugOverlayOn) {
    const o = root.querySelector('#debugOverlay');
    if (o) {
      const d = clock.debugInfo();
      o.textContent =
        `map ${d.ready ? 'OK' : '—'} slope=${d.slope.toFixed(4)} edges=${d.edges} resid=${d.lastResidual.toFixed(1)}ms` +
        (engine && engine.state === 'tracking' ? ` | φ=${engine.phase.toFixed(0)} T=${engine.period.toFixed(1)}` : '');
    }
  }

  if (!clock.isMappingReady() || !engine) return;
  const vid = clock.videoTimeAt(performance.now());
  runAutotap(vid);
  if (engine.state !== 'tracking') return;
  const beatFloat = (vid - engine.phase) / engine.period;

  // Beat pulse (hidden while blind).
  const pulse = root.querySelector('#beatPulse');
  if (pulse) {
    const k = Math.floor(beatFloat);
    if (k !== lastPulseBeat && !blind.active) {
      lastPulseBeat = k;
      pulse.classList.remove('pulse');
      void pulse.offsetWidth; // restart the CSS animation
      pulse.classList.add('pulse');
    }
    pulse.classList.toggle('hidden', blind.active);
  }

  runBlindScheduler(beatFloat, vid);
}

function runBlindScheduler(beatFloat, vid) {
  if (blind.mode === 'off' || blind.survivalOver) return;
  const cfg = BLIND_MODES[blind.mode];

  if (!blind.armed) {
    const stats = engine.getStats();
    if (stats.tapCount >= BLIND_GRACE_TAPS) {
      blind.armed = true;
      // First window starts on the next bar boundary at least 1 bar out.
      blind.nextStart = Math.ceil((beatFloat + BAR) / BAR) * BAR;
      blind.windowEnd = blind.nextStart + blindLen(cfg, 0);
    }
    return;
  }

  if (!blind.active && beatFloat >= blind.nextStart) {
    enterBlind();
  } else if (blind.active) {
    const remaining = Math.max(0, blind.windowEnd - beatFloat);
    const count = root.querySelector('#blindCount');
    if (count) count.textContent = `${Math.ceil(remaining)} beats`;

    // Survival dropout: stopped tapping mid-window.
    if (BLIND_MODES[blind.mode]?.survivable && lastTapVid !== null && vid - lastTapVid > 2.5 * engine.period) {
      endSurvival('dropout');
      return;
    }
    if (beatFloat >= blind.windowEnd) exitBlind();
  }
}

function blindLen(cfg, idx) {
  return cfg.blind[Math.min(idx, cfg.blind.length - 1)];
}

function enterBlind() {
  blind.active = true;
  blind.windowTaps = [];
  blind.windowStartBeat = blind.nextStart;
  blind.consecutiveMisses = 0;
  engine.setDriftFrozen(true);
  clock.mute();
  root.querySelector('#blindOverlay').classList.remove('hidden');
  root.querySelector('#tbMarker').classList.add('hidden');
  root.querySelector('#feedback').innerHTML = '&nbsp;';
  const strikesEl = root.querySelector('#blindStrikes');
  if (strikesEl) {
    strikesEl.classList.toggle('hidden', !BLIND_MODES[blind.mode]?.survivable);
    strikesEl.textContent = '○ ○ ○';
  }
  setStatus('Keep the tempo going — no sound, no feedback');
}

function exitBlind(silent) {
  const cfg = BLIND_MODES[blind.mode];
  blind.active = false;
  engine.setDriftFrozen(false);
  clock.unMute();
  root.querySelector('#blindOverlay').classList.add('hidden');
  totalBlindBeatsDone += blind.windowEnd - blind.windowStartBeat;

  if (!silent) {
    const taps = blind.windowTaps;
    if (taps.length) {
      const avg = taps.reduce((a, t) => a + t.delta, 0) / taps.length;
      const end = taps[taps.length - 1].delta;
      blindWindowEndDeltas.push(end);
      showToast(`👁 Blind window: ${taps.length} taps · avg ${fmtMs(avg)} · re-entered ${fmtMs(end)} ${end >= 0 ? 'late' : 'early'}`);
    } else {
      showToast('👁 Blind window passed with no taps');
    }
  }
  setStatus('Sound is back — keep tapping');

  blind.windowIdx++;
  blind.nextStart = blind.windowEnd + cfg.audible;
  blind.windowEnd = blind.nextStart + blindLen(cfg, blind.windowIdx);
}

function endSurvival(why) {
  blind.survivalOver = true;
  // Count only the beats actually survived inside the fatal window.
  const vid = clock.videoTimeAt(performance.now());
  const beatFloat = (vid - engine.phase) / engine.period;
  const partial = Math.max(0, Math.min(beatFloat, blind.windowEnd) - blind.windowStartBeat);
  const fullLen = blind.windowEnd - blind.windowStartBeat;
  exitBlind(true); // adds fullLen to the total; correct it to the partial below
  totalBlindBeatsDone += partial - fullLen;
  showToast(why === 'miss' ? '💥 Missed while blind — survival over!' : '💥 Lost the thread — survival over!');
  setTimeout(() => finishSession('survival'), 1600);
}

function runAutotap(vid) {
  if (!autotap || !clock) return;
  const now = performance.now();
  if (engine.state === 'anchoring') {
    if (now >= autotap.nextPerf) {
      doTap(autotap.nextPerf + (Math.random() * 2 - 1) * 8);
      autotap.nextPerf += engine.period;
    }
    return;
  }
  // Tracking: fire once per grid beat, at beat time + inputOffset.
  const k = engine.beatIndexFor(vid);
  if (autotap.lastBeat === k) return;
  const beatVid = engine.beatTime(k);
  const perfAtBeat = clock.perfTimeAt(beatVid + settings().inputOffset);
  if (perfAtBeat !== null && now >= perfAtBeat) {
    autotap.lastBeat = k;
    doTap(perfAtBeat + (Math.random() * 2 - 1) * 8);
  }
}

// ---------- UI helpers ----------

function setStatus(text) {
  const el = root.querySelector('#statusLine');
  if (el) el.textContent = text;
}

const RATING_LABEL = { perfect: 'PERFECT', good: 'GOOD', okay: 'OKAY', miss: 'MISS' };

function showTapFeedback(res) {
  const fb = root.querySelector('#feedback');
  if (fb) {
    const dir = res.rating === 'perfect' ? '' : res.delta < 0 ? ' — EARLY' : ' — LATE';
    fb.innerHTML = `<span class="c-${res.rating}">${RATING_LABEL[res.rating]}${dir}</span> <span class="fb-ms">${fmtMs(res.delta)}</span>`;
  }
  const marker = root.querySelector('#tbMarker');
  if (marker) {
    const clamped = Math.max(-135, Math.min(135, res.delta));
    marker.style.left = `${50 + (clamped / 135) * 50}%`;
    marker.className = `tb-marker c-${res.rating}-bg`;
  }
}

function flashTapPad() {
  const pad = root.querySelector('#tapPad');
  if (!pad) return;
  pad.classList.remove('flash');
  void pad.offsetWidth; // restart the CSS animation
  pad.classList.add('flash');
}

function updateSurvivalStrikes() {
  const el = root.querySelector('#blindStrikes');
  if (!el) return;
  const n = blind.consecutiveMisses;
  el.textContent = ['○', '○', '○'].map((_, i) => i < n ? '●' : '○').join(' ');
  el.classList.toggle('strike-warn', n > 0);
}

function neutralBlip() {
  const blip = root.querySelector('#blindBlip');
  if (blip) {
    blip.classList.remove('blip');
    void blip.offsetWidth;
    blip.classList.add('blip');
  }
}

function blipFeedback(text, cls) {
  const fb = root.querySelector('#feedback');
  if (fb) fb.innerHTML = `<span class="${cls}">${text}</span>`;
}

let lastCombo = 0;
function updateScoreboard() {
  const s = engine.getStats();
  setText('#sbScore', s.score.toLocaleString());
  setText('#sbCombo', String(lastCombo));
  setText('#sbAcc', `${s.accuracy.toFixed(1)}%`);
}

function setText(sel, text) {
  const el = root.querySelector(sel);
  if (el) el.textContent = text;
}

function showToast(text) {
  const t = root.querySelector('#toast');
  if (!t) return;
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
}

function fmtMs(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(0)}ms`;
}
function round1(v) {
  return Math.round(v * 10) / 10;
}
function round2(v) {
  return Math.round(v * 100) / 100;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
