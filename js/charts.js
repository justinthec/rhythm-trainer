// charts.js — small canvas renderers (no dependencies).

import { HISTOGRAM_BINS, HISTOGRAM_RANGE, BASE_POINTS } from './engine.js';

function prepCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

const COLORS = {
  axis: '#3a3f4d',
  text: '#8a90a3',
  early: '#5aa9ff',
  late: '#ffb454',
  center: '#3ddc84',
  line: '#3ddc84',
};

// Delta histogram: 18 bins over −135..+135ms, center line at 0.
export function drawHistogram(canvas, bins) {
  const { g, w, h } = prepCanvas(canvas);
  const padB = 18;
  const plotH = h - padB;
  const max = Math.max(1, ...bins);
  const bw = w / HISTOGRAM_BINS;
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    const bh = (bins[i] / max) * (plotH - 6);
    const binCenter = -HISTOGRAM_RANGE + (i + 0.5) * ((2 * HISTOGRAM_RANGE) / HISTOGRAM_BINS);
    g.fillStyle = binCenter < 0 ? COLORS.early : COLORS.late;
    g.fillRect(i * bw + 1, plotH - bh, bw - 2, bh);
  }
  g.strokeStyle = COLORS.center;
  g.setLineDash([4, 3]);
  g.beginPath();
  g.moveTo(w / 2, 0);
  g.lineTo(w / 2, plotH);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = COLORS.text;
  g.font = '11px system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillText('early', 4, h - 5);
  g.textAlign = 'center';
  g.fillText('0', w / 2, h - 5);
  g.textAlign = 'right';
  g.fillText('late', w - 4, h - 5);
}

// Accuracy over one session, with timing tendency. The green line is rolling
// accuracy (last 8 scored taps); the area under it is shaded by the rolling
// mean timing error — blue where the player rushed (early), orange where they
// dragged (late) — with intensity scaling to how far off the beat they were.
const TENDENCY_FULL_MS = 60; // |mean delta| at which the shade reaches full strength

export function drawAccuracyTimeline(canvas, timeline) {
  const { g, w, h } = prepCanvas(canvas);
  const padL = 30;
  const padB = 16;
  const plotW = w - padL - 6;
  const plotH = h - padB - 6;
  const top = 6;
  const bottom = top + plotH;

  g.strokeStyle = COLORS.axis;
  g.beginPath();
  g.moveTo(padL, top);
  g.lineTo(padL, bottom);
  g.lineTo(padL + plotW, bottom);
  g.stroke();
  g.fillStyle = COLORS.text;
  g.font = '10px system-ui, sans-serif';
  g.textAlign = 'right';
  for (const v of [0, 50, 100]) {
    const yv = bottom - (v / 100) * plotH;
    g.fillText(String(v), padL - 4, yv + 3);
  }
  if (timeline.length < 2) return;

  const t0 = timeline[0].t;
  const t1 = timeline[timeline.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const x = (t) => padL + ((t - t0) / span) * plotW;
  const y = (v) => bottom - (Math.max(0, Math.min(100, v)) / 100) * plotH;

  // Rolling accuracy + rolling mean delta over the last 8 scored taps.
  const WINDOW = 8;
  const acc = [];
  const delta = [];
  for (let i = 0; i < timeline.length; i++) {
    const from = Math.max(0, i - WINDOW + 1);
    let sumAcc = 0;
    let sumDelta = 0;
    for (let k = from; k <= i; k++) {
      sumAcc += BASE_POINTS[timeline[k].rating];
      sumDelta += timeline[k].delta;
    }
    const n = i - from + 1;
    acc.push(sumAcc / n);
    delta.push(sumDelta / n);
  }

  // Tendency fill: one shaded column per segment, color by rush/drag, alpha by
  // magnitude. Drawn first so the accuracy line and blind shading sit on top.
  for (let i = 1; i < timeline.length; i++) {
    const md = (delta[i - 1] + delta[i]) / 2;
    const mag = Math.min(1, Math.abs(md) / TENDENCY_FULL_MS);
    if (mag < 0.02) continue;
    const [r, gc, b] = md < 0 ? [90, 169, 255] : [255, 180, 84]; // early=blue, late=orange
    g.fillStyle = `rgba(${r}, ${gc}, ${b}, ${(0.12 + 0.45 * mag).toFixed(3)})`;
    g.beginPath();
    g.moveTo(x(timeline[i - 1].t), y(acc[i - 1]));
    g.lineTo(x(timeline[i].t), y(acc[i]));
    g.lineTo(x(timeline[i].t), bottom);
    g.lineTo(x(timeline[i - 1].t), bottom);
    g.closePath();
    g.fill();
  }

  // Mark blind stretches with a thin bracket at the top (kept neutral so it
  // doesn't read as a rush/drag color).
  g.strokeStyle = 'rgba(220, 225, 240, 0.5)';
  g.lineWidth = 2;
  for (let i = 0; i < timeline.length; ) {
    if (!timeline[i].blind) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < timeline.length && timeline[j + 1].blind) j++;
    g.beginPath();
    g.moveTo(x(timeline[i].t), top + 1);
    g.lineTo(x(timeline[j].t), top + 1);
    g.stroke();
    i = j + 1;
  }
  g.lineWidth = 1;

  // Accuracy line on top.
  g.strokeStyle = COLORS.line;
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i < timeline.length; i++) {
    const px = x(timeline[i].t);
    const py = y(acc[i]);
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.stroke();
  g.lineWidth = 1;

  // Legend (top-right): rush / drag swatches + accuracy line.
  drawTimelineLegend(g, padL + plotW, top + 2);

  // Time axis labels.
  const fmt = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  g.fillStyle = COLORS.text;
  g.font = '11px system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillText(fmt(t0), padL, h - 5);
  g.textAlign = 'right';
  g.fillText(fmt(t1), w - 4, h - 5);
}

