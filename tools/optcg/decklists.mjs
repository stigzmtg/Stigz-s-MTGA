// The 36 English One Piece Card Game starter decks (ST-01 … ST-36) and the published decklists their exact contents
// are read from. fetch-cards.mjs downloads every page named here into the cache; build-data.mjs reads each one with
// the parser below, compares them and writes what every source said, and the list it settled on, to
// data/optcg/sources.json. A deck is only used when at least two independent sources give the same 50 cards.

const pad = n => String(n).padStart(2, '0');

// official English product pages (release date and contents)
const productUrl = i => {
  const n = pad(i), base = 'https://en.onepiece-cardgame.com/products/';
  if (i <= 4) return base + 'decks/st01-04.php';
  if (i >= 15 && i <= 20) return base + 'decks/st15-20.php';
  if (i >= 30) return `${base}st${n}.html`;
  return `${base}decks/st${n}.php`;
};

export const DECKS = Array.from({ length: 36 }, (_, k) => {
  const i = k + 1, n = pad(i);
  return { i, n, code: `ST-${n}`, id: `st${n}`, enSeries: `5690${n}`, jpSeries: `5500${n}`, product: productUrl(i) };
});

// The two Ultra Decks hold three Leaders each (one in the 51-card deck plus two "Alternative Leader Cards"), and the
// 50 cards are legal with any of them. We play both with Luffy, the Leader of the Straw Hat side of each box.
export const LEADER_CHOICE = { 'ST-10': 'ST10-002', 'ST-13': 'ST13-003' };

// official card lists: one page per starter deck (the cards in that product), plus the booster, extra booster and
// promotion lists, where the normal print of every reprinted card lives
export const OFFICIAL_EN = 'https://en.onepiece-cardgame.com/cardlist/?series=';
export const OFFICIAL_JP = 'https://www.onepiece-cardgame.com/cardlist/?series=';
export const BOOSTER_SERIES = [
  ...Array.from({ length: 17 }, (_, k) => `5691${pad(k + 1)}`), // OP-01 … OP-17 (OP14-EB04 and OP15-EB04 carry EB-04)
  '569201', '569202', '569203', '569205', // EB-01, EB-02, EB-03, EB-05
  '569901', // promotion cards
];
export const cardImage = id => `https://en.onepiece-cardgame.com/images/cardlist/card/${id}.png`;

export const OPTCGAPI = {
  st: 'https://optcgapi.com/api/allSTCards/',
  set: 'https://optcgapi.com/api/allSetCards/',
  promo: 'https://optcgapi.com/api/allPromos/',
  deck: code => `https://optcgapi.com/api/decks/${code}/`,
};

// ---- the decklist sources -------------------------------------------------------------------------------------
// Each parser gets the cached file's text and the deck, and returns the entries it lists ({ id, n, name? }) or null
// when the page has no list for that deck. Ids are checked against the product's official card list afterwards; an
// id that isn't in the product is matched back by card name (logged in sources.json), since a few pages mistype one.

const ent = s => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const zen = s => s.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

// Limitless set pages link an image of the decklist: /tools/imggen?c=<code>, where the code is a format digit, then
// per card: count, length of the set prefix, length of the number, prefix, number, variant (0 = normal print)
function limitless(text) {
  const m = text.match(/imggen\?c=([0-9A-Z]+)/);
  if (!m) return null;
  let s = m[1].slice(1);
  const out = [];
  while (s.length) {
    const n = +s[0], a = +s[1], b = +s[2];
    if (!(n && a && b) || s.length < 4 + a + b) throw new Error('bad Limitless code ' + m[1]);
    out.push({ id: `${s.slice(3, 3 + a)}-${s.slice(3 + a, 3 + a + b)}`, n });
    s = s.slice(4 + a + b);
  }
  return out;
}

// Egman Events' deck builder lists every starter deck as a link ?deck=ID:N,ID:N,…; its leader is the deck's image
function egman(text, d) {
  const deck = JSON.parse(text).structureDecks.find(x => x.label === `ST${d.n}`);
  if (!deck) return null;
  const out = new URL(deck.url).searchParams.get('deck').split(',').map(x => { const [id, n] = x.split(':'); return { id, n: +n }; });
  const leader = deck.image.replace(/^([A-Z]+\d*-\d+).*/, '$1');
  // one list (ST31) leaves the Leader out; the deck's image is its Leader
  if (out.reduce((a, e) => a + e.n, 0) === 50 && !out.some(e => e.id === leader)) out.unshift({ id: leader, n: 1 });
  return out;
}

