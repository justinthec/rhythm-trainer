// charts.js — small canvas renderers (no dependencies).

import { HISTOGRAM_BINS, HISTOGRAM_RANGE } from './engine.js';

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