function drawTimelineLegend(g, right, top) {
  g.font = '10px system-ui, sans-serif';
  g.textAlign = 'left';
  const items = [
    { color: 'rgba(90, 169, 255, 0.85)', label: 'rush' },
    { color: 'rgba(255, 180, 84, 0.85)', label: 'drag' },
  ];
  // Lay out right-aligned: measure total width first.
  const sw = 9;
  const gap = 4;
  const itemGap = 10;
  let total = 0;
  for (const it of items) total += sw + gap + g.measureText(it.label).width + itemGap;
  let cx = right - total;
  for (const it of items) {
    g.fillStyle = it.color;
    g.fillRect(cx, top, sw, sw);
    cx += sw + gap;
    g.fillStyle = COLORS.text;
    g.fillText(it.label, cx, top + sw - 1);
    cx += g.measureText(it.label).width + itemGap;
  }
}

// Accuracy trend over sessions: 0–100% line chart.
export function drawTrendChart(canvas, values) {
  const { g, w, h } = prepCanvas(canvas);
  const padL = 30;
  const padB = 16;
  const plotW = w - padL - 6;
  const plotH = h - padB - 6;
  g.strokeStyle = COLORS.axis;
  g.beginPath();
  g.moveTo(padL, 6);
  g.lineTo(padL, 6 + plotH);
  g.lineTo(padL + plotW, 6 + plotH);
  g.stroke();
  g.fillStyle = COLORS.text;
  g.font = '10px system-ui, sans-serif';
  g.textAlign = 'right';
  for (const v of [0, 50, 100]) {
    const y = 6 + plotH - (v / 100) * plotH;
    g.fillText(String(v), padL - 4, y + 3);
  }
  if (!values.length) return;
  const x = (i) => padL + (values.length === 1 ? plotW / 2 : (i / (values.length - 1)) * plotW);
  const y = (v) => 6 + plotH - (Math.max(0, Math.min(100, v)) / 100) * plotH;
  g.strokeStyle = COLORS.line;
  g.lineWidth = 2;
  g.beginPath();
  values.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))));
  g.stroke();
  g.fillStyle = COLORS.line;
  values.forEach((v, i) => {
    g.beginPath();
    g.arc(x(i), y(v), 2.5, 0, Math.PI * 2);
    g.fill();
  });
  g.lineWidth = 1;
}
