// Seed song catalog + YouTube URL parsing.
// BPMs are the natural quarter-note tap tempo. Video IDs point at official
// uploads but can rot or be region/embed-blocked — the game view offers a
// "replace video" flow that stores an override without touching this list.
// startSec skips a video intro (the player starts there); 0 = from the top.
// It's also editable per-song in the start screen (stored as an override).

export const SEED_SONGS = [
  { id: 'seed:humble', title: 'HUMBLE.', artist: 'Kendrick Lamar', bpm: 75, videoId: 'tvTRZJ-4EyI', tag: 'Hip-hop', startSec: 0 },
  { id: 'seed:gods-plan', title: "God's Plan", artist: 'Drake', bpm: 77, videoId: 'xpVfcZ0ZcFM', tag: 'Hip-hop', startSec: 0 },
  { id: 'seed:sunflower', title: 'Sunflower', artist: 'Post Malone & Swae Lee', bpm: 90, videoId: 'ApXoWvfEYVU', tag: 'Hip-hop', startSec: 0 },
  { id: 'seed:lose-yourself', title: 'Lose Yourself', artist: 'Eminem', bpm: 86, videoId: '_Yhyp-_hX2s', tag: 'Hip-hop', startSec: 0 },
  { id: 'seed:dynamite', title: 'Dynamite', artist: 'BTS', bpm: 114, videoId: 'gdZLi9oWNZg', tag: 'K-pop', startSec: 0 },
  { id: 'seed:kill-this-love', title: 'Kill This Love', artist: 'BLACKPINK', bpm: 132, videoId: '2S24-y0Ij3Y', tag: 'K-pop', startSec: 0 },
  { id: 'seed:ditto', title: 'Ditto', artist: 'NewJeans', bpm: 134, videoId: 'V37TaRdVUQY', tag: 'K-pop', startSec: 0 },
  { id: 'seed:blinding-lights', title: 'Blinding Lights', artist: 'The Weeknd', bpm: 171, videoId: '4NRXx6U8ABQ', tag: 'Pop', startSec: 0 },
  { id: 'seed:levitating', title: 'Levitating', artist: 'Dua Lipa', bpm: 103, videoId: 'TUVcZfQe-Kw', tag: 'Pop', startSec: 0 },
  { id: 'seed:espresso', title: 'Espresso', artist: 'Sabrina Carpenter', bpm: 104, videoId: 'eVli-tstM5E', tag: 'Pop', startSec: 0 },
  { id: 'seed:billie-jean', title: 'Billie Jean', artist: 'Michael Jackson', bpm: 117, videoId: 'Zi_XLOBDo_Y', tag: 'Classic', startSec: 0 },
  { id: 'seed:back-in-black', title: 'Back in Black', artist: 'AC/DC', bpm: 94, videoId: 'pAgnJDJN4VA', tag: 'Classic', startSec: 0 },
];

// Accepts full watch URLs, youtu.be short links, /shorts/, /embed/, or a bare
// 11-char video ID. Returns the video ID or null.
export function parseYouTubeId(input) {
  const s = (input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)((youtube\.com)|(youtu\.be)|(youtube-nocookie\.com))$/.test(url.hostname)) return null;
  if (url.hostname.endsWith('youtu.be')) {
    const id = url.pathname.slice(1).split('/')[0];
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  const v = url.searchParams.get('v');
  if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  const m = url.pathname.match(/\/(embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
  return m ? m[2] : null;
}

// Parse a start time entered as seconds ("42") or mm:ss ("1:23") into seconds.
// Returns null if unparseable; empty string → 0.
export function parseTimestamp(input) {
  const s = (input || '').trim();
  if (s === '') return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(\d+):([0-5]?\d)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
}

// Format seconds as m:ss for display.
export function formatTimestamp(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function allSongs(customSongs = []) {
  return [...SEED_SONGS, ...customSongs];
}

export function findSong(id, customSongs = []) {
  return allSongs(customSongs).find((s) => s.id === id) || null;
}
