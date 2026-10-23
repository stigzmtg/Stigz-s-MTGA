// Table sounds, made on the fly with Web Audio (nothing to download): card draws, land drops, mana taps, spells,
// attacks, hits, coin flips, Knock Outs, turn chimes and the end of a game. Both games feed their engine's log
// (Commander) or events (Pokémon) through useGameSounds; settings.sound / settings.volume control it.
import { loadSettings } from './common.js';

let ctx = null, master = null, noiseBuf = null, unlocked = false;
const last = new Map();   // kind -> time it last played (no machine-gun repeats)

// browsers only allow sound after the person has clicked or pressed a key on the page
function unlock() {
  if (unlocked || typeof window === 'undefined') return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    ctx = ctx || new AC();
    if (ctx.state === 'suspended') ctx.resume();
    master = master || ctx.createGain();
    master.connect(ctx.destination);
    const n = Math.floor(ctx.sampleRate * 0.5);
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let seed = 1234567;
    for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = seed / 0x3fffffff - 1; }
    unlocked = true;
  } catch { /* no audio here */ }
}
if (typeof window !== 'undefined') for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, unlock, { capture: true, passive: true });

function volume() { const s = loadSettings(); return s.sound === false ? 0 : Math.max(0, Math.min(1, s.volume == null ? 0.6 : +s.volume)); }

// ---- building blocks
function tone(t, { f = 440, f2 = null, type = 'sine', dur = 0.15, gain = 0.3, attack = 0.005, delay = 0 } = {}) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  const t0 = t + delay;
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function noise(t, { dur = 0.12, gain = 0.25, f = 1800, f2 = null, q = 1, type = 'bandpass', delay = 0 } = {}) {
  const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
  const t0 = t + delay;
  s.buffer = noiseBuf;
  fl.type = type; fl.Q.value = q;
  fl.frequency.setValueAtTime(f, t0);
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  s.connect(fl); fl.connect(g); g.connect(master);
  s.start(t0, Math.random() * 0.3); s.stop(t0 + dur + 0.02);
}

const SOUNDS = {
  draw: t => noise(t, { dur: 0.11, gain: 0.18, f: 2600, f2: 1200, q: 0.8 }),
  card: t => { noise(t, { dur: 0.06, gain: 0.22, f: 3200, q: 1.2 }); tone(t, { f: 180, f2: 110, dur: 0.09, gain: 0.12 }); },
  land: t => { tone(t, { f: 140, f2: 70, dur: 0.16, gain: 0.32 }); noise(t, { dur: 0.05, gain: 0.16, f: 2200, q: 1 }); },
  tap: t => { noise(t, { dur: 0.03, gain: 0.2, f: 4200, q: 3 }); tone(t, { f: 1900, dur: 0.04, gain: 0.05, type: 'triangle' }); },
  cast: t => { tone(t, { f: 523, f2: 784, dur: 0.22, gain: 0.12, type: 'triangle' }); tone(t, { f: 784, f2: 1175, dur: 0.26, gain: 0.08, delay: 0.05 }); },
  ability: t => { tone(t, { f: 880, dur: 0.16, gain: 0.1, type: 'triangle' }); tone(t, { f: 1320, dur: 0.2, gain: 0.07, delay: 0.04 }); },
  energy: t => { tone(t, { f: 660, f2: 990, dur: 0.14, gain: 0.12, type: 'triangle' }); noise(t, { dur: 0.08, gain: 0.08, f: 5000, q: 2 }); },
  attack: t => { noise(t, { dur: 0.28, gain: 0.28, f: 500, f2: 2600, q: 0.9 }); tone(t, { f: 220, f2: 330, dur: 0.18, gain: 0.08, type: 'sawtooth', delay: 0.04 }); },
  block: t => { noise(t, { dur: 0.08, gain: 0.22, f: 1400, q: 4 }); tone(t, { f: 600, f2: 480, dur: 0.18, gain: 0.1, type: 'square' }); },
  hit: t => { tone(t, { f: 120, f2: 45, dur: 0.22, gain: 0.45 }); noise(t, { dur: 0.1, gain: 0.25, f: 900, q: 0.7, type: 'lowpass' }); },
  heal: t => { tone(t, { f: 660, dur: 0.14, gain: 0.08 }); tone(t, { f: 880, dur: 0.16, gain: 0.08, delay: 0.07 }); tone(t, { f: 1175, dur: 0.22, gain: 0.07, delay: 0.14 }); },
  token: t => tone(t, { f: 740, f2: 990, dur: 0.1, gain: 0.08, type: 'triangle' }),
  coin: t => { for (const [d, f] of [[0, 2400], [0.11, 2900], [0.2, 2600]]) { tone(t, { f, dur: 0.12, gain: 0.09, delay: d }); tone(t, { f: f * 1.5, dur: 0.09, gain: 0.04, delay: d }); } },
  ko: t => { tone(t, { f: 392, f2: 98, dur: 0.5, gain: 0.18, type: 'sawtooth' }); noise(t, { dur: 0.35, gain: 0.22, f: 700, f2: 150, q: 0.8 }); },
  prize: t => { for (const [d, f] of [[0, 988], [0.07, 1319], [0.14, 1760]]) tone(t, { f, dur: 0.14, gain: 0.08, delay: d, type: 'triangle' }); },
  turn: t => { tone(t, { f: 523, dur: 0.22, gain: 0.1 }); tone(t, { f: 784, dur: 0.32, gain: 0.1, delay: 0.12 }); },
  otherTurn: t => tone(t, { f: 392, dur: 0.16, gain: 0.05 }),
  win: t => { for (const [d, f] of [[0, 523], [0.12, 659], [0.24, 784], [0.36, 1047]]) tone(t, { f, dur: 0.35, gain: 0.12, delay: d, type: 'triangle' }); tone(t, { f: 1568, dur: 0.6, gain: 0.05, delay: 0.48 }); },
  lose: t => { for (const [d, f] of [[0, 392], [0.18, 330], [0.36, 262]]) tone(t, { f, dur: 0.4, gain: 0.1, delay: d, type: 'triangle' }); },
  emote: t => { tone(t, { f: 988, dur: 0.08, gain: 0.07 }); tone(t, { f: 1480, dur: 0.12, gain: 0.06, delay: 0.06 }); },
  click: t => tone(t, { f: 1200, dur: 0.03, gain: 0.04, type: 'triangle' }),
};

