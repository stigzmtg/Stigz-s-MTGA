// Bundle the app with esbuild and write dist/ (self-hostable site) plus the artifact page.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { analyzeCard } from '../src/engine/support.js';

const DIST = path.resolve('dist');
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });

// per-card automation report used by the UI
const cards = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const support = {};
for (const [name, text] of Object.entries(cards)) { const issues = analyzeCard(text); if (issues.length) support[name] = issues; }
fs.writeFileSync('data/support.json', JSON.stringify(support));
for (const f of ['cards.json', 'tokens.json', 'decks.json', 'support.json', 'images.json']) if (fs.existsSync(path.join('data', f))) fs.copyFileSync(path.join('data', f), path.join(DIST, 'data', f));
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
for (const f of ['cards.json', 'tokens.json', 'decks.json', 'support.json', 'images.json', 'ptcg/cards.json', 'ptcg/decks.json', 'ptcg/images.json', 'optcg/cards.json', 'optcg/decks.json', 'optcg/images.json']) if (fs.existsSync(path.join(DIST, 'data', f))) dataHash.update(fs.readFileSync(path.join(DIST, 'data', f)));
const DATA_VERSION = dataHash.digest('hex').slice(0, 10);

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
  define: { __DATA_VERSION__: JSON.stringify(DATA_VERSION) },
});
const APP_VERSION = hashOf(fs.readFileSync(path.join(DIST, 'app.js')));

// bigger screens get a bigger table: every pixel size of 3px or more in our stylesheets is multiplied by --s, which
// styles.css raises at wide, tall windows (1 on laptops). Media and container query conditions and url(...) contents stay as they are.
// (a negative size keeps its sign inside the calc: -16px -> calc(-16px * var(--s)), not the invalid -calc(16px * …))
const scalePx = css => css.replace(/(@(?:media|container)[^{]*\{)|(url\([^)]*\))|(-?\d*\.?\d+)px\b/g, (m, media, url, num) => (media || url || Math.abs(parseFloat(num)) < 3 ? m : `calc(${num}px * var(--s))`));
const css = fs.readFileSync('src/ui/generated/symbols.css', 'utf8') + '\n' + scalePx(fs.readFileSync('src/ui/styles.css', 'utf8') + '\n' + fs.readFileSync('src/ptcg/ui/ptcg.css', 'utf8') + '\n' + fs.readFileSync('src/optcg/ui/optcg.css', 'utf8') + '\n' + fs.readFileSync('src/ui/home.css', 'utf8'));
const fonts = 'https://fonts.googleapis.com/css2?family=Alegreya+Sans+SC:wght@500;700;800&family=Alegreya+Sans:wght@400;600;700;800&family=Alegreya:ital,wght@0,400;0,500;1,400&family=Cinzel:wght@600;700&display=swap';
const react = 'https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js';
const reactDom = 'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js';
const bodyWith = app => `<div id="root"></div>
<script src="${react}"></script>
<script src="${reactDom}"></script>
<script src="${app}"></script>`;
const body = bodyWith(`app.js?v=${APP_VERSION}`);
const head = `<title>Stigz’s TCG Arena</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>${css}</style>`;
// artifact page: content only (the host adds the document skeleton)
fs.writeFileSync(path.join(DIST, 'artifact.html'), `${head}\n${bodyWith('app.js')}\n`);
// standalone site
const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="14" y="6" width="36" height="52" rx="5" fill="#0f2a1f" stroke="#e3bf6b" stroke-width="4"/><circle cx="32" cy="32" r="9" fill="#e3bf6b"/></svg>')}`;
fs.writeFileSync(path.join(DIST, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Play Magic: The Gathering Commander precons, popular Pokémon TCG decks and every One Piece Card Game starter deck against the computer or with friends, right in your browser.">
<meta name="theme-color" content="#0b1a14">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="img/icon-180.png">
<link rel="icon" href="${icon}">
${head}
</head>
<body>
${body}
</body>
</html>
`);
// installable app: icons, manifest and the service worker (the website only; the claude.ai page can't use them)
const crest = (x, y, scale) => `<g transform="translate(${x} ${y}) scale(${scale}) translate(-20 -20)"><rect x="9" y="7" width="17" height="24" rx="2.5" transform="rotate(-14 17 19)" fill="#1d4bb0" stroke="#ffd23f" stroke-width="1.6"/><rect x="14" y="8" width="17" height="24" rx="2.5" transform="rotate(10 22 20)" fill="#2e1f0d" stroke="#f3d488" stroke-width="1.6"/><path d="M22.6 14.5l2.4 4.4-2.4 4.4-2.4-4.4z" fill="#f3d488" transform="rotate(10 22 20)"/></g>`;
const iconSvg = (rounded, scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><radialGradient id="g" cx="50%" cy="38%" r="72%"><stop offset="0" stop-color="#21503a"/><stop offset="1" stop-color="#0a1812"/></radialGradient></defs><rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="url(#g)"/>${crest(256, 262, scale)}</svg>`;
try {
  const sharp = (await import('sharp')).default;
  fs.mkdirSync(path.join(DIST, 'img'), { recursive: true });
  for (const [file, size, rounded, scale] of [['icon-192.png', 192, true, 10], ['icon-512.png', 512, true, 10], ['icon-maskable-512.png', 512, false, 7.6], ['icon-180.png', 180, false, 9]]) {
    await sharp(Buffer.from(iconSvg(rounded, scale))).resize(size, size).png().toFile(path.join(DIST, 'img', file));
  }
} catch (e) { console.warn('icons skipped:', e.message); }
fs.writeFileSync(path.join(DIST, 'manifest.webmanifest'), JSON.stringify({
  name: 'Stigz’s TCG Arena', short_name: 'TCG Arena', id: './', start_url: './', scope: './', display: 'standalone',
  description: 'Commander precons, top Pokémon TCG decks and One Piece starter decks against the computer or with friends.',
  background_color: '#0b1913', theme_color: '#0b1a14',
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
console.log('built', ['app.js', 'index.html', 'artifact.html', 'data/cards.json'].map(f => `${f} ${kb(f)}`).join(', '), `| ${Object.keys(support).length} cards flagged`);
