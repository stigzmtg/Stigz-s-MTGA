import { pageHidden } from '../net/soon.js';

// Human-like timing for computer players at the table: a moment to "think" before each play, a land drop,
// lands tapped one at a time, a pause before attacking or blocking. Ranges in milliseconds by AI speed setting.
const TEMPO = {
  slow: { think: [1300, 2200], land: [900, 1500], tap: 330, attack: [1500, 2400], block: [1200, 1900], choose: [700, 1200], respond: [600, 1100] },
  normal: { think: [800, 1400], land: [550, 950], tap: 220, attack: [1000, 1600], block: [800, 1300], choose: [450, 800], respond: [350, 700] },
  fast: { think: [300, 550], land: [250, 400], tap: 100, attack: [400, 650], block: [350, 550], choose: [180, 320], respond: [120, 250] },
};

// pace(kind) -> ms; reads the live settings so changing the speed applies at once. Nobody watches a hidden page, and its
// timers run late (net/soon.js): there the computer players move at once, so a friend never waits on a background tab
export function makePace(settings) {
  return kind => {
    if (pageHidden()) return 0;
    const t = TEMPO[settings.aiSpeed];
    const v = t && t[kind];
    if (v == null) return 0;
    return Array.isArray(v) ? Math.round(v[0] + Math.random() * (v[1] - v[0])) : v;
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// engine hook for the game's own pacing points (each land tapped for mana): only for players other than `localPid`
export function gamePacer(game, pace, localPid) {
  return async (kind, pid) => {
    if (pid === localPid()) return;
    const ms = pace(kind);
    if (ms > 0) { game.notify(); await sleep(ms); }
  };
}
