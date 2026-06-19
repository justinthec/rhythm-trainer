// lookup.js — song metadata lookups for auto-filling tempo and video.
//
// Two independent providers, each gated by a user-supplied API key (Settings):
//   • GetSongBPM (getsongbpm.com) — search a song name, get its BPM. Free key,
//     and their terms REQUIRE a visible link back to getsongbpm.com wherever
//     results are shown (see GETSONGBPM_CREDIT).
//   • YouTube Data API v3 — search a song name, get a matching video id. Free
//     Google API key; supports browser/CORS requests (restrict it by HTTP
//     referrer in the Google console to limit abuse since it ships client-side).
//
// All calls run straight from the browser. If a provider doesn't send CORS
// headers the fetch throws — we surface that as a friendly message rather than
// pretending it worked.

import { getData } from './storage.js';

export const GETSONGBPM_CREDIT = { label: 'BPM data from GetSongBPM', url: 'https://getsongbpm.com' };

const BPM_BASE = 'https://api.getsong.co';
const YT_BASE = 'https://www.googleapis.com/youtube/v3/search';

function settings() {
  return getData().settings;
}

// Translate fetch/network failures (including CORS) into a clear message.
async function getJSON(url, providerLabel) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`${providerLabel} request was blocked (network or CORS). ${e.message}`);
  }
  if (!res.ok) throw new Error(`${providerLabel} returned ${res.status} ${res.statusText}.`);
  return res.json();
}

// --- GetSongBPM ---------------------------------------------------------------

// Returns [{ id, title, artist, tempo|null }]. Tempo is filled when the search
// payload carries it; otherwise it's null and can be resolved via fetchTempo().
export async function searchSongBpm(query) {
  const key = settings().getSongBpmKey?.trim();
  if (!key) throw new Error('Add your GetSongBPM API key in Settings to search by song name.');
  const q = encodeURIComponent(query.trim());
  const url = `${BPM_BASE}/search/?api_key=${encodeURIComponent(key)}&type=song&lookup=${q}`;
  const data = await getJSON(url, 'GetSongBPM');
  const rows = Array.isArray(data?.search) ? data.search : [];
  return rows.map((r) => ({
    id: r.id,
    title: r.title || '',
    artist: r.artist?.name || '',
    tempo: parseTempo(r.tempo),
  }));
}

// Resolve tempo for a single result when the search payload omitted it.
export async function fetchTempo(id) {
  const key = settings().getSongBpmKey?.trim();
  if (!key) throw new Error('Add your GetSongBPM API key in Settings first.');
  const url = `${BPM_BASE}/song/?api_key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`;
  const data = await getJSON(url, 'GetSongBPM');
  return parseTempo(data?.song?.tempo);
}

function parseTempo(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function hasBpmKey() {
  return !!settings().getSongBpmKey?.trim();
}

// --- YouTube Data API v3 ------------------------------------------------------

// Returns [{ videoId, title, channel, url }] for the top matches.
export async function searchYouTube(query) {
  const key = settings().youtubeApiKey?.trim();
  if (!key) throw new Error('Add your YouTube Data API key in Settings to find videos.');
  const q = encodeURIComponent(query.trim());
  const url = `${YT_BASE}?part=snippet&type=video&maxResults=5&q=${q}&key=${encodeURIComponent(key)}`;
  const data = await getJSON(url, 'YouTube');
  if (data?.error) throw new Error(`YouTube: ${data.error.message || 'request failed'}.`);
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .filter((it) => it.id?.videoId)
    .map((it) => ({
      videoId: it.id.videoId,
      title: it.snippet?.title || '',
      channel: it.snippet?.channelTitle || '',
      url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
    }));
}

export function hasYouTubeKey() {
  return !!settings().youtubeApiKey?.trim();
}
