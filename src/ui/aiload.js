// Is the AI deck helper on? It needs this site's server (not on the claude.ai page, or offline), an API key set there
// (/ai/config), and the helper's own script, dist/ai.js (deckagent.js with the Anthropic SDK), which is fetched only now
// so the rest of the site stays light. Resolves to { on: true, client, runTurn } or { on: false, why: 'off' | 'offline' }.
import { findRelay } from '../net/relayroom.js';

/* global __AI_VERSION__ */
let ready = null;
function loadScript() {
  if (window.LotusAI) return Promise.resolve(window.LotusAI);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `ai.js?v=${typeof __AI_VERSION__ === 'string' ? __AI_VERSION__ : '0'}`;
    s.onload = () => (window.LotusAI ? resolve(window.LotusAI) : reject(new Error('ai.js loaded nothing')));
    s.onerror = () => { s.remove(); reject(new Error('ai.js failed to load')); };
    document.head.appendChild(s);
  });
}
export function aiStatus() {
  if (!ready) {
    ready = (async () => {
      const origin = await findRelay();
      if (!origin) return { on: false, why: 'offline' };
      let config;
      try { config = await (await fetch(`${origin}/ai/config`, { cache: 'no-store' })).json(); } catch { return { on: false, why: 'offline' }; }
      if (!config || !config.on) return { on: false, why: 'off' };
      try { const lib = await loadScript(); return { on: true, client: lib.makeClient(origin), runTurn: lib.runTurn }; } catch { return { on: false, why: 'offline' }; }
    })();
    // (try again a minute later: the connection may come back, or the key may be added)
    ready.then(s => { if (!s.on) setTimeout(() => { ready = null; }, 60_000); });
  }
  return ready;
}
