// Game view: video playback, tap capture, live feedback, Flying Blind mode.

import { findSong } from '../songs.js';
import { getData, update, addSession, newId } from '../storage.js';
import { createEngine } from '../engine.js';
import { createVideoClock, createInternalClock, PlayerState } from '../youtube.js';
import { drawHistogram, drawAccuracyTimeline } from '../charts.js';
import { createClapDetector } from '../mic.js';
import { searchSongBpm, fetchTempo, hasBpmKey, GETSONGBPM_CREDIT } from '../lookup.js';

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
let clap = null; // experimental clap detector (mic input)
let freeplay = false; // no-video mode: play along to external audio
let fpTaps = []; // tempo-tap timestamps during freeplay setup
let currentBlindMode = 'off'; // remembered so Restart can replay the same run

// Mic clap detection lags the real clap by the FFT window + frame latency;
// shift detected onsets earlier to compensate. Fine-tune via input offset.
const MIC_LATENCY_MS = 50;

function settings() {
  return getData().settings;
}

function effectiveVideoId() {
  return settings().videoOverrides?.[song.id] || song.videoId;
}

export function render(el, params) {
  leave();
  root = el;
  freeplay = !!params.freeplay;
  if (freeplay) {
    // Synthetic song; BPM is chosen in the setup step before play.
    song = { id: 'freeplay', title: 'Freeplay', artist: 'Your own audio', bpm: 120 };
    renderFreeplaySetup();
  } else {
    song = findSong(decodeURIComponent(params.songId || ''), getData().customSongs);
    if (!song) {
      el.innerHTML = `<p>Song not found. <a href="#/select">Back to songs</a></p>`;
      return;
    }
    renderStartPanel();
  }

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
  if (clap) clap.stop();
  clap = null;
  fpTaps = [];
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

// Freeplay: no video. Set a tempo (typed or tapped), then play along to audio
// from anywhere else. Flying Blind is unavailable here (can't mute outside audio).
function renderFreeplaySetup() {
  phase = 'setup';
  fpTaps = [];
  root.innerHTML = `
    <a class="back" href="#/select">← Songs</a>
    <div class="start-panel">
      <h1>🎧 Freeplay</h1>
      <p class="song-artist">Play along to audio from anywhere — set the tempo, then lock in and tap as usual.</p>
      <h2>Tempo</h2>
      <div class="song-search">
        <input type="text" id="fpSearch" placeholder="Search a song name to find its BPM…">
        <button class="btn" id="fpSearchBtn" type="button">Search BPM</button>
      </div>
      <div class="song-search-results" id="fpSearchResults"></div>
      <div class="freeplay-bpm">
        <label class="freeplay-bpm-field">BPM
          <input type="number" id="fpBpm" min="40" max="240" step="0.1" value="120">
        </label>
        <button class="btn" id="fpTapBtn" type="button">Tap tempo</button>
        <span class="freeplay-tapinfo" id="fpTapInfo">tap 4+ times</span>
      </div>
      <p class="hint">Type a BPM, or tap the button (or Space / F / J) along with your music to find it.</p>
      <button id="fpStart" class="btn primary big">▶ Start</button>
      <p class="hint">Then tap ${settings().anchorTapCount} steady beats to lock the grid to your audio, and keep tapping.</p>
    </div>
  `;
  root.querySelector('#fpTapBtn').addEventListener('click', () => tempoTap(performance.now()));
  const fpSearch = root.querySelector('#fpSearch');
  const runFpSearch = () => freeplaySearch(fpSearch.value);
  root.querySelector('#fpSearchBtn').addEventListener('click', runFpSearch);
  fpSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFpSearch();
    }
  });
  root.querySelector('#fpStart').addEventListener('click', () => {
    const bpm = parseFloat(root.querySelector('#fpBpm').value);
    if (!(bpm >= 40 && bpm <= 240)) {
      root.querySelector('#fpTapInfo').textContent = 'BPM must be 40–240';
      return;
    }
    song.bpm = bpm;
    startGame('off');
  });
}

