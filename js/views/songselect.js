// Song select view: seed catalog + custom songs + add-song form.

import { SEED_SONGS, parseYouTubeId } from '../songs.js';
import { getData, update, newId } from '../storage.js';
import { searchSongBpm, fetchTempo, searchYouTube, hasBpmKey, hasYouTubeKey, GETSONGBPM_CREDIT } from '../lookup.js';

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
      <div class="song-search">
        <input type="text" id="addSearch" placeholder="Search a song name to auto-fill BPM + find the video…">
        <button class="btn" id="addSearchBtn" type="button">Search</button>
      </div>
      <div class="song-search-results" id="addSearchResults"></div>
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

  const searchInput = el.querySelector('#addSearch');
  const runSearch = () => searchToFill(el, searchInput.value);
  el.querySelector('#addSearchBtn').addEventListener('click', runSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });
}

// One search → two providers. BPM rows fill title/artist/BPM; video rows fill
// the URL. Top matches auto-fill so a single search + Add works in the common
// case, but each list stays clickable to correct a wrong guess.
async function searchToFill(el, query) {
  const out = el.querySelector('#addSearchResults');
  if (!query.trim()) return;
  if (!hasBpmKey() && !hasYouTubeKey()) {
    out.innerHTML = `<p class="form-error">Add a GetSongBPM and/or YouTube Data API key in <a href="#/settings">Settings</a> first.</p>`;
    return;
  }
  const form = el.querySelector('#addSongForm');
  const setField = (name, value) => {
    const input = form.querySelector(`[name=${name}]`);
    if (input && value != null && value !== '') input.value = value;
  };
  out.innerHTML = '<p class="hint">Searching…</p>';

  const [bpm, yt] = await Promise.allSettled([
    hasBpmKey() ? searchSongBpm(query) : Promise.resolve([]),
    hasYouTubeKey() ? searchYouTube(query) : Promise.resolve([]),
  ]);

  let html = '';
  // --- BPM results ---
  if (hasBpmKey()) {
    if (bpm.status === 'rejected') {
      html += `<p class="form-error">${escapeHtml(bpm.reason.message)}</p>`;
    } else if (!bpm.value.length) {
      html += '<p class="hint">No BPM matches.</p>';
    } else {
      const top = bpm.value[0];
      setField('title', top.title);
      setField('artist', top.artist);
      if (top.tempo) setField('bpm', top.tempo);
      html +=
        '<div class="song-search-group"><span class="song-search-label">Tempo</span>' +
        bpm.value
          .slice(0, 5)
          .map(
            (r, i) =>
              `<button class="song-result bpm-result${i === 0 ? ' selected' : ''}" type="button" data-i="${i}">
                 <span class="song-result-name">${escapeHtml(r.title)}${r.artist ? ` · ${escapeHtml(r.artist)}` : ''}</span>
                 <span class="song-result-bpm">${r.tempo ? `${r.tempo} BPM` : 'BPM…'}</span>
               </button>`
          )
          .join('') +
        `<a class="song-credit" href="${GETSONGBPM_CREDIT.url}" target="_blank" rel="noopener">${GETSONGBPM_CREDIT.label}</a></div>`;
    }
  }
  // --- YouTube results ---
  if (hasYouTubeKey()) {
    if (yt.status === 'rejected') {
      html += `<p class="form-error">${escapeHtml(yt.reason.message)}</p>`;
    } else if (!yt.value.length) {
      html += '<p class="hint">No video matches.</p>';
    } else {
      setField('url', yt.value[0].url);
      html +=
        '<div class="song-search-group"><span class="song-search-label">Video</span>' +
        yt.value
          .map(
            (v, i) =>
              `<button class="song-result yt-result${i === 0 ? ' selected' : ''}" type="button" data-i="${i}">
                 <span class="song-result-name">${escapeHtml(v.title)}</span>
                 <span class="song-result-bpm">${escapeHtml(v.channel)}</span>
               </button>`
          )
          .join('') +
        '</div>';
    }
  }
  out.innerHTML = html;

  out.querySelectorAll('.bpm-result').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const r = bpm.value[Number(btn.dataset.i)];
      setField('title', r.title);
      setField('artist', r.artist);
      let tempo = r.tempo;
      if (!tempo) {
        try {
          tempo = await fetchTempo(r.id);
        } catch {
          tempo = null;
        }
      }
      if (tempo) {
        setField('bpm', tempo);
        btn.querySelector('.song-result-bpm').textContent = `${tempo} BPM`;
      }
      out.querySelectorAll('.bpm-result').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    })
  );
  out.querySelectorAll('.yt-result').forEach((btn) =>
    btn.addEventListener('click', () => {
      setField('url', yt.value[Number(btn.dataset.i)].url);
      out.querySelectorAll('.yt-result').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    })
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
