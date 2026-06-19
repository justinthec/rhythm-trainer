// youtube.js — IFrame API wrapper + video-time ↔ performance-time mapping.
//
// player.getCurrentTime() only refreshes in ~250ms chunks, so a naive read is
// useless for ±40ms scoring. Instead we poll every 50ms and keep only the
// samples where the raw value CHANGED (an "edge" — the instant the chunk
// updated, when the value is freshest), then least-squares fit
//   videoMs = a + b · perfMs
// over a ring buffer of recent edges. That line lets us convert any tap's
// performance.now() timestamp into accurate video time.

const POLL_MS = 50;
// Edge cadence varies by browser: some report getCurrentTime() in ~250ms
// chunks (4 edges/s), others update it every poll (20 edges/s). Evict by age,
// not count, so the buffer always spans enough time to fit a line.
const EDGE_WINDOW_MS = 5000;
const RESIDUAL_LIMIT = 120; // ms; a bigger jump means seek/ad/rate change
const MIN_EDGES = 4;
const MIN_SPAN_MS = 1000;

let apiPromise = null;
export function loadIframeAPI() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (prev) prev();
      resolve(window.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return apiPromise;
}

export const PlayerState = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

export function createVideoClock({ container, videoId, onStateChange, onError, onFlush, onMappingReady }) {
  let player = null;
  let pollTimer = null;
  let edges = []; // { p: perfMs, v: videoMs }
  let lastRaw = null;
  let fit = null; // { a, b }
  let wasReady = false;
  let lastResidual = 0;
  let destroyed = false;

  function refit() {
    if (edges.length < MIN_EDGES || edges[edges.length - 1].p - edges[0].p < MIN_SPAN_MS) {
      fit = null;
      return;
    }
    let mp = 0;
    let mv = 0;
    for (const e of edges) {
      mp += e.p;
      mv += e.v;
    }
    mp /= edges.length;
    mv /= edges.length;
    let spv = 0;
    let spp = 0;
    for (const e of edges) {
      spv += (e.p - mp) * (e.v - mv);
      spp += (e.p - mp) * (e.p - mp);
    }
    const b = spv / spp;
    fit = { a: mv - b * mp, b };
    if (!wasReady) {
      wasReady = true;
      if (onMappingReady) onMappingReady();
    }
  }

  function flush(reason) {
    const hadMapping = fit !== null || edges.length > 0;
    edges = [];
    lastRaw = null;
    fit = null;
    wasReady = false;
    if (hadMapping && onFlush) onFlush(reason);
  }

  function poll() {
    if (!player || destroyed) return;
    let stateNow;
    try {
      stateNow = player.getPlayerState();
    } catch {
      return;
    }
    if (stateNow !== PlayerState.PLAYING) return;
    const raw = player.getCurrentTime() * 1000;
    const p = performance.now();
    if (raw === lastRaw) return;
    lastRaw = raw;
    if (fit) {
      lastResidual = raw - (fit.a + fit.b * p);
      if (Math.abs(lastResidual) > RESIDUAL_LIMIT) {
        flush(`residual ${lastResidual.toFixed(0)}ms (seek/ad?)`);
        edges.push({ p, v: raw });
        return;
      }
    }
    edges.push({ p, v: raw });
    while (edges.length && p - edges[0].p > EDGE_WINDOW_MS) edges.shift();
    refit();
  }

  const readyPromise = loadIframeAPI().then(
    (YT) =>
      new Promise((resolve) => {
        player = new YT.Player(container, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            controls: 0,
            disablekb: 1,
            rel: 0,
            playsinline: 1,
            modestbranding: 1,
            iv_load_policy: 3,
          },
          events: {
            onReady: () => resolve(),
            onStateChange: (e) => {
              if (e.data !== PlayerState.PLAYING) flush(`state ${e.data}`);
              if (onStateChange) onStateChange(e.data);
            },
            onPlaybackRateChange: () => {
              // Scoring assumes 1×; force it back.
              try {
                player.setPlaybackRate(1);
              } catch {}
              flush('rate change');
            },
            onError: (e) => {
              if (onError) onError(e.data);
            },
          },
        });
      })
  );

  pollTimer = setInterval(poll, POLL_MS);

  return {
    ready: readyPromise,
    get player() {
      return player;
    },
    isMappingReady: () => fit !== null,
    videoTimeAt(perfMs) {
      return fit ? fit.a + fit.b * perfMs : null;
    },
    perfTimeAt(videoMs) {
      return fit && fit.b !== 0 ? (videoMs - fit.a) / fit.b : null;
    },
    debugInfo() {
      return {
        ready: fit !== null,
        slope: fit ? fit.b : 0,
        edges: edges.length,
        lastResidual,
      };
    },
    play() {
      try {
        player.playVideo();
      } catch {}
    },
    pause() {
      try {
        player.pauseVideo();
      } catch {}
    },
    mute() {
      try {
        player.mute();
      } catch {}
    },
    unMute() {
      try {
        player.unMute();
      } catch {}
    },
    getPlayerState() {
      try {
        return player ? player.getPlayerState() : PlayerState.UNSTARTED;
      } catch {
        return PlayerState.UNSTARTED;
      }
    },
    destroy() {
      destroyed = true;
      clearInterval(pollTimer);
      try {
        if (player) player.destroy();
      } catch {}
      player = null;
    },
  };
}

// A videoless "internal" clock for Freeplay mode, where the player listens to
// audio from somewhere else. There's nothing to sync to, so video time is just
// real time elapsed while playing. It implements the same surface as
// createVideoClock so the game view can use either interchangeably. Pausing
// freezes the clock (it can't pause the user's external audio), so resuming
// keeps grid phase continuous — re-lock if the audio has drifted.
export function createInternalClock({ onStateChange } = {}) {
  let running = false;
  let baseVid = 0; // vid ms accumulated before the current play segment
  let segStart = 0; // performance.now() when the current segment began
  let state = PlayerState.CUED;
  let destroyed = false;

  const vidAt = (perfMs) => (running ? baseVid + (perfMs - segStart) : baseVid);
  function setState(s) {
    state = s;
    if (onStateChange) onStateChange(s);
  }

  return {
    ready: Promise.resolve(),
    get player() {
      return null;
    },
    isMappingReady: () => true,
    videoTimeAt: (perfMs) => vidAt(perfMs),
    perfTimeAt: (vidMs) => (running ? segStart + (vidMs - baseVid) : null),
    debugInfo: () => ({ ready: true, slope: 1, edges: 0, lastResidual: 0 }),
    play() {
      if (destroyed || running) return;
      segStart = performance.now();
      running = true;
      setState(PlayerState.PLAYING);
    },
    pause() {
      if (destroyed || !running) return;
      baseVid = vidAt(performance.now());
      running = false;
      setState(PlayerState.PAUSED);
    },
    mute() {},
    unMute() {},
    getPlayerState() {
      return state;
    },
    destroy() {
      destroyed = true;
      running = false;
    },
  };
}
