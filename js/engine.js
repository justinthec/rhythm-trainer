// engine.js — pure beat-grid anchoring + tap scoring. No DOM, no timers, no I/O.
// All times are milliseconds in *video time*. The caller is responsible for
// converting tap timestamps from performance time to video time and for
// subtracting the user's input offset BEFORE calling addTap().

export const RATINGS = ['perfect', 'good', 'okay', 'miss'];

export const BASE_POINTS = { perfect: 100, good: 60, okay: 25, miss: 0 };

export const HISTOGRAM_BINS = 18; // -135..+135ms, 15ms per bin
export const HISTOGRAM_RANGE = 135;

const DRIFT_ALPHA = 0.05; // slow phase correction per scored tap
const ANCHOR_MIN_RESULTANT = 0.85; // circular-mean concentration required to lock

export function timingWindows(bpm) {
  const T = 60000 / bpm;
  // Cap windows well below T/2 so a tap can never be ambiguous between
  // two adjacent beats; ordering perfect <= good <= okay is preserved.
  const okay = Math.min(135, 0.45 * T);
  const good = Math.min(90, okay);
  const perfect = Math.min(40, good);
  return { perfect, good, okay };
}

export function classifyDelta(delta, windows) {
  const a = Math.abs(delta);
  if (a <= windows.perfect) return 'perfect';
  if (a <= windows.good) return 'good';
  if (a <= windows.okay) return 'okay';
  return 'miss';
}

// Circular mean of tap times modulo the beat period. Returns the phase
// (0 <= phi < T) and the resultant length R (1 = perfectly concentrated).
export function circularMeanPhase(taps, T) {
  let sinSum = 0;
  let cosSum = 0;
  for (const t of taps) {
    const theta = (2 * Math.PI * (((t % T) + T) % T)) / T;
    sinSum += Math.sin(theta);
    cosSum += Math.cos(theta);
  }
  const R = Math.hypot(sinSum, cosSum) / taps.length;
  let phase = (Math.atan2(sinSum, cosSum) / (2 * Math.PI)) * T;
  if (phase < 0) phase += T;
  return { phase, R };
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

// OLS slope of y on x, plus Pearson r. Returns { slope, r }.
export function linearRegression(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, r: 0 };
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
    syy += (ys[i] - my) * (ys[i] - my);
  }
  if (sxx === 0 || syy === 0) return { slope: 0, r: 0 };
  return { slope: sxy / sxx, r: sxy / Math.sqrt(sxx * syy) };
}

export function gradeFor(accuracy) {
  if (accuracy >= 95) return 'S';
  if (accuracy >= 88) return 'A';
  if (accuracy >= 75) return 'B';
  if (accuracy >= 60) return 'C';
  return 'D';
}

// Verdict on rushing/dragging from the slope of raw deltas over time.
// slope is ms of lateness per second of song. Needs enough taps and a
// real correlation before it claims anything.
export function trendVerdict(slope, r, tapCount) {
  if (tapCount < 16 || Math.abs(r) < 0.3) return 'steady';
  if (slope > 0.5) return 'dragging';
  if (slope < -0.5) return 'rushing';
  return 'steady';
}