// Tier One Media (Japanese): a table of count | rarity | number | name
function tierone(text) {
  const t = text.match(/<table class="card-list"[\s\S]*?<\/table>/);
  if (!t) return null;
  const out = [];
  for (const r of t[0].matchAll(/<tr(?: class="[^"]*")?><td>(\d+)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td[^>]*>([^<]*)<\/td><\/tr>/g))
    out.push({ n: +r[1], id: r[3].replace(/[《》\s]/g, ''), name: ent(r[4]), rarity: r[2].trim(), lang: 'ja' });
  return out.length ? out : null;
}

// yuyu-tei (Japanese shop) deck articles: the first deck shown is the box as sold (its Leader block, then the 50);
// cards link to /sell/opc/card/<set>/1<4-digit number>, the shop's own numbering, which for reprints is the box's
// slot rather than the card's number, so names decide those
function yuyutei(text) {
  const parts = text.split('class="deck-count">').slice(1, 3);
  if (parts.length < 2) return null;
  const out = [];
  for (const p of parts) for (const m of p.matchAll(/href='\/sell\/opc\/card\/([a-z]+\d*)\/(\d+)'><font[^>]*>([^<]*)<\/font><\/a>＞<\/div><div\s+class="cardcount">(\d+)枚/g))
    out.push({ id: `${m[1].toUpperCase()}-${pad(+m[2] % 10000).padStart(3, '0')}`, n: +m[4], name: ent(m[3]).replace(/^(L|C|UC|R|SR|SEC|P)(?=\S)/, '').replace(/\((パラレル|ホロ|ホロなし)[^)]*\)?$|\.\.\.$/, ''), lang: 'ja' });
  return out;
}

// LaughTale (Japanese): a table of card name | copies, in card number order (some also list the 10 DON!! cards)
function laughtale(text) {
  const t = text.match(/<th[^>]*>カード名<\/th><th[^>]*>封入数<\/th>[\s\S]*?<\/table>/);
  if (!t) return null;
  return [...t[0].matchAll(/<tr><td[^>]*>([^<]*)<\/td><td[^>]*>([^<]*)<\/td>/g)]
    .map(r => ({ id: null, n: +zen(r[2]).replace(/枚/, ''), name: ent(r[1]).replace(/（リーダー）$/, ''), lang: 'ja', leader: /（リーダー）$/.test(r[1]), ordered: true }))
    .filter(e => !/^ドン(‼|!!)カード$/.test(e.name));
}

// a personal blog (Japanese) that opened ST-13 and listed it card by card: "ST13-004 | C | CHARACTER　name　4枚"
function tubuke(text) {
  const seen = new Map();
  for (const m of text.matchAll(/(ST13-\d{3}) \| \w+ \| [A-Z]+　([^<　]+)　(\d)枚/g)) if (!seen.has(m[1])) seen.set(m[1], { id: m[1], n: +m[3], name: m[2], lang: 'ja' });
  return seen.size ? [...seen.values()] : null;
}

// TCGplayer's upgrade guides open with "Starter Deck NN: … - Base Decklist": the Leader, then "N [Name (ID)]"
function tcgplayer(text) {
  const body = JSON.parse(text).result.article.body;
  const m = body.match(/Base Decklist\s*<\/h[23]>\s*<ul>([\s\S]*?)<\/ul>/);
  if (!m) return null;
  return [...m[1].matchAll(/<li>(\d*)\s*<card-hover-link[^>]*display-text="([^"]*)"/g)].map(x => {
    const t = ent(x[2]).replace(/\s*Alt Art\s*$/i, '').trim();
    const [, name, id] = t.match(/^(.*?)\s*\(([A-Z]+\d*-\d+)\)$/) || [null, t, null];
    return { id, n: x[1] ? +x[1] : 1, name, lang: 'en' };
  });
}

