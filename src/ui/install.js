// The website as an installable app: registers the service worker (sw.js: offline play, quick repeat visits) and
// keeps the browser's install prompt for the home screen's "Install app" button. Never on the claude.ai page, and
// not in browser tests (their hooks are set before the page loads).
import { onClaude } from '../net/roomclient.js';

let deferred = null;
const subs = new Set();
const tell = () => subs.forEach(f => f());

export function initApp() {
  if (typeof window === 'undefined' || onClaude()) return;
  if (window.__paRoomMock || window.__paAutoplay || window.__pkAutoplay) return;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const go = () => navigator.serviceWorker.register('sw.js').catch(() => { /* private mode or blocked */ });
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; tell(); });
  window.addEventListener('appinstalled', () => { deferred = null; tell(); });
}

export const subscribeInstall = f => { subs.add(f); return () => subs.delete(f); };
export const canInstall = () => !!deferred;
export async function install() {
  const e = deferred;
  if (!e) return;
  deferred = null; tell();
  e.prompt();
  try { await e.userChoice; } catch { /* dismissed */ }
}
