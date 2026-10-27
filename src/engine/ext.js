// Registries through which mechanics kept in their own modules (mech-casting.js, ...) extend the shared engine files
// that can't import them (filters.js, triggers.js, keywords.js). This module imports nothing, so it's always ready
// before the modules that fill and read it, whatever order they load in.

// card properties, Count$ values and "how it was cast" properties: functions returning undefined for what they don't know
export const filterExt = { cardProp: [], count: [], castSA: [] };
// trigger mode -> (game, p, host, rp, ctx) => whether it matches
export const triggerExt = {};
// keyword name -> ({ A, T, R, S, a, b, parts, face, kw }) adding the keyword's abilities, triggers, replacements, SVars
export const keywordExt = {};