// One Piece Merch News posted each of ST-31 … ST-36 as a list (cut short by X after eight to ten cards) with a photo
// of the opened deck laid out one pile per card (stills from a バンマニ! product video, per the watermark). The lists
// below are read from those photos: the card in each pile (name, cost and power as printed) and the copies fanned
// out behind it; DON!! cards left out. The parser also reads the post's own text and the build checks every card it
// names against the photo count.
const PHOTO = {
  31: ['2073444961509605822', 'ST21-001:1 ST31-001:2 ST31-004:2 ST31-002:4 ST31-003:4 ST31-005:2 OP01-016:4 OP11-003:4 OP11-009:4 OP11-012:4 OP14-015:4 ST23-004:4 P-101:4 OP04-016:4 OP13-021:4'],
  32: ['2073446851483951406', 'OP12-020:1 ST32-002:2 ST32-003:2 ST32-001:4 ST32-004:4 ST32-005:2 OP10-036:4 OP12-023:4 OP12-026:4 OP12-027:4 OP12-028:4 OP12-031:4 OP15-036:4 ST24-005:4 OP12-039:4'],
  33: ['2073449244451815538', 'OP12-040:1 ST33-004:2 ST33-005:2 ST33-001:4 ST33-002:4 ST33-003:2 EB04-026:4 OP12-043:4 OP12-045:4 OP12-046:4 OP12-047:4 OP12-050:4 OP12-052:4 EB04-028:4 OP12-057:4'],
  34: ['2073452499948978618', 'OP11-062:1 ST34-001:2 ST34-004:2 ST34-002:4 ST34-003:2 ST34-005:4 EB03-032:4 EB03-035:4 OP11-065:4 OP11-066:4 OP11-068:4 OP11-071:4 P-090:4 OP11-079:4 OP11-081:4'],
  35: ['2073454304040820780', 'OP13-004:1 ST35-004:2 ST35-005:2 ST35-001:4 ST35-002:2 ST35-003:4 OP12-090:4 OP12-093:4 OP13-005:4 OP13-008:4 OP13-017:4 OP13-081:4 P-105:4 OP12-098:4 OP13-019:4'],
  36: ['2073456328232804634', 'OP10-099:1 ST36-002:2 ST36-005:2 ST36-001:4 ST36-003:2 ST36-004:4 OP10-101:4 OP10-103:4 OP10-109:4 OP10-111:4 OP10-114:4 OP12-113:4 P-085:4 P-088:4 OP13-116:4'],
};
function photo(text, d) {
  const p = PHOTO[d.i];
  if (!p) return null;
  const out = p[1].split(' ').map(x => { const [id, n] = x.split(':'); return { id, n: +n }; });
  // the post's text: "• xN Name ID" lines, the last one usually cut off
  out.partial = [...JSON.parse(text).text.matchAll(/•\s*x(\d)\s+(.+?)\s+([A-Z]+\d*-\d{3})(?=\s|$)/g)].map(m => ({ id: m[3], n: +m[1], name: ent(m[2]).replace(/[“”]/g, '"').trim(), lang: 'en' }));
  return out;
}

