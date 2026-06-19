// Song select view: seed catalog + custom songs + add-song form.

import { SEED_SONGS, parseYouTubeId } from '../songs.js';
import { getData, update, newId } from '../storage.js';

export function render(el) {
  const data = getData();
  const customs = data.customSongs;

  el.innerHTML = `
    <h1>Pick a song</h1>
    <p class="hint">Tap along on the beat — Space, F/J keys, or the tap pad under the video.</p>
    <a class="freeplay-card" href="#/freeplay">
      <div class="freeplay-card-icon">🎧</div>
      <div>
        <div class="freeplay-card-title">Freeplay — no video</div>
        <div class="freeplay-card-sub">Already listening elsewhere? Set a tempo and play along to your own audio.</div>
      </div>
    </a>
    <div class="song-grid" id="songGrid"></div>
    <details class="add-song">
      <summary>+ Add custom song</summary>
      <form id="addSongForm" class="form-grid">
        <label>YouTube URL or video ID <input name="url" required placeholder="https://www.youtube.com/watch?v=…"></label>
        <label>Title <input name="title" required placeholder="Song title"></label>
        <label>Artist <input name="artist" required placeholder="Artist"></label>
        <label>BPM <input name="bpm" type="number" min="40" max="240" step="0.1" required placeholder="120"></label>
        <button type="submit" class="btn primary">Add song</button>
        <span class="form-error" id="addSongError"></span>
      </form>
    </details>
  `;

  const grid = el.querySelector('#songGrid');
  const bestBySong = {};
  for (const s of data.sessions) {
    if (!bestBySong[s.songId] || s.accuracy > bestBySong[s.songId]) bestBySong[s.songId] = s.accuracy;
  }

  for (const song of [...SEED_SONGS, ...customs]) {
    const card = document.createElement('a');
    card.className = 'song-card';
    card.href = `#/game/${encodeURIComponent(song.id)}`;
    const best = bestBySong[song.id];
    card.innerHTML = `
      <div class="song-tag">${song.tag || 'Custom'}</div>
      <div class="song-title">${escapeHtml(song.title)}</div>
      <div class="song-artist">${escapeHtml(song.artist)}</div>
      <div class="song-meta">
        <span class="song-bpm">${song.bpm} BPM</span>
        ${best != null ? `<span class="song-best">best ${best.toFixed(1)}%</span>` : ''}
      </div>
      ${song.id.startsWith('c_') ? '<button class="song-delete" title="Remove song">×</button>' : ''}
    `;
    const del = card.querySelector('.song-delete');
    if (del) {
      del.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (confirm(`Remove "${song.title}"?`)) {
          update((d) => {
            d.customSongs = d.customSongs.filter((c) => c.id !== song.id);
          });
          render(el);
        }
      });
    }
    grid.appendChild(card);
  }

  el.querySelector('#addSongForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const err = el.querySelector('#addSongError');
    const videoId = parseYouTubeId(f.get('url'));
    if (!videoId) {
      err.textContent = "Couldn't parse a YouTube video ID from that.";
      return;
    }
    const bpm = parseFloat(f.get('bpm'));
    if (!(bpm >= 40 && bpm <= 240)) {
      err.textContent = 'BPM must be between 40 and 240.';
      return;
    }
    update((d) => {
      d.customSongs.push({
        id: newId('c'),
        title: String(f.get('title')).trim(),
        artist: String(f.get('artist')).trim(),
        bpm,
        videoId,
        createdAt: Date.now(),
      });
    });
    render(el);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