// Estimate BPM from the spacing of recent taps (median interval, folded into
// the musical 40–240 range). Resets if you pause more than 2s between taps.
function tempoTap(now) {
  if (fpTaps.length && now - fpTaps[fpTaps.length - 1] > 2000) fpTaps = [];
  fpTaps.push(now);
  if (fpTaps.length > 8) fpTaps.shift();
  flashFreeplayTap();
  const info = root.querySelector('#fpTapInfo');
  if (fpTaps.length < 2) {
    if (info) info.textContent = 'keep tapping…';
    return;
  }
  const intervals = [];
  for (let i = 1; i < fpTaps.length; i++) intervals.push(fpTaps[i] - fpTaps[i - 1]);
  intervals.sort((a, b) => a - b);
  const med = intervals[Math.floor(intervals.length / 2)];
  let bpm = 60000 / med;
  while (bpm < 40) bpm *= 2;
  while (bpm > 240) bpm /= 2;
  const input = root.querySelector('#fpBpm');
  if (input) input.value = bpm.toFixed(1);
  if (info) info.textContent = `${bpm.toFixed(1)} BPM · ${fpTaps.length} taps`;
}

function flashFreeplayTap() {
  const btn = root.querySelector('#fpTapBtn');
  if (!btn) return;
  btn.classList.remove('flash');
  void btn.offsetWidth;
  btn.classList.add('flash');
}

// Look up BPM by song name (GetSongBPM). Results are clickable — picking one
// fills the BPM field (fetching tempo on demand if the search row lacked it).
async function freeplaySearch(query) {
  const out = root.querySelector('#fpSearchResults');
  if (!out) return;
  if (!query.trim()) return;
  if (!hasBpmKey()) {
    out.innerHTML = `<p class="form-error">Add a GetSongBPM API key in <a href="#/settings">Settings</a> to search by name.</p>`;
    return;
  }
  out.innerHTML = '<p class="hint">Searching…</p>';
  let results;
  try {
    results = await searchSongBpm(query);
  } catch (e) {
    out.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
    return;
  }
  if (!results.length) {
    out.innerHTML = '<p class="hint">No matches. Try the exact title, or set the BPM manually.</p>';
    return;
  }
  out.innerHTML =
    results
      .slice(0, 6)
      .map(
        (r, i) =>
          `<button class="song-result" type="button" data-i="${i}">
             <span class="song-result-name">${esc(r.title)}${r.artist ? ` · ${esc(r.artist)}` : ''}</span>
             <span class="song-result-bpm">${r.tempo ? `${r.tempo} BPM` : 'BPM…'}</span>
           </button>`
      )
      .join('') + `<a class="song-credit" href="${GETSONGBPM_CREDIT.url}" target="_blank" rel="noopener">${GETSONGBPM_CREDIT.label}</a>`;
  out.querySelectorAll('.song-result').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const r = results[Number(btn.dataset.i)];
      let tempo = r.tempo;
      if (!tempo) {
        btn.querySelector('.song-result-bpm').textContent = '…';
        try {
          tempo = await fetchTempo(r.id);
        } catch {
          tempo = null;
        }
      }
      if (!tempo) {
        btn.querySelector('.song-result-bpm').textContent = 'no BPM';
        return;
      }
      const input = root.querySelector('#fpBpm');
      if (input) input.value = tempo.toFixed(1);
      root.querySelector('#fpTapInfo').textContent = `${tempo.toFixed(1)} BPM · ${r.title}`;
      out.querySelectorAll('.song-result').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    })
  );
}

