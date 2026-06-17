// mic.js — EXPERIMENTAL: detect claps from the microphone and fire onsets.
//
// Each animation frame we read the analyser's frequency spectrum and compute
// "spectral flux" — the sum of positive bin-to-bin increases since the previous
// frame. A clap is a sharp, broadband transient, so it produces a big flux
// spike that stands out from steady sound (talking, sustained music). An
// adaptive baseline tracks the ambient/music level so only sharper-than-ambient
// transients fire, and a refractory period prevents one clap double-triggering.
//
// Timing precision is limited by the FFT window (~23ms) + frame cadence, so
// this is coarser than clicking — fine for clapping along, not for 32nd notes.

const FFT = 1024;
const REFRACTORY_MS = 110; // shortest gap between two accepted claps
const BASELINE_DECAY = 0.92; // how fast the ambient-flux estimate adapts
const MIN_LEVEL = 0.04; // ignore near-silent frames (0..1)

export function createClapDetector({ onOnset, onLevel, onError, sensitivity = 0.5 } = {}) {
  let stream = null;
  let ctx = null;
  let analyser = null;
  let source = null;
  let raf = null;
  let prev = null;
  let baseline = 0;
  let lastOnset = 0;
  let running = false;
  let sens = clamp01(sensitivity);

  function frame() {
    if (!running || !analyser) return;
    const bins = analyser.frequencyBinCount;
    const spec = new Uint8Array(bins);
    analyser.getByteFrequencyData(spec);

    let flux = 0;
    let sum = 0;
    for (let i = 0; i < bins; i++) {
      const d = spec[i] - prev[i];
      if (d > 0) flux += d;
      sum += spec[i];
      prev[i] = spec[i];
    }
    const level = sum / bins / 255; // 0..1 average loudness

    baseline = baseline * BASELINE_DECAY + flux * (1 - BASELINE_DECAY);
    const now = performance.now();

    // sensitivity 0..1 → rise factor 3.0 (strict) .. 1.4 (loose), and a lower
    // absolute floor so quiet rooms still trigger at high sensitivity.
    const rise = 3.0 - 1.6 * sens;
    const floor = (1 - sens) * 800 + 120;
    const threshold = Math.max(baseline * rise, floor);

    if (flux > threshold && level > MIN_LEVEL && now - lastOnset > REFRACTORY_MS) {
      lastOnset = now;
      if (onOnset) onOnset(now, flux);
    }
    if (onLevel) onLevel(level, flux);
    raf = requestAnimationFrame(frame);
  }

  return {
    async start() {
      try {
        // echoCancellation helps strip bleed from speakers; noiseSuppression /
        // autoGain are OFF because they mangle the transients we rely on.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
        });
      } catch (err) {
        if (onError) onError(err);
        return false;
      }
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') await ctx.resume();
        source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = FFT;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        prev = new Uint8Array(analyser.frequencyBinCount);
        baseline = 0;
        lastOnset = 0;
        running = true;
        raf = requestAnimationFrame(frame);
        return true;
      } catch (err) {
        if (onError) onError(err);
        this.stop();
        return false;
      }
    },
    setSensitivity(v) {
      sens = clamp01(v);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      try {
        if (source) source.disconnect();
      } catch {}
      try {
        if (ctx) ctx.close();
      } catch {}
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      ctx = null;
      analyser = null;
      source = null;
      prev = null;
    },
  };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