export function createEngine({ bpm, anchorTapCount = 8 }) {
  const T = 60000 / bpm;
  const windows = timingWindows(bpm);
  const refractory = Math.max(120, T / 4);

  let state = 'anchoring'; // 'anchoring' | 'tracking'
  let anchorTaps = [];
  let phi = null; // current grid phase (drift-corrected)
  let phi0 = null; // phase at lock time (raw grid for trend analysis)
  let driftFrozen = false; // true inside blind windows

  let lastTapAt = null;
  const scoredBeats = new Set();
  const taps = []; // { t, delta, rawDelta, rating, blind, beatIndex }

  let score = 0;
  let combo = 0;
  let bestCombo = 0;
  let baseSum = 0;
  let scoredTapCount = 0;
  const counts = { perfect: 0, good: 0, okay: 0, miss: 0, extra: 0 };
  const histogram = new Array(HISTOGRAM_BINS).fill(0);

  // Blind ("Flying Blind") bookkeeping
  let blindBaseSum = 0;
  let blindScoredCount = 0;
  let blindStreak = 0;
  let blindBestStreak = 0;

  function beatIndexFor(t) {
    return Math.round((t - phi) / T);
  }

  function lockOn() {
    const { phase, R } = circularMeanPhase(anchorTaps, T);
    if (R < ANCHOR_MIN_RESULTANT) {
      anchorTaps = [];
      return { type: 'anchor-failed', resultant: R };
    }
    // Express the phase near the first anchor tap so beat indices stay small.
    const first = anchorTaps[0];
    phi = phase + Math.round((first - phase) / T) * T;
    phi0 = phi;
    state = 'tracking';
    return { type: 'locked', phase: phi, resultant: R };
  }

  function addTap(t, { blind = false } = {}) {
    if (lastTapAt !== null && t - lastTapAt < refractory) {
      return { type: 'ignored' };
    }
    lastTapAt = t;

    if (state === 'anchoring') {
      anchorTaps.push(t);
      if (anchorTaps.length >= anchorTapCount) return lockOn();
      return { type: 'anchor', count: anchorTaps.length, needed: anchorTapCount };
    }

    const k = beatIndexFor(t);
    const delta = t - (phi + k * T);
    const rawDelta = delta + (phi - phi0); // relative to the un-corrected grid

    if (scoredBeats.has(k)) {
      counts.extra++;
      return { type: 'extra', beatIndex: k, delta };
    }
    scoredBeats.add(k);

    const rating = classifyDelta(delta, windows);
    counts[rating]++;
    scoredTapCount++;

    const bin = Math.min(
      HISTOGRAM_BINS - 1,
      Math.max(0, Math.floor(((delta + HISTOGRAM_RANGE) / (2 * HISTOGRAM_RANGE)) * HISTOGRAM_BINS))
    );
    histogram[bin]++;

    if (rating === 'perfect' || rating === 'good') {
      combo++;
      bestCombo = Math.max(bestCombo, combo);
    } else {
      combo = 0;
    }
    const base = BASE_POINTS[rating];
    const multiplier = 1 + Math.min(combo, 50) / 50;
    const points = Math.round(base * multiplier * (blind ? 1.5 : 1));
    score += points;
    baseSum += base;

    if (blind) {
      blindBaseSum += base;
      blindScoredCount++;
      if (rating !== 'miss') {
        blindStreak++;
        blindBestStreak = Math.max(blindBestStreak, blindStreak);
      } else {
        blindStreak = 0;
      }
    }

    // Slow drift correction keeps the grid glued to the real song tempo,
    // but never while blind (it would absorb exactly the drift we measure).
    if (!blind && !driftFrozen && Math.abs(delta) <= windows.good) {
      phi += DRIFT_ALPHA * delta;
    }

    taps.push({ t, delta, rawDelta, rating, blind, beatIndex: k });
    return { type: 'tap', rating, delta, beatIndex: k, points, combo, blind };
  }

  function getStats() {
    const rated = taps.filter((x) => x.rating !== 'miss');
    const deltas = rated.map((x) => x.delta);
    const reg = linearRegression(
      taps.map((x) => x.t / 1000),
      taps.map((x) => x.rawDelta)
    );
    const accuracy = scoredTapCount ? (baseSum / (100 * scoredTapCount)) * 100 : 0;

    const blindTaps = taps.filter((x) => x.blind);
    const blind = blindTaps.length
      ? {
          tapCount: blindTaps.length,
          accuracy: blindScoredCount ? (blindBaseSum / (100 * blindScoredCount)) * 100 : 0,
          longestStreak: blindBestStreak,
        }
      : null;

    return {
      score,
      accuracy,
      grade: gradeFor(accuracy),
      meanDelta: mean(deltas),
      stdDev: stddev(deltas),
      driftSlope: reg.slope,
      driftR: reg.r,
      verdict: trendVerdict(reg.slope, reg.r, taps.length),
      tapCount: scoredTapCount,
      bestCombo,
      counts: { ...counts },
      histogram: histogram.slice(),
      blind,
    };
  }

  return {
    get state() {
      return state;
    },
    get phase() {
      return phi;
    },
    get period() {
      return T;
    },
    get windows() {
      return windows;
    },
    get anchorProgress() {
      return anchorTaps.length;
    },
    setDriftFrozen(frozen) {
      driftFrozen = frozen;
    },
    beatIndexFor,
    beatTime(k) {
      return phi + k * T;
    },
    addTap,
    getStats,
  };
}
