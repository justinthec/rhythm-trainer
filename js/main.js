// main.js — boot + hash router.

import { load, update } from './storage.js';
import { startSync } from './sync.js';
import * as songselect from './views/songselect.js';
import * as game from './views/game.js';
import * as dashboard from './views/dashboard.js';
import * as settings from './views/settings.js';

const routes = [
  { pattern: /^#\/select$/, view: songselect },
  { pattern: /^#\/freeplay$/, view: game, params: () => ({ freeplay: true }) },
  { pattern: /^#\/game\/(.+)$/, view: game, params: (m) => ({ songId: m[1] }) },
  { pattern: /^#\/dashboard$/, view: dashboard },
  { pattern: /^#\/settings$/, view: settings },
];

let currentView = null;
const main = document.getElementById('app');

// Let the lookup API keys be seeded from the URL, e.g.
//   …/?bpmKey=ABC123&ytKey=XYZ#/freeplay
// Handy for loading the app pre-configured. The keys are saved to settings,
// then stripped from the URL so they don't linger in history or the address bar.
function applyKeyParams() {
  const params = new URLSearchParams(location.search);
  const bpmKey = params.get('bpmKey');
  const ytKey = params.get('ytKey');
  if (bpmKey == null && ytKey == null) return;
  update((d) => {
    if (bpmKey != null) d.settings.getSongBpmKey = bpmKey.trim();
    if (ytKey != null) d.settings.youtubeApiKey = ytKey.trim();
  });
  params.delete('bpmKey');
  params.delete('ytKey');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
}

function route() {
  const hash = location.hash || '#/select';
  const match = routes.find((r) => r.pattern.test(hash));
  if (!match) {
    location.hash = '#/select';
    return;
  }
  if (currentView && currentView.leave) currentView.leave();
  currentView = match.view;
  const m = hash.match(match.pattern);
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', hash.startsWith(a.getAttribute('href'))));
  match.view.render(main, match.params ? match.params(m) : {});
  window.scrollTo(0, 0);
}

load();
applyKeyParams();
startSync();
window.addEventListener('hashchange', route);
route();

// Keep Space from scrolling the page anywhere in the app.
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) e.preventDefault();
});
