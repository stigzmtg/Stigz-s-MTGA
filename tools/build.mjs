// Bundle the app with esbuild and write dist/ (self-hostable site) plus the artifact page.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { analyzeCard } from '../src/engine/support.js';

const DIST = path.resolve('dist');
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });

// per-card automation report used by the UI
// (every card: the ones loaded with the page and the rest of the pool in data/more, from tools/build-allcards.mjs)
const MORE = fs.existsSync('data/more.json') ? JSON.parse(fs.readFileSync('data/more.json', 'utf8')).shards : 0;
const moreFiles = Array.from({ length: MORE }, (_, i) => `more/cards-${i}.json`);
const cards = Object.assign({}, ...['cards.json', ...moreFiles].map(f => JSON.parse(fs.readFileSync(path.join('data', f), 'utf8'))));
const support = {};
for (const [name, text] of Object.entries(cards)) { const issues = analyzeCard(text); if (issues.length) support[name] = issues; }
fs.writeFileSync('data/support.json', JSON.stringify(support));
fs.rmSync(path.join(DIST, 'data', 'more'), { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'data', 'more'), { recursive: true });
const MTG_DATA = ['cards.json', 'tokens.json', 'decks.json', 'support.json', 'images.json', 'community.json', 'cardmeta.json', 'more.json', ...moreFiles];
for (const f of MTG_DATA) if (fs.existsSync(path.join('data', f))) fs.copyFileSync(path.join('data', f), path.join(DIST, 'data', f));
// the Pokémon and One Piece sides' data
for (const side of ['ptcg', 'optcg']) {
  fs.mkdirSync(path.join(DIST, 'data', side), { recursive: true });
  for (const f of ['cards.json', 'decks.json', 'images.json']) if (fs.existsSync(path.join('data', side, f))) fs.copyFileSync(path.join('data', side, f), path.join(DIST, 'data', side, f));
  if (!fs.existsSync(`data/${side}/images.json`)) fs.writeFileSync(path.join(DIST, 'data', side, 'images.json'), JSON.stringify({ v: 1, type: 'image/avif', packs: [], cards: {} }));
}
// no packed card images yet: an empty index keeps the page from requesting a missing file
if (!fs.existsSync('data/images.json')) fs.writeFileSync(path.join(DIST, 'data', 'images.json'), JSON.stringify({ v: 2, type: 'image/avif', packs: [], images: [], decks: {}, lobby: {}, tokens: {} }));
// cache-busting: a rebuilt picture pack keeps its file name, so its address carries a hash of its contents
// (img/ptcg-6.avif?v=1a2b3c4d), and the app asks for the data files with a hash of all of them, so browsers and
// the CDN never hand back last build's deck lists or pictures
const crypto = await import('node:crypto');
const hashOf = buf => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
for (const f of ['images.json', 'ptcg/images.json', 'optcg/images.json']) {
  const file = path.join(DIST, 'data', f);
  const ix = JSON.parse(fs.readFileSync(file, 'utf8'));
  ix.packs = (ix.packs || []).map(p => { const bare = p.split('?')[0]; const src = path.join(DIST, bare); return fs.existsSync(src) ? `${bare}?v=${hashOf(fs.readFileSync(src))}` : bare; });
  fs.writeFileSync(file, JSON.stringify(ix));
}
const dataHash = crypto.createHash('sha1');
for (const f of [...MTG_DATA, 'ptcg/cards.json', 'ptcg/decks.json', 'ptcg/images.json', 'optcg/cards.json', 'optcg/decks.json', 'optcg/images.json']) if (fs.existsSync(path.join(DIST, 'data', f))) dataHash.update(fs.readFileSync(path.join(DIST, 'data', f)));
const DATA_VERSION = dataHash.digest('hex').slice(0, 10);
// the version of the game rules: the engines, the AIs and the card and deck lists (not the screens or pictures).
// Friends' browsers must run the same one, or their games drift apart (src/net/version.js)
const rulesHash = crypto.createHash('sha1');
const sources = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'ui' ? [] : sources(path.join(dir, e.name))) : /\.jsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
for (const f of sources('src').sort()) rulesHash.update(fs.readFileSync(f));
for (const f of ['cards.json', 'tokens.json', 'decks.json', 'community.json', ...moreFiles, 'ptcg/cards.json', 'ptcg/decks.json', 'optcg/cards.json', 'optcg/decks.json']) if (fs.existsSync(path.join(DIST, 'data', f))) rulesHash.update(fs.readFileSync(path.join(DIST, 'data', f)));
const GAME_VERSION = rulesHash.digest('hex').slice(0, 10);

