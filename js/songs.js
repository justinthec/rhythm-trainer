// Seed song catalog + YouTube URL parsing.
// BPMs are the natural quarter-note tap tempo. Video IDs point at official
// uploads but can rot or be region/embed-blocked — the game view offers a
// "replace video" flow that stores an override without touching this list.

export const SEED_SONGS = [
  { id: 'seed:humble', title: 'HUMBLE.', artist: 'Kendrick Lamar', bpm: 75, videoId: 'tvTRZJ-4EyI', tag: 'Hip-hop' },
  { id: 'seed:gods-plan', title: "God's Plan", artist: 'Drake', bpm: 77, videoId: 'xpVfcZ0ZcFM', tag: 'Hip-hop' },
  { id: 'seed:sunflower', title: 'Sunflower', artist: 'Post Malone & Swae Lee', bpm: 90, videoId: 'ApXoWvfEYVU', tag: 'Hip-hop' },
  { id: 'seed:lose-yourself', title: 'Lose Yourself', artist: 'Eminem', bpm: 86, videoId: '_Yhyp-_hX2s', tag: 'Hip-hop' },
  { id: 'seed:dynamite', title: 'Dynamite', artist: 'BTS', bpm: 114, videoId: 'gdZLi9oWNZg', tag: 'K-pop' },
  { id: 'seed:kill-this-love', title: 'Kill This Love', artist: 'BLACKPINK', bpm: 132, videoId: '2S24-y0Ij3Y', tag: 'K-pop' },
  { id: 'seed:ditto', title: 'Ditto', artist: 'NewJeans', bpm: 134, videoId: 'V37TaRdVUQY', tag: 'K-pop' },
  { id: 'seed:blinding-lights', title: 'Blinding Lights', artist: 'The Weeknd', bpm: 171, videoId: '4NRXx6U8ABQ', tag: 'Pop' },
  { id: 'seed:levitating', title: 'Levitating', artist: 'Dua Lipa', bpm: 103, videoId: 'TUVcZfQe-Kw', tag: 'Pop' },
  { id: 'seed:espresso', title: 'Espresso', artist: 'Sabrina Carpenter', bpm: 104, videoId: 'eVli-tstM5E', tag: 'Pop' },
  { id: 'seed:billie-jean', title: 'Billie Jean', artist: 'Michael Jackson', bpm: 117, videoId: 'Zi_XLOBDo_Y', tag: 'Classic' },
  { id: 'seed:back-in-black', title: 'Back in Black', artist: 'AC/DC', bpm: 94, videoId: 'pAgnJDJN4VA', tag: 'Classic' },
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

export function allSongs(customSongs = []) {
  return [...SEED_SONGS, ...customSongs];
}

export function findSong(id, customSongs = []) {
  return allSongs(customSongs).find((s) => s.id === id) || null;
}
