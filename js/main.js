// main.js — boot + hash router.

import { load } from './storage.js';
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
startSync();
window.addEventListener('hashchange', route);
route();

// Keep Space from scrolling the page anywhere in the app.
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) e.preventDefault();
});
