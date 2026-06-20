// Dashboard: aggregate stats, accuracy trend, per-song bests, session history.

import { getData, deleteSession } from '../storage.js';
import { findSong } from '../songs.js';
import { drawHistogram, drawTrendChart } from '../charts.js';
import { HISTOGRAM_BINS } from '../engine.js';

export function render(el) {
  const data = getData();
  const sessions = [...data.sessions].sort((a, b) => a.date - b.date);

  if (!sessions.length) {
    el.innerHTML = `
      <h1>Dashboard</h1>
      <p class="hint">No sessions yet. <a href="#/select">Play a song</a> and your stats will show up here.</p>
    `;
    return;
  }

  const last10 = sessions.slice(-10);
  const avg10 = last10.reduce((a, s) => a + s.accuracy, 0) / last10.length;
  const best = sessions.reduce((a, s) => (s.accuracy > a.accuracy ? s : a));
  const totalTaps = sessions.reduce((a, s) => a + (s.tapCount || 0), 0);

  const blindSessions = sessions.filter((s) => s.blind);
  const bestBlindStreak = Math.max(0, ...blindSessions.map((s) => s.blind.longestStreak || 0));
  const bestSurvival = Math.max(0, ...blindSessions.map((s) => s.blind.beatsSurvived || 0));

  const aggHist = new Array(HISTOGRAM_BINS).fill(0);
  for (const s of sessions.slice(-20)) {
    if (Array.isArray(s.histogram)) s.histogram.forEach((v, i) => (aggHist[i] += v));
  }

  const bestBySong = new Map();
  for (const s of sessions) {
    const cur = bestBySong.get(s.songId);
    if (!cur || s.accuracy > cur.accuracy) bestBySong.set(s.songId, s);
  }

  el.innerHTML = `
    <h1>Dashboard</h1>
    <div class="stat-cards">
      <div class="stat-card"><span class="sb-label">Sessions</span><span class="stat-big">${sessions.length}</span></div>
      <div class="stat-card"><span class="sb-label">Taps scored</span><span class="stat-big">${totalTaps.toLocaleString()}</span></div>
      <div class="stat-card"><span class="sb-label">Best accuracy</span><span class="stat-big">${best.accuracy.toFixed(1)}%</span></div>
      <div class="stat-card"><span class="sb-label">Avg (last 10)</span><span class="stat-big">${avg10.toFixed(1)}%</span></div>
      <div class="stat-card"><span class="sb-label">👁 Best blind streak</span><span class="stat-big">${bestBlindStreak}</span></div>
      ${bestSurvival ? `<div class="stat-card"><span class="sb-label">👁 Survival record</span><span class="stat-big">${bestSurvival} beats</span></div>` : ''}
    </div>

    <h2>Accuracy trend</h2>
    <canvas class="chart" id="trendChart"></canvas>

    <h2>Timing distribution (last 20 sessions)</h2>
    <canvas class="chart" id="aggHist"></canvas>

    <h2>Per-song bests</h2>
    <table class="session-table">
      <thead><tr><th>Song</th><th>Grade</th><th>Accuracy</th><th>Score</th></tr></thead>
      <tbody>
        ${[...bestBySong.values()]
          .sort((a, b) => b.accuracy - a.accuracy)
          .map((s) => {
            const song = findSong(s.songId, data.customSongs);
            return `<tr>
              <td>${esc(song ? song.title : s.songId)}</td>
              <td><span class="grade-chip grade-${s.grade}">${s.grade}</span></td>
              <td>${s.accuracy.toFixed(1)}%</td>
              <td>${s.score.toLocaleString()}</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>

    <h2>Recent sessions</h2>
    <table class="session-table">
      <thead><tr><th>Date</th><th>Song</th><th>Mode</th><th>Grade</th><th>Acc</th><th>Mean</th><th>σ</th><th>Verdict</th><th></th></tr></thead>
      <tbody>
        ${sessions
          .slice(-15)
          .reverse()
          .map((s) => {
            const song = findSong(s.songId, data.customSongs);
            const verdict = s.driftSlope > 0.5 ? 'drag' : s.driftSlope < -0.5 ? 'rush' : 'steady';
            return `<tr>
              <td>${new Date(s.date).toLocaleDateString()}</td>
              <td>${esc(song ? song.title : s.songId)}</td>
              <td>${s.blindMode && s.blindMode !== 'off' ? `👁 ${s.blindMode}` : '—'}</td>
              <td><span class="grade-chip grade-${s.grade}">${s.grade}</span></td>
              <td>${s.accuracy.toFixed(1)}%</td>
              <td>${s.meanDelta > 0 ? '+' : ''}${s.meanDelta}ms</td>
              <td>±${s.stdDev}ms</td>
              <td>${verdict}</td>
              <td><button class="row-del" data-id="${esc(s.id)}" title="Delete this session">×</button></td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>
  `;

  drawTrendChart(el.querySelector('#trendChart'), sessions.map((s) => s.accuracy));
  drawHistogram(el.querySelector('#aggHist'), aggHist);

  el.querySelectorAll('.row-del').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (confirm('Delete this session from your history?')) {
        deleteSession(btn.dataset.id);
        render(el);
      }
    })
  );
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