// play one sound; repeats of the same kind within a short gap are dropped
export function play(kind, { spacing = 0.09 } = {}) {
  const v = volume();
  if (!v || !unlocked || !ctx || !SOUNDS[kind]) return;
  if (ctx.state === 'suspended') ctx.resume();
  const now = ctx.currentTime;
  if (now - (last.get(kind) || -1) < spacing) return;
  last.set(kind, now);
  if (window.__paSoundTest) window.__paSoundTest.push(kind);   // browser tests
  master.gain.setValueAtTime(v, now);
  try { SOUNDS[kind](now + 0.01); } catch { /* audio graph busy */ }
}
export const soundKinds = Object.keys(SOUNDS);

// ---- what each game's happenings sound like
const MTG_LOG = { land: 'land', mana: 'tap', cast: 'cast', activate: 'ability', attack: 'attack', block: 'block', damage: 'hit', token: 'token', draw: 'draw', attach: 'card', counter: 'token', pump: 'token' };
const PK_EVENT = { draw: 'draw', enter: 'card', evolve: 'cast', energy: 'energy', trainer: 'card', ability: 'ability', attack: 'attack', damage: 'hit', heal: 'heal', coin: 'coin', ko: 'ko', prize: 'prize', switch: 'card', condition: 'ability' };
const seen = new WeakMap();

// call on every render of a game screen: plays the sounds for whatever happened since the last render
export function useGameSounds(game, { kind, me = 0, watching = false } = {}) {
  let s = seen.get(game);
  const list = kind === 'pk' ? game.events : game.logs;
  const newest = list.length ? list[list.length - 1].id : 0;
  if (!s) { seen.set(game, s = { last: newest, over: game.over }); return; }   // nothing for what happened before we looked
  if (newest > s.last) {
    const fresh = list.filter(e => e.id > s.last);
    s.last = newest;
    let n = 0;
    for (const e of fresh) {
      let k = null;
      if (kind === 'pk') k = e.kind === 'turn' ? (e.pid === me && !watching ? 'turn' : 'otherTurn') : PK_EVENT[e.kind];
      else if (e.type === 'turn') k = !watching && game.players[me] && e.text.endsWith(': ' + game.players[me].name) ? 'turn' : 'otherTurn';
      else if (e.type === 'life') k = /gains/.test(e.text) ? 'heal' : 'hit';
      else k = MTG_LOG[e.type];
      if (k && n < 4) { play(k); n++; }
    }
  }
  if (game.over && !s.over) {
    s.over = true;
    const won = game.winner === me && !watching;
    setTimeout(() => play(watching || game.winner == null ? 'turn' : won ? 'win' : 'lose'), 250);
  }
}