await build({
  entryPoints: ['src/ui/main.jsx'],
  bundle: true,
  minify: !process.env.NOMINIFY, // NOMINIFY=1 keeps names readable for profiling
  format: 'iife',
  target: ['es2020'],
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  loader: { '.jsx': 'jsx' },
  outfile: path.join(DIST, 'app.js'),
  legalComments: 'none',
  define: { __DATA_VERSION__: JSON.stringify(DATA_VERSION), __GAME_VERSION__: JSON.stringify(GAME_VERSION), __BUILD_TIME__: String(Date.now()) },
});
const APP_VERSION = hashOf(fs.readFileSync(path.join(DIST, 'app.js')));

// the Lotus Goats logo. The page's own marks (top bars, home page) carry small copies inline, so they also show on
// the claude.ai page; the website also gets app icons, a favicon and a link-preview picture made from it
const LOGO = 'src/ui/brand/lotus-goats.webp';
const NAVY = '#09132b';   // the logo's background, at its corners
let sharp = null;
try { sharp = (await import('sharp')).default; } catch (e) { console.warn('sharp missing: icons skipped, full-size logo inlined:', e.message); }
// the goat and lotus without the empty sky around them (the logo is 1254px square)
const mark = () => sharp(LOGO).extract({ left: 107, top: 95, width: 1040, height: 1040 });
const dataUri = async size => `data:image/webp;base64,${(sharp ? await mark().resize(size, size).webp({ quality: 82 }).toBuffer() : fs.readFileSync(LOGO)).toString('base64')}`;
const LOGO_MARK = await dataUri(96), LOGO_HERO = await dataUri(320);