function renderPlayPanel() {
  root.innerHTML = `
    <div class="game-top">
      <a class="back" href="#/select">← Quit</a>
      <div class="game-song">${esc(song.title)} · ${song.bpm} BPM</div>
      <div class="game-buttons">
        <button id="polyBtn" class="btn small" title="Experimental: also register triplets over the main beat">🔺 Triplets</button>
        <button id="clapBtn" class="btn small" title="Experimental: clap into your mic instead of tapping">🎤 Clap</button>
        <button id="reAnchorBtn" class="btn small" title="Redo the lock-in taps — score is kept">↻ Re-lock</button>
        <button id="restartBtn" class="btn small" title="Restart this run from the beginning">↺ Restart</button>
        ${freeplay ? '' : '<button id="pauseBtn" class="btn small">⏸</button>'}
        <button id="finishBtn" class="btn small">Finish</button>
      </div>
    </div>
    <div class="video-wrap${freeplay ? ' freeplay-wrap' : ''}" id="videoWrap">
      ${
        freeplay
          ? `<div class="freeplay-stage">
               <div class="freeplay-bpm-big">${song.bpm.toFixed(1)} BPM</div>
               <div class="freeplay-pulse" id="freeplayPulse"></div>
               <div class="freeplay-stage-hint">Tap along to your own audio</div>
             </div>`
          : `<div id="ytTarget"></div>
             <div class="click-shield" id="clickShield"></div>`
      }
      <div class="blind-overlay hidden" id="blindOverlay">
        <div class="blind-title">FLYING BLIND</div>
        <div class="blind-count" id="blindCount"></div>
        <div class="blind-strikes hidden" id="blindStrikes"></div>
        <div class="blind-blip" id="blindBlip"></div>
      </div>
      <div class="play-gate" id="playGate">
        <button class="play-btn" id="playBtn"${freeplay ? '' : ' disabled'}>${freeplay ? '▶ Start' : 'Loading video…'}</button>
      </div>
      <div class="debug-overlay hidden" id="debugOverlay"></div>
    </div>
    <div class="hud">
      <div class="status-line" id="statusLine">${freeplay ? 'Tap ▶ Start, then lock in to your audio' : 'Loading video…'}</div>
      <div class="feedback" id="feedback">&nbsp;</div>
      <div class="timing-bar" id="timingBar">
        <div class="tb-zone tb-okay"></div>
        <div class="tb-zone tb-good"></div>
        <div class="tb-zone tb-perfect"></div>
        <div class="tb-center"></div>
        <div class="tb-marker hidden" id="tbMarker"></div>
      </div>
      <div class="hit-history" id="hitHistory" aria-hidden="true">
        <span class="hit-edge hit-edge-top">early</span>
        <span class="hit-edge hit-edge-bot">late</span>
        <div class="hit-center"></div>
        <div class="hit-dots" id="hitDots"></div>
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
      <span class="tap-pad-label" id="tapPadLabel">TAP</span>
      <span class="tap-pad-sub" id="tapPadSub">click here · Space · or F + J for fast subdivisions</span>
    </div>
    <div class="clap-row hidden" id="clapRow">
      <div class="clap-meter"><div class="clap-meter-bar" id="clapMeterBar"></div></div>
      <label class="clap-sens">Sensitivity
        <input type="range" id="clapSens" min="0" max="1" step="0.05">
      </label>
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
  root.querySelector('#restartBtn').addEventListener('click', restartGame);
  root.querySelector('#pauseBtn')?.addEventListener('click', togglePause);
  root.querySelector('#finishBtn').addEventListener('click', () => finishSession('finished'));
  root.querySelector('#clapBtn').addEventListener('click', toggleClapMode);
  const polyBtn = root.querySelector('#polyBtn');
  polyBtn.classList.toggle('active', !!settings().polyrhythm);
  polyBtn.addEventListener('click', togglePoly);
  const sens = root.querySelector('#clapSens');
  sens.value = String(settings().clapSensitivity ?? 0.5);
  sens.addEventListener('input', () => {
    const v = parseFloat(sens.value);
    if (clap) clap.setSensitivity(v);
    update((d) => {
      d.settings.clapSensitivity = v;
    });
  });
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

// Shared player-state handling for both the video clock and the internal
// (Freeplay) clock: hide the gate and start anchoring on play, re-show it on pause.
function handleStateChange(s) {
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
}

function startGame(blindMode) {
  phase = 'loading';
  currentBlindMode = blindMode; // remembered for Restart
  engine = createEngine({ bpm: song.bpm, anchorTapCount: settings().anchorTapCount, polyrhythm: !!settings().polyrhythm });
  blind = {
    mode: freeplay ? 'off' : blindMode, // can't mute external audio for blind windows
    active: false,
    nextStart: null, // beat numbers in grid space
    windowEnd: null,
    windowIdx: 0,
    windowTaps: [],
    armed: false,
    survivalOver: false,
    consecutiveMisses: 0,
    historyBand: null,
  };
  blindWindowEndDeltas = [];
  totalBlindBeatsDone = 0;
  lastTapVid = null;
  lastPulseBeat = null;

  renderPlayPanel();

  if (freeplay) {
    clock = createInternalClock({ onStateChange: handleStateChange });
    // No media to load — the Start button is live immediately.
    rafId = requestAnimationFrame(tick);
    return;
  }

  clock = createVideoClock({
    container: root.querySelector('#ytTarget'),
    videoId: effectiveVideoId(),
    onStateChange: handleStateChange,
    onError: (code) => {
      if (clock) clock.destroy();
      clock = null;
      renderErrorPanel(code);
    },
    onFlush: () => {
      if (phase === 'tracking') setStatus('Re-syncing to video…');
      if (phase === 'anchoring' && engine.anchorProgress > 0) {
        // Anchor taps spanned a seek/ad — start the count over.
        engine = createEngine({ bpm: song.bpm, anchorTapCount: settings().anchorTapCount, polyrhythm: !!settings().polyrhythm });
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
  clearHits();
  blipFeedback('&nbsp;', '');
  setStatus(`Re-locking — tap ${settings().anchorTapCount} steady beats`);
}

function togglePause() {
  if (!clock) return;
  if (clock.getPlayerState() === PlayerState.PLAYING) clock.pause();
  else clock.play();
}

// Replay the current song from the top with a clean engine/score. Reuses the
// full setup so video and Freeplay both get a fresh play gate to start from.
function restartGame() {
  if (clap) {
    clap.stop();
    clap = null;
  }
  if (clock) {
    clock.destroy();
    clock = null;
  }
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  clearInterval(focusWatchdog);
  focusWatchdog = null;
  startGame(currentBlindMode);
}

// Experimental: also accept triplet-grid taps (e.g. triplets over a 4/4 pulse).
function togglePoly() {
  const on = !settings().polyrhythm;
  update((d) => {
    d.settings.polyrhythm = on;
  });
  if (engine) engine.setPolyrhythm(on);
  const btn = root.querySelector('#polyBtn');
  if (btn) btn.classList.toggle('active', on);
  setStatus(on ? 'Triplets on — triplet taps over the beat now register' : 'Triplets off');
}

// ---------- experimental: clap (mic) input ----------

async function toggleClapMode() {
  if (clap) {
    clap.stop();
    clap = null;
    setClapUI(false);
    return;
  }
  const btn = root.querySelector('#clapBtn');
  btn.disabled = true;
  setStatus('Requesting microphone…');
  const detector = createClapDetector({
    sensitivity: settings().clapSensitivity ?? 0.5,
    onOnset: (now) => {
      doTap(now - MIC_LATENCY_MS);
    },
    onLevel: (level) => {
      const bar = root.querySelector('#clapMeterBar');
      if (bar) bar.style.width = `${Math.min(100, level * 140).toFixed(0)}%`;
    },
    onError: (err) => {
      clap = null;
      setClapUI(false);
      setStatus(`Mic unavailable (${err.name || 'error'}) — tapping still works.`);
    },
  });
  const ok = await detector.start();
  btn.disabled = false;
  if (ok) {
    clap = detector;
    setClapUI(true);
  }
}

function setClapUI(on) {
  const btn = root.querySelector('#clapBtn');
  const label = root.querySelector('#tapPadLabel');
  const sub = root.querySelector('#tapPadSub');
  const row = root.querySelector('#clapRow');
  if (btn) btn.classList.toggle('active', on);
  if (row) row.classList.toggle('hidden', !on);
  if (label) label.textContent = on ? '🎤 CLAP' : 'TAP';
  if (sub) {
    sub.textContent = on
      ? 'listening for claps · headphones recommended · click/Space still work'
      : 'click here · Space · or F + J for fast subdivisions';
  }
  if (on) setStatus('Clap mode on — clap on the beat. Headphones help avoid the music triggering it.');
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
    if (freeplay) renderFreeplaySetup();
    else renderStartPanel();
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

function tendencyLabel(ms) {
  const abs = Math.abs(ms);
  if (abs < 10) return { text: 'Centered', cls: 'c-perfect' };
  const dir = ms < 0 ? 'early' : 'late';
  const dirCls = ms < 0 ? 'c-early' : 'c-late';
  if (abs < 25) return { text: `Slightly ${dir}`, cls: 'c-good' };
  if (abs < 50) return { text: dir.charAt(0).toUpperCase() + dir.slice(1), cls: dirCls };
  return { text: `Strongly ${dir}`, cls: 'c-miss' };
}

function consistencyLabel(sd) {
  if (sd < 20) return { text: 'Tight', cls: 'c-perfect' };
  if (sd < 35) return { text: 'Solid', cls: 'c-good' };
  if (sd < 55) return { text: 'Variable', cls: 'c-okay' };
  return { text: 'Loose', cls: 'c-miss' };
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
  const tendency = tendencyLabel(stats.meanDelta);
  const consistency = consistencyLabel(stats.stdDev);

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
        <div><span class="sb-label">Tendency</span><span><span class="${tendency.cls}">${tendency.text}</span> <span class="res-detail">${fmtMs(stats.meanDelta)}</span></span></div>
        <div><span class="sb-label">Consistency</span><span><span class="${consistency.cls}">${consistency.text}</span> <span class="res-detail">±${stats.stdDev.toFixed(0)}ms</span></span></div>
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
  root.querySelector('#againBtn').addEventListener('click', () => (freeplay ? renderFreeplaySetup() : renderStartPanel()));
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
    if (phase === 'setup') {
      tempoTap(normalizeStamp(e));
      return;
    }
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
          pushHit(res, blind.historyBand); // grows the live blind band
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
        pushHit(res);
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

  // Beat pulse (hidden while blind) — the scoreboard dot, plus the big
  // Freeplay stage indicator when there's no video to watch.
  const k = Math.floor(beatFloat);
  const pulse = root.querySelector('#beatPulse');
  if (k !== lastPulseBeat && !blind.active) {
    lastPulseBeat = k;
    for (const el of [pulse, root.querySelector('#freeplayPulse')]) {
      if (!el) continue;
      el.classList.remove('pulse');
      void el.offsetWidth; // restart the CSS animation
      el.classList.add('pulse');
    }
  }
  if (pulse) pulse.classList.toggle('hidden', blind.active);

  runBlindScheduler(beatFloat, vid);
}

// Blind windows are sized in musical quarter-note beats (so "4 bars" feels the
// same regardless of whether you locked onto quarters, 16ths, or 32nds). The
// scheduler runs in grid-beat space though, so convert with this factor: how
// many grid beats make up one quarter note.
function gridPerQuarter() {
  return engine ? engine.basePeriod / engine.period : 1;
}

function runBlindScheduler(beatFloat, vid) {
  if (blind.mode === 'off' || blind.survivalOver) return;
  const cfg = BLIND_MODES[blind.mode];
  const q = gridPerQuarter();
  const barG = BAR * q; // grid beats per musical bar

  if (!blind.armed) {
    const stats = engine.getStats();
    if (stats.tapCount >= BLIND_GRACE_TAPS) {
      blind.armed = true;
      // First window starts on the next musical-bar boundary, at least 1 bar out.
      blind.nextStart = Math.ceil((beatFloat + barG) / barG) * barG;
      blind.windowEnd = blind.nextStart + blindLen(cfg, 0) * q;
    }
    return;
  }

  if (!blind.active && beatFloat >= blind.nextStart) {
    enterBlind();
  } else if (blind.active) {
    const remaining = Math.max(0, blind.windowEnd - beatFloat);
    const count = root.querySelector('#blindCount');
    if (count) count.textContent = `${Math.ceil(remaining / q)} beats`; // shown in musical beats

    // Survival dropout: stopped tapping for ~2.5 quarter notes.
    if (cfg.survivable && lastTapVid !== null && vid - lastTapVid > 2.5 * engine.basePeriod) {
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
  // Modes that show timing live grow their band as taps land; no-feedback modes
  // get their band built at window end (flushBlindWindowToHistory).
  blind.historyBand = BLIND_MODES[blind.mode]?.showBlindFeedback ? createHistoryBand() : null;
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
  const q = gridPerQuarter();
  blind.active = false;
  engine.setDriftFrozen(false);
  clock.unMute();
  root.querySelector('#blindOverlay').classList.add('hidden');
  totalBlindBeatsDone += (blind.windowEnd - blind.windowStartBeat) / q; // musical beats

  // Reveal the window's taps in the history now that the window is over, for
  // modes that hid timing live (Survival already pushed them as they happened).
  if (!cfg.showBlindFeedback) {
    flushBlindWindowToHistory(blind.windowTaps);
  }

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
  blind.nextStart = blind.windowEnd + cfg.audible * q;
  blind.windowEnd = blind.nextStart + blindLen(cfg, blind.windowIdx) * q;
}

function endSurvival(why) {
  blind.survivalOver = true;
  // Count only the beats actually survived inside the fatal window (musical beats).
  const q = gridPerQuarter();
  const vid = clock.videoTimeAt(performance.now());
  const beatFloat = (vid - engine.phase) / engine.period;
  const partial = (Math.max(0, Math.min(beatFloat, blind.windowEnd) - blind.windowStartBeat)) / q;
  const fullLen = (blind.windowEnd - blind.windowStartBeat) / q;
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

const MAX_HITS = 64; // recent taps kept on the history strip
const HIT_RANGE_MS = 120; // |delta| mapped to full vertical deflection
const HIT_FLUSH_STAGGER_MS = 35; // per-dot delay when a blind window reveals

// Build a history dot. Vertical offset (early up / late down) is kept in a CSS
// var so the reveal animation can scale the dot without clobbering it.
function makeDot(res) {
  const dot = document.createElement('div');
  dot.className = `hit-dot c-${res.rating}-bg`;
  const clamped = Math.max(-HIT_RANGE_MS, Math.min(HIT_RANGE_MS, res.delta));
  const offset = (clamped / HIT_RANGE_MS) * 20; // px; early(−)=up, late(+)=down
  dot.style.setProperty('--ty', `${offset.toFixed(1)}px`);
  dot.style.transform = 'translateY(var(--ty))';
  dot.title = `${RATING_LABEL[res.rating]} ${fmtMs(res.delta)}`;
  return dot;
}

// Append the latest tap to the history strip: horizontal = time (newest on the
// right), vertical = early/late, color = rating. Dots landing inside a blind
// band pop in; trimming keeps the strip bounded (and drops emptied bands).
function pushHit(res, container) {
  const dots = root.querySelector('#hitDots');
  if (!dots) return;
  const target = container || dots;
  const dot = makeDot(res);
  if (target !== dots) dot.classList.add('hit-reveal');
  target.appendChild(dot);
  trimHistory();
}

function trimHistory() {
  const dots = root.querySelector('#hitDots');
  if (!dots) return;
  const all = dots.querySelectorAll('.hit-dot'); // static snapshot, DOM order
  for (let i = 0; all.length - i > MAX_HITS; i++) {
    const parent = all[i].parentElement;
    all[i].remove();
    if (parent !== dots && parent.querySelectorAll('.hit-dot').length === 0) parent.remove();
  }
}

// A tinted full-height band behind the dots from one blind window, so the muted
// stretch is visible on the timeline.
function createHistoryBand() {
  const dots = root.querySelector('#hitDots');
  if (!dots) return null;
  const band = document.createElement('div');
  band.className = 'hit-blind-band';
  dots.appendChild(band);
  return band;
}

// Reveal a whole blind window at once, dots cascading in left→right.
function flushBlindWindowToHistory(taps) {
  const band = createHistoryBand();
  if (!band || !taps.length) return;
  taps.slice(-MAX_HITS).forEach((res, i) => {
    const dot = makeDot(res);
    dot.classList.add('hit-reveal');
    dot.style.animationDelay = `${Math.min(i * HIT_FLUSH_STAGGER_MS, 900)}ms`;
    band.appendChild(dot);
  });
  trimHistory();
}

function clearHits() {
  const dots = root.querySelector('#hitDots');
  if (dots) dots.innerHTML = '';
  if (blind) blind.historyBand = null;
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
