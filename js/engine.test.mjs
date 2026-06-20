// Run with: node js/engine.test.mjs
import {
  createEngine,
  circularMeanPhase,
  classifyDelta,
  timingWindows,
  linearRegression,
  gradeFor,
  trendVerdict,
} from './engine.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures++;
    console.error(`FAIL  ${msg}`);
  }
}
function approx(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg} (got ${a.toFixed(3)}, want ${b}±${tol})`);
}

// Deterministic PRNG so test runs are reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const jitter = (ms) => (rand() * 2 - 1) * ms;

console.log('— circular mean phase recovery —');
{
  const T = 60000 / 117; // ~512.8ms
  const truePhase = 123.4;
  const taps = [];
  for (let k = 10; k < 18; k++) taps.push(truePhase + k * T + jitter(15));
  const { phase, R } = circularMeanPhase(taps, T);
  const phaseErr = Math.abs((((phase - truePhase) % T) + T) % T);
  const wrapped = Math.min(phaseErr, T - phaseErr);
  approx(wrapped, 0, 8, 'recovers phase from 8 jittered taps');
  assert(R > 0.95, `resultant high for clean taps (R=${R.toFixed(3)})`);
}
{
  // Wrap-straddle case: true phase right at the modulo boundary (0/T).
  const T = 500;
  const taps = [];
  for (let k = 4; k < 12; k++) taps.push(0.5 + k * T + jitter(20));
  const { phase } = circularMeanPhase(taps, T);
  const err = Math.min(phase, T - phase);
  approx(err, 0.5, 10, 'handles phase at wrap point');
}
{
  // Random taps must NOT lock.
  const T = 500;
  const taps = [];
  for (let i = 0; i < 8; i++) taps.push(rand() * 10000);
  const { R } = circularMeanPhase(taps, T);
  assert(R < 0.85, `random taps give low resultant (R=${R.toFixed(3)})`);
}

console.log('— window classification —');
{
  const w = timingWindows(117); // T≈512.8 → windows stay 40/90/135
  assert(classifyDelta(0, w) === 'perfect', 'delta 0 → perfect');
  assert(classifyDelta(-40, w) === 'perfect', 'delta -40 → perfect');
  assert(classifyDelta(41, w) === 'good', 'delta +41 → good');
  assert(classifyDelta(-90, w) === 'good', 'delta -90 → good');
  assert(classifyDelta(91, w) === 'okay', 'delta +91 → okay');
  assert(classifyDelta(-135, w) === 'okay', 'delta -135 → okay');
  assert(classifyDelta(136, w) === 'miss', 'delta +136 → miss');
}
{
  const w = timingWindows(200); // T=300 → okay capped at 135
  assert(w.okay <= 150, 'okay window stays below half-period at 200bpm');
  assert(w.perfect <= w.good && w.good <= w.okay, 'window ordering preserved');
}

console.log('— full engine: anchor + score —');
{
  const bpm = 117;
  const T = 60000 / bpm;
  const phase = 1000;
  const eng = createEngine({ bpm, anchorTapCount: 8 });

  let lockRes = null;
  for (let k = 0; k < 8; k++) {
    lockRes = eng.addTap(phase + k * T + jitter(12));
  }
  assert(lockRes.type === 'locked', 'locks after 8 anchor taps');
  approx(eng.phase % T, phase % T, 6, 'locked phase within ~6ms of truth');

  // Tap 30 more beats nearly on the grid → high accuracy.
  let last = null;
  for (let k = 8; k < 38; k++) {
    last = eng.addTap(phase + k * T + jitter(10));
  }
  assert(last.type === 'tap', 'taps scored after lock');
  const stats = eng.getStats();
  assert(stats.accuracy > 95, `clean taps score >95% (got ${stats.accuracy.toFixed(1)})`);
  assert(stats.grade === 'S', 'grade S for clean run');
  assert(stats.counts.miss === 0, 'no misses on clean run');
}
{
  // Early/late signs.
  const bpm = 120;
  const T = 500;
  const eng = createEngine({ bpm, anchorTapCount: 4 });
  for (let k = 0; k < 4; k++) eng.addTap(1000 + k * T);
  const early = eng.addTap(1000 + 4 * T - 60);
  approx(early.delta, -60, 3, 'early tap has negative delta');
  const late = eng.addTap(1000 + 5 * T + 60);
  assert(late.delta > 50, 'late tap has positive delta');
  assert(early.rating === 'good' && late.rating === 'good', '±60ms rated good');
}
{
  // Refractory + duplicate-beat handling.
  const eng = createEngine({ bpm: 120, anchorTapCount: 4 });
  for (let k = 0; k < 4; k++) eng.addTap(1000 + k * 500);
  eng.addTap(1000 + 4 * 500);
  const tooSoon = eng.addTap(1000 + 4 * 500 + 50);
  assert(tooSoon.type === 'ignored', 'tap 50ms after previous is ignored');
  const dup = eng.addTap(1000 + 4 * 500 + 130); // past refractory, same beat
  assert(dup.type === 'extra', 'second tap on same beat counts as extra');
}

console.log('— drift correction tracks real tempo error —');
{
  // Song really plays 0.3% faster than nominal: T_real = T * 0.997.
  const bpm = 117;
  const T = 60000 / bpm;
  const Treal = T * 0.997;
  const eng = createEngine({ bpm, anchorTapCount: 8 });
  for (let k = 0; k < 8; k++) eng.addTap(1000 + k * Treal);
  const ratings = [];
  for (let k = 8; k < 120; k++) {
    const r = eng.addTap(1000 + k * Treal + jitter(8));
    if (r.type === 'tap') ratings.push(r.rating);
  }
  const lateMisses = ratings.filter((r) => r === 'miss').length;
  assert(lateMisses === 0, `grid tracks 0.3% tempo error without misses (${lateMisses} misses)`);
  const tail = ratings.slice(-20);
  assert(
    tail.every((r) => r === 'perfect' || r === 'good'),
    'late-session taps still rated good+ thanks to drift correction'
  );
}

console.log('— frozen drift (blind windows) exposes user drift —');
{
  // User drifts +2ms per beat while blind; frozen grid must report it.
  const bpm = 120;
  const T = 500;
  const eng = createEngine({ bpm, anchorTapCount: 4 });
  for (let k = 0; k < 4; k++) eng.addTap(1000 + k * T);
  eng.setDriftFrozen(true);
  let lastDelta = 0;
  for (let i = 1; i <= 16; i++) {
    const r = eng.addTap(1000 + (3 + i) * T + 2 * i, { blind: true });
    lastDelta = r.delta;
  }
  approx(lastDelta, 32, 2, 'cumulative +2ms/beat drift visible after 16 blind beats');
  const stats = eng.getStats();
  assert(stats.blind && stats.blind.tapCount === 16, 'blind taps tracked separately');
  assert(stats.blind.longestStreak === 16, 'blind streak counts consecutive non-misses');
}

console.log('— trend regression —');
{
  const xs = [];
  const ys = [];
  for (let i = 0; i < 40; i++) {
    xs.push(i * 0.5); // seconds
    ys.push(1.0 * (i * 0.5) + jitter(4)); // 1 ms/s drift
  }
  const { slope, r } = linearRegression(xs, ys);
  approx(slope, 1.0, 0.3, 'recovers 1 ms/s drift slope');
  assert(trendVerdict(slope, r, 40) === 'dragging', 'positive slope → dragging');
  assert(trendVerdict(-slope, -r, 40) === 'rushing', 'negative slope → rushing');
  assert(trendVerdict(slope, r, 10) === 'steady', 'too few taps → steady');
}

console.log('— grid adapts to tapped subdivision —');
{
  // HUMBLE. scenario: listed 75 BPM (T=800) but tapped at 150 BPM (400ms).
  const eng = createEngine({ bpm: 75, anchorTapCount: 8 });
  let res = null;
  for (let k = 0; k < 8; k++) res = eng.addTap(1000 + k * 400 + jitter(15));
  assert(res.type === 'locked', 'double-time taps lock');
  assert(res.gridBpm === 150, `grid locks at 150 BPM (got ${res.gridBpm})`);
  approx(eng.period, 400, 1, 'effective period is the tapped subdivision');
  const scored = eng.addTap(1000 + 8 * 400 + 10);
  assert(scored.type === 'tap' && scored.rating !== 'miss', 'scoring works on the adapted grid');
}
{
  // Half-time tapping: listed 150 BPM (T=400) but tapped every 800ms.
  const eng = createEngine({ bpm: 150, anchorTapCount: 8 });
  let res = null;
  for (let k = 0; k < 8; k++) res = eng.addTap(500 + k * 800 + jitter(15));
  assert(res.type === 'locked' && res.gridBpm === 75, 'half-time taps lock at 75 BPM');
}
{
  // Tapped period that matches no clean ratio of the base tempo must fail.
  const eng = createEngine({ bpm: 100, anchorTapCount: 8 }); // T=600
  let res = null;
  for (let k = 0; k < 8; k++) res = eng.addTap(500 + k * 437);
  assert(res.type === 'anchor-failed', 'off-ratio tempo fails to lock');
}
{
  // Two-handed 32nds: 75 BPM listed, tapping every 100ms (1/8 of the period).
  const eng = createEngine({ bpm: 75, anchorTapCount: 8 });
  let res = null;
  for (let k = 0; k < 8; k++) res = eng.addTap(1000 + k * 100 + jitter(8));
  assert(res.type === 'locked', '32nd-note taps lock');
  assert(res.gridBpm === 600, `grid locks at 600 BPM (got ${res.gridBpm})`);
  const scored = eng.addTap(1000 + 8 * 100 + 5);
  assert(scored.type === 'tap' && scored.rating !== 'miss', '32nd taps are scored');
}
{
  // Subdivisions faster than MIN_GRID_PERIOD are rejected: 16ths at 171 BPM
  // ≈ 88ms — fast enough to pass the refractory, too fast for a grid.
  const eng = createEngine({ bpm: 171, anchorTapCount: 8 });
  let res = null;
  for (let k = 0; k < 8; k++) res = eng.addTap(500 + (k * 60000) / 171 / 4);
  assert(res.type === 'anchor-failed', 'untappably fast subdivision rejected');
}

console.log('— re-anchor keeps score, replaces grid —');
{
  const eng = createEngine({ bpm: 120, anchorTapCount: 4 }); // T=500
  for (let k = 0; k < 4; k++) eng.addTap(1000 + k * 500);
  eng.addTap(1000 + 4 * 500 + 30); // one scored tap
  const before = eng.getStats();
  eng.reAnchor();
  assert(eng.state === 'anchoring', 're-anchor returns to anchoring');
  let res = null;
  for (let k = 0; k < 4; k++) res = eng.addTap(4000 + k * 500 + 250); // new phase, +250ms
  assert(res.type === 'locked', 'locks again after re-anchor');
  const after = eng.getStats();
  assert(after.score === before.score && after.tapCount === before.tapCount, 'score and stats preserved');
  const t2 = eng.addTap(4000 + 4 * 500 + 250);
  assert(t2.type === 'tap' && t2.rating === 'perfect', 'taps score perfectly on the new grid');
}

console.log('— polyrhythm: triplets register over a 4/4 grid —');
{
  // Lock onto quarters at 120 BPM (T=500). baseT/3 ≈ 166.7ms triplet grid.
  const eng = createEngine({ bpm: 120, anchorTapCount: 8, polyrhythm: true });
  for (let k = 0; k < 8; k++) eng.addTap(k * 500 + jitter(8));
  const Ttri = 500 / 3;
  const ratings = [];
  for (let i = 0; i < 6; i++) {
    const r = eng.addTap(4000 + i * Ttri + jitter(6)); // eighth-note triplets across 2 beats
    if (r.type === 'tap') ratings.push(r.rating);
  }
  assert(ratings.length === 6, 'all 6 triplet taps are scored (not deduped away)');
  assert(ratings.every((r) => r !== 'miss'), 'triplet taps land on the triplet grid (no misses)');

  // Same triplets WITHOUT polyrhythm: most should miss the quarter grid.
  const eng2 = createEngine({ bpm: 120, anchorTapCount: 8 }); // poly off
  for (let k = 0; k < 8; k++) eng2.addTap(k * 500 + jitter(8));
  let offGrid = 0;
  for (let i = 0; i < 6; i++) {
    const r = eng2.addTap(4000 + i * Ttri + jitter(6));
    if (r.type === 'miss' || r.rating === 'miss' || r.type === 'extra') offGrid++;
  }
  assert(offGrid >= 3, `without polyrhythm, triplets mostly fail the grid (${offGrid}/6 off)`);

  // Polyrhythm must not wreck plain on-grid quarter tapping.
  const eng3 = createEngine({ bpm: 120, anchorTapCount: 8, polyrhythm: true });
  for (let k = 0; k < 8; k++) eng3.addTap(k * 500 + jitter(8));
  let q = null;
  for (let k = 8; k < 28; k++) q = eng3.addTap(k * 500 + jitter(8));
  assert(q.type === 'tap' && q.rating !== 'miss', 'on-grid quarter taps still score with poly on');
}

console.log('— grades —');
{
  assert(gradeFor(95) === 'S' && gradeFor(94.9) === 'A', 'S/A boundary');
  assert(gradeFor(88) === 'A' && gradeFor(75) === 'B', 'A/B boundaries');
  assert(gradeFor(60) === 'C' && gradeFor(59) === 'D', 'C/D boundary');
}

if (failures) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll engine tests passed.');
}