const TIERONE = {
  '01': 'st01-cardlists', '02': 'st02-cardlists', '03': 'st03-cardlists', '04': 'st04-cardlists', '05': 'st05-cardlists',
  '06': 'st06-cardlists', '07': 'st07-cardlists', '08': 'st08-cardlists', '09': 'st09-cardlists', 10: 'st10-cardlists',
  11: 'st11_cardlists', 12: 'st12_cardlists', 13: 'st13_cardlists', 14: 'st14_cardlists', 15: 'st15_cardlists',
  16: 'st16_cardlists', 17: 'st17_cardlists', 18: 'st18_cardlists', 19: 'st19_cardlists', 20: 'st20_cardlists',
  21: 'st21_cardlists', 22: 'st22-cardlists', 23: 'st23_cardlists', 24: 'st24_cardlists', 25: 'st25_cardlists',
  26: 'st26_cardlists', 27: 'st27_cardlists', 28: 'st28_cardlists', 29: 'st29-card-list', 30: 'st30-card-list',
  31: 'st31-card-list', 32: 'st32-card-list', 33: 'st33-card-list', 34: 'st34-card-list', 35: 'st35-card-list',
  36: 'st36-card-list',
};
const YUYUTEI = { 10: 20829, 11: 21132, 12: 21241, 14: 22238 };
const TCGPLAYER = {
  23: 'How-to-Upgrade-the-One-Piece-TCG-Starter-Deck-23-RED-Shanks/3bff8ee9-3d6f-43ab-be3b-9e857b69bd5c',
  24: 'How-to-Upgrade-the-One-Piece-TCG-Starter-Deck-24-GREEN-Jewelry-Bonney/e305b37a-0ff9-4c30-b9fa-998d20de324e',
  25: 'How-to-Upgrade-the-One-Piece-TCG-Starter-Deck-25-BLUE-Buggy/17edd14d-fbbc-495f-a7af-3e3706611261',
  26: 'How-to-Upgrade-the-One-Piece-TCG-Starter-Deck-26-PURPLE-BLACK-Luffy/9ae55697-e61d-439c-b064-8a7d1cfd6dbb',
  27: 'How-to-Upgrade-the-One-Piece-TCG-Starter-Deck-27-BLACK-Marshall-D-Teach/6396491b-6ff1-4028-b6df-ed66c71ece91',
  28: 'How-to-Upgrade-the-One-Piece-TCG-Starter-Deck-28-GREEN-YELLOW-Yamato/52b5d7f8-66cd-46ac-941e-daca960c2952',
};
const key = d => (d.i < 10 ? d.n : String(d.i));

// url: the page a reader can open; fetch: what fetch-cards.mjs downloads (an API behind the page, when there is one)
export const SOURCES = [
  { key: 'limitless', name: 'Limitless TCG set page (decklist image link)', parse: limitless,
    url: d => `https://onepiece.limitlesstcg.com/cards/ST${d.n}`, file: d => `limitless/ST${d.n}.html` },
  { key: 'egman', name: 'Egman Events deck builder, starter decks', parse: egman,
    url: () => 'https://deckbuilder.egmanevents.com/optcg/collection?tab=starter', fetch: () => 'https://deckbuilder.egmanevents.com/api/gamedata/optcg', file: () => 'egman/gamedata.json' },
  { key: 'tierone', name: 'Tier One Media (JP) card list with counts', parse: tierone,
    url: d => `https://tier-one-onepiece.jp/blog/${TIERONE[key(d)]}/`, file: d => `tierone/${TIERONE[key(d)]}.html` },
  { key: 'yuyutei', name: 'yuyu-tei (JP shop) deck article', parse: yuyutei, only: d => YUYUTEI[key(d)],
    url: d => `https://yuyu-tei.jp/show/opc/content/${YUYUTEI[key(d)]}`, file: d => `yuyutei/${YUYUTEI[key(d)]}.html` },
  { key: 'laughtale', name: 'LaughTale (JP) card list with counts', parse: laughtale, only: d => d.i <= 9,
    url: d => `https://laughtale-pirates.com/askerbert/one-piece-cardlist-starterdeck${d.n}`, file: d => `laughtale/st${d.n}.html` },
  { key: 'tubuke', name: 'tubukeblog (JP) opened-box list', parse: tubuke, only: d => d.i === 13,
    url: () => 'https://tubukeblog.com/blog/ultimate-deck-3-brotherly-bond-card-list', file: () => 'tubuke/st13.html' },
  { key: 'tcgplayer', name: 'TCGplayer upgrade guide, base decklist', parse: tcgplayer, only: d => TCGPLAYER[key(d)],
    url: d => `https://www.tcgplayer.com/content/article/${TCGPLAYER[key(d)]}/`,
    fetch: d => `https://infinite-api.tcgplayer.com/content/article/${TCGPLAYER[key(d)].split('/')[1]}/`, file: d => `tcgplayer/st${d.n}.json` },
  { key: 'photo', name: 'One Piece Merch News post: photo of the opened deck (read pile by pile) and the post text', parse: photo, only: d => PHOTO[d.i],
    url: d => `https://x.com/OPMerchandise/status/${PHOTO[d.i][0]}`,
    fetch: d => `https://cdn.syndication.twimg.com/tweet-result?id=${PHOTO[d.i][0]}&token=4`, file: d => `photo/st${d.n}.json` },
];
