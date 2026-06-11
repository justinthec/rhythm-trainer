// calibration.js — input-offset calibration mini-game.
// Plays a precise metronome via Web Audio ("A Tale of Two Clocks" lookahead
// scheduling), records when the user taps, and measures the user's average
// lag (hardware + human) so the game can subtract it from every tap.

const CLICK_COUNT = 24;
const WARMUP_CLICKS = 4; // discarded — user is still finding the beat
const BPM = 90;
const LOOKAHEAD_MS = 100;
const SCHEDULER_MS = 25;
const MAX_ABS_DELTA = 200; // taps further than this from any click are noise
const MIN_VALID_TAPS = 12;

export function createCalibration({ onProgress, onFinish }) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const period = 60000 / BPM;

  let schedulerTimer = null;
  let nextClickAudio = 0; // seconds, audio clock
  let scheduledCount = 0;
  const clickPerfTimes = []; // perf-domain time of each click
  const tapPerfTimes = [];
  let finished = false;

  // Convert an audio-clock time (seconds) to the performance clock (ms).
  function audioToPerf(audioSec) {
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.performanceTime > 0) {
        return ts.performanceTime + (audioSec - ts.contextTime) * 1000;
      }
    }
    const latency = ctx.outputLatency ?? ctx.baseLatency ?? 0;
    return performance.now() + (audioSec + latency - ctx.currentTime) * 1000;
  }

  function scheduleClick(audioTime, isDownbeat) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = isDownbeat ? 1500 : 1000;
    gain.gain.setValueAtTime(0.0001, audioTime);
    gain.gain.exponentialRampToValueAtTime(0.5, audioTime + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioTime + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(audioTime);
    osc.stop(audioTime + 0.07);
  }

  function schedulerTick() {
    while (scheduledCount < CLICK_COUNT && nextClickAudio < ctx.currentTime + LOOKAHEAD_MS / 1000) {
      scheduleClick(nextClickAudio, scheduledCount % 4 === 0);
      clickPerfTimes.push(audioToPerf(nextClickAudio));
      scheduledCount++;
      nextClickAudio += period / 1000;
      if (onProgress) onProgress({ click: scheduledCount, total: CLICK_COUNT });
    }
    if (scheduledCount >= CLICK_COUNT) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
      // Allow the final click to play + a grace window for the last tap.
      const lastPerf = clickPerfTimes[clickPerfTimes.length - 1];
      const wait = Math.max(0, lastPerf - performance.now()) + 800;
      setTimeout(finish, wait);
    }
  }

  function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function finish() {
    if (finished) return;
    finished = true;
    try {
      ctx.close();
    } catch {}

    const validClicks = clickPerfTimes.slice(WARMUP_CLICKS);
    // Pair each tap with its nearest (non-warmup) click.
    let deltas = tapPerfTimes
      .map((tp) => {
        let best = Infinity;
        for (const cp of validClicks) {
          const d = tp - cp;
          if (Math.abs(d) < Math.abs(best)) best = d;
        }
        return best;
      })
      .filter((d) => Math.abs(d) <= MAX_ABS_DELTA);

    // Median/MAD outlier rejection.
    if (deltas.length >= 4) {
      const med = median(deltas);
      const mad = Math.max(5, median(deltas.map((d) => Math.abs(d - med))));
      deltas = deltas.filter((d) => Math.abs(d - med) <= 3 * 1.4826 * mad);
    }

    if (deltas.length < MIN_VALID_TAPS) {
      onFinish({ ok: false, validTaps: deltas.length, needed: MIN_VALID_TAPS });
      return;
    }
    const m = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const sd = Math.sqrt(deltas.reduce((a, d) => a + (d - m) * (d - m), 0) / (deltas.length - 1));
    onFinish({ ok: true, offset: Math.round(m), stdDev: Math.round(sd), validTaps: deltas.length });
  }

  return {
    async start() {
      await ctx.resume();
      nextClickAudio = ctx.currentTime + 0.3;
      schedulerTimer = setInterval(schedulerTick, SCHEDULER_MS);
    },
    tap(perfTime) {
      if (!finished) tapPerfTimes.push(perfTime);
    },
    cancel() {
      clearInterval(schedulerTimer);
      finished = true;
      try {
        ctx.close();
      } catch {}
    },
  };
}