// bigger screens get a bigger table: every pixel size of 3px or more in our stylesheets is multiplied by --s, which
// styles.css raises at wide, tall windows (1 on laptops). Media and container query conditions and url(...) contents stay as they are.
// (a negative size keeps its sign inside the calc: -16px -> calc(-16px * var(--s)), not the invalid -calc(16px * …))
const scalePx = css => css.replace(/(@(?:media|container)[^{]*\{)|(url\([^)]*\))|(-?\d*\.?\d+)px\b/g, (m, media, url, num) => (media || url || Math.abs(parseFloat(num)) < 3 ? m : `calc(${num}px * var(--s))`));
const css = (fs.readFileSync('src/ui/generated/symbols.css', 'utf8') + '\n' + scalePx(fs.readFileSync('src/ui/styles.css', 'utf8') + '\n' + fs.readFileSync('src/ptcg/ui/ptcg.css', 'utf8') + '\n' + fs.readFileSync('src/optcg/ui/optcg.css', 'utf8') + '\n' + fs.readFileSync('src/ui/home.css', 'utf8')))
  .replace('__LOGO_MARK__', LOGO_MARK).replace('__LOGO_HERO__', LOGO_HERO);
const fonts = 'https://fonts.googleapis.com/css2?family=Alegreya+Sans+SC:wght@500;700;800&family=Alegreya+Sans:wght@400;600;700;800&family=Alegreya:ital,wght@0,400;0,500;1,400&family=Cinzel:wght@600;700&display=swap';
const react = 'https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js';
const reactDom = 'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js';
const bodyWith = app => `<div id="root"></div>
<script src="${react}"></script>
<script src="${reactDom}"></script>
<script src="${app}"></script>`;
const body = bodyWith(`app.js?v=${APP_VERSION}`);
// what search engines and link previews show (lotusgoats.com is the home address; the other copies point to it)
const SITE = 'https://lotusgoats.com/';
const DESCRIPTION = 'Lotus Goats: play Magic: The Gathering Commander precons, top Pokémon TCG decks and One Piece Card Game starter decks in your browser, against the computer or with friends. Free, no download.';
const head = `<title>Lotus Goats</title>
<meta name="description" content="${DESCRIPTION}">
<link rel="canonical" href="${SITE}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Lotus Goats">
<meta property="og:title" content="Lotus Goats: Commander, Pokémon TCG and One Piece battles">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:url" content="${SITE}">
<meta property="og:image" content="${SITE}img/share.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The Lotus Goats logo: a white goat above a glowing pink lotus">
<meta name="twitter:card" content="summary_large_image">
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>${css}</style>`;
// artifact page: content only (the host adds the document skeleton)
fs.writeFileSync(path.join(DIST, 'artifact.html'), `${head}\n${bodyWith('app.js')}\n`);
// standalone site
fs.writeFileSync(path.join(DIST, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1a14">
<script>/* one address for everyone (saves and logins live per address): www.lotusgoats.com goes to lotusgoats.com */if (location.hostname === 'www.lotusgoats.com') location.replace('https://lotusgoats.com' + location.pathname + location.search + location.hash);</script>
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="img/icon-180.png">
<link rel="icon" href="favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" type="image/png" sizes="192x192" href="img/icon-192.png">
${head}
</head>
<body>
${body}
</body>
</html>
`);
// installable app: icons, manifest and the service worker (the website only; the claude.ai page can't use them)
if (sharp) {
  fs.mkdirSync(path.join(DIST, 'img'), { recursive: true });
  const rounded = (size, r) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}"/></svg>`);
  const png = img => img.png({ palette: true, quality: 95, effort: 10 });   // a quarter the size, no visible difference
  const roundIcon = (img, size) => png(img.resize(size, size).composite([{ input: rounded(size, Math.round(size * 0.22)), blend: 'dest-in' }]));
  await roundIcon(sharp(LOGO), 192).toFile(path.join(DIST, 'img', 'icon-192.png'));
  await roundIcon(sharp(LOGO), 512).toFile(path.join(DIST, 'img', 'icon-512.png'));
  // iPhones round the corners themselves
  await png(sharp(LOGO).resize(180, 180)).toFile(path.join(DIST, 'img', 'icon-180.png'));
  // Android crops maskable icons to as little as the middle 80%: the logo a little smaller, its sky mirrored outwards
  await png(sharp(await sharp(LOGO).resize(472, 472).toBuffer()).extend({ top: 20, bottom: 20, left: 20, right: 20, extendWith: 'mirror' })).toFile(path.join(DIST, 'img', 'icon-maskable-512.png'));
  // favicon.ico holding 16, 32 and 48px pictures (48px is what search results show)
  const pngs = [];
  for (const size of [16, 32, 48]) pngs.push([size, await roundIcon(mark(), size).toBuffer()]);
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let at = head.length;
  pngs.forEach(([size, png], i) => { const e = 6 + 16 * i; head[e] = size; head[e + 1] = size; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(at, e + 12); at += png.length; });
  fs.writeFileSync(path.join(DIST, 'favicon.ico'), Buffer.concat([head, ...pngs.map(p => p[1])]));
  // link previews (1200x630): the logo on a blurred, darkened stretch of itself
  const backdrop = await sharp(LOGO).resize(1200, 630, { fit: 'cover' }).blur(40).modulate({ brightness: 0.6 }).toBuffer();
  await sharp(backdrop).composite([{ input: await sharp(LOGO).resize(630, 630).toBuffer(), left: 285, top: 0 }]).jpeg({ quality: 86 }).toFile(path.join(DIST, 'img', 'share.jpg'));
}
fs.writeFileSync(path.join(DIST, 'manifest.webmanifest'), JSON.stringify({
  name: 'Lotus Goats', short_name: 'Lotus Goats', id: './', start_url: './', scope: './', display: 'standalone',
  description: 'Commander precons, top Pokémon TCG decks and One Piece starter decks against the computer or with friends.',
  background_color: NAVY, theme_color: '#0b1a14',
  icons: [
    { src: 'img/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'img/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'img/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2));
{
  const h = crypto.createHash('sha1');
  for (const f of ['app.js', 'index.html', 'data/decks.json', 'data/ptcg/decks.json', 'data/ptcg/cards.json', 'data/images.json', 'data/ptcg/images.json', 'data/optcg/decks.json', 'data/optcg/cards.json', 'data/optcg/images.json']) if (fs.existsSync(path.join(DIST, f))) h.update(fs.readFileSync(path.join(DIST, f)));
  fs.writeFileSync(path.join(DIST, 'sw.js'), fs.readFileSync('src/sw.js', 'utf8').replace('__VERSION__', h.digest('hex').slice(0, 12)));
}
const kb = f => (fs.statSync(path.join(DIST, f)).size / 1024).toFixed(0) + 'KB';
console.log('built', ['app.js', 'index.html', 'artifact.html', 'data/cards.json'].map(f => `${f} ${kb(f)}`).join(', '), `| ${Object.keys(cards).length} cards, ${Object.keys(support).length} flagged`);
