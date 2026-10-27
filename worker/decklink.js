// /decklink?url=<a deck's address>: the deck builder's "paste a link". Archidekt and Moxfield don't let other sites
// read their decks from a browser, so this server reads the deck and answers with it as a plain decklist the
// builder's paste reader understands ({ name, text, source }). Only these sites, a few requests a minute per address.
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const UA = { 'User-Agent': 'LotusGoats/1.0 (deck import; https://lotusgoats.com)', Accept: 'application/json' };

// which site, and the deck's id there
export function parseDeckLink(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  let m;
  if (host === 'archidekt.com' && (m = /^\/(?:api\/)?decks\/(\d+)/.exec(u.pathname))) return { site: 'archidekt', id: m[1] };
  if (host === 'moxfield.com' && (m = /^\/decks\/([\w-]+)/.exec(u.pathname))) return { site: 'moxfield', id: m[1] };
  if (host === 'edhrec.com' && (m = /^\/average-decks\/([\w-]+)(?:\/([\w-]+))?/.exec(u.pathname))) return { site: 'edhrec', id: m[1] + (m[2] ? '/' + m[2] : '') };
  if (host === 'tappedout.net' && (m = /^\/mtg-decks\/([\w-]+)/.exec(u.pathname))) return { site: 'tappedout', id: m[1] };
  return null;
}

const lines = (cmds, cards) => ['Commander', ...cmds.map(n => `1 ${n}`), '', 'Deck', ...cards.map(([n, k]) => `${k} ${n}`)].join('\n');

export async function fetchDeckLink(link, fetchImpl = fetch) {
  const get = async url => { const r = await fetchImpl(url, { headers: UA }); if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }); return r; };
  if (link.site === 'archidekt') {
    const j = await (await get(`https://archidekt.com/api/decks/${link.id}/`)).json();
    const outside = new Set((j.categories || []).filter(c => c.includedInDeck === false).map(c => c.name));
    const cmds = [], cards = [];
    for (const c of j.cards || []) {
      const name = c.card && c.card.oracleCard && c.card.oracleCard.name;
      if (!name || (c.categories || []).some(x => outside.has(x))) continue;
      if ((c.categories || []).includes('Commander')) cmds.push(name); else cards.push([name, c.quantity || 1]);
    }
    return { name: j.name, author: j.owner && j.owner.username, text: lines(cmds, cards), source: 'Archidekt' };
  }
  if (link.site === 'moxfield') {
    const j = await (await get(`https://api2.moxfield.com/v3/decks/all/${link.id}`)).json();
    const board = b => Object.values((j.boards && j.boards[b] && j.boards[b].cards) || {}).map(e => [e.card && e.card.name, e.quantity || 1]).filter(([n]) => n);
    return { name: j.name, author: j.createdByUser && j.createdByUser.userName, text: lines(board('commanders').map(([n]) => n), board('mainboard')), source: 'Moxfield' };
  }
  if (link.site === 'edhrec') {
    const j = await (await get(`https://json.edhrec.com/pages/average-decks/${link.id}.json`)).json();
    const d = j.deck || {};
    const cmds = d.commander_v2 ? d.commander_v2.map(([n]) => n) : d.commander || [];
    const cards = [];
    for (const list of Object.values(d.cards || {})) for (const [n, k] of list) cards.push([n, k]);
    return { name: `${cmds.map(n => n.split(',')[0]).join(' & ')} (EDHREC average)`, text: lines(cmds, cards), source: 'EDHREC' };
  }
  if (link.site === 'tappedout') {
    const text = await (await get(`https://tappedout.net/mtg-decks/${link.id}/?fmt=txt`)).text();
    return { name: link.id.replace(/-/g, ' '), text, source: 'TappedOut' };
  }
  throw new Error('unknown site');
}

export async function deckLinkRequest(req, env) {
  const url = new URL(req.url);
  const link = parseDeckLink(url.searchParams.get('url') || '');
  if (!link) return json({ error: 'That isn’t a deck link from Archidekt, Moxfield, EDHREC or TappedOut.' }, 400);
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  if (env.ACCOUNTS && await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts')).linkAllow(ip) === false) return json({ error: 'That’s a lot of decks at once: wait a minute and try again.' }, 429);
  try {
    const deck = await fetchDeckLink(link);
    if (!deck.text || !/\d/.test(deck.text)) return json({ error: 'That deck is empty.' }, 404);
    return json(deck);
  } catch (e) {
    if (e.status === 404) return json({ error: 'No deck there: is it private, or deleted?' }, 404);
    if (link.site === 'moxfield' && (e.status === 403 || e.status === 429 || e.status === 503)) return json({ error: 'Moxfield doesn’t let other sites read its decks. On Moxfield, open the deck, choose More → Export, copy the list and paste it here instead.' }, 502);
    return json({ error: `Couldn’t get the deck from ${link.site} (${e.message}). Copy the list from the site and paste it here instead.` }, 502);
  }
}
