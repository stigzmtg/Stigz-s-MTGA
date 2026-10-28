// Which build of the game rules this browser runs (a hash of the engines, the AIs and the card lists, written in by
// tools/build.mjs). Friends' browsers must run the same one: lockstep play sends only decisions, so two different
// rule sets turn the same decisions into two different games, each soon waiting on a move the other never asks for.
// (browser tests can pose as another build: window.__paFakeVersion = { gv, bt })
/* global __GAME_VERSION__, __BUILD_TIME__ */
const fake = typeof window !== 'undefined' && window.__paFakeVersion;
export const GAME_VERSION = fake ? fake.gv : typeof __GAME_VERSION__ !== 'undefined' ? __GAME_VERSION__ : 'dev';
export const BUILD_TIME = fake ? fake.bt : typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 0;
