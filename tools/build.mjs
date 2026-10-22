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
// the Pokémon side's data
fs.mkdirSync(path.join(DIST, 'data', 'ptcg'), { recursive: true });
for (const f of ['cards.json', 'decks.json', 'images.json']) if (fs.existsSync(path.join('data', 'ptcg', f))) fs.copyFileSync(path.join('data', 'ptcg', f), path.join(DIST, 'data', 'ptcg', f));
if (!fs.existsSync('data/ptcg/images.json')) fs.writeFileSync(path.join(DIST, 'data', 'ptcg', 'images.json'), JSON.stringify({ v: 1, type: 'image/avif', packs: [], cards: {} }));
// no packed card images yet: an empty index keeps the page from requesting a missing file
if (!fs.existsSync('data/images.json')) fs.writeFileSync(path.join(DIST, 'data', 'images.json'), JSON.stringify({ v: 2, type: 'image/avif', packs: [], images: [], decks: {}, lobby: {}, tokens: {} }));

await build({
  entryPoints: ['src/ui/main.jsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  loader: { '.jsx': 'jsx' },
  outfile: path.join(DIST, 'app.js'),
  legalComments: 'none',
});

const css = fs.readFileSync('src/ui/generated/symbols.css', 'utf8') + '\n' + fs.readFileSync('src/ui/styles.css', 'utf8') + '\n' + fs.readFileSync('src/ptcg/ui/ptcg.css', 'utf8') + '\n' + fs.readFileSync('src/ui/home.css', 'utf8');
const fonts = 'https://fonts.googleapis.com/css2?family=Alegreya+Sans+SC:wght@500;700;800&family=Alegreya+Sans:wght@400;600;700;800&family=Alegreya:ital,wght@0,400;0,500;1,400&family=Cinzel:wght@600;700&display=swap';
const react = 'https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js';
const reactDom = 'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js';
const body = `<div id="root"></div>
<script src="${react}"></script>
<script src="${reactDom}"></script>
<script src="app.js"></script>`;
const head = `<title>Stigz’s TCG Arena</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>${css}</style>`;
// artifact page: content only (the host adds the document skeleton)
fs.writeFileSync(path.join(DIST, 'artifact.html'), `${head}\n${body}\n`);
// standalone site
const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="14" y="6" width="36" height="52" rx="5" fill="#0f2a1f" stroke="#e3bf6b" stroke-width="4"/><circle cx="32" cy="32" r="9" fill="#e3bf6b"/></svg>')}`;
fs.writeFileSync(path.join(DIST, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Play Magic: The Gathering Commander precons and popular Pokémon TCG decks against the computer or with friends, right in your browser.">
<meta name="theme-color" content="#0b1a14">
<link rel="icon" href="${icon}">
${head}
</head>
<body>
${body}
</body>
</html>
`);
const kb = f => (fs.statSync(path.join(DIST, f)).size / 1024).toFixed(0) + 'KB';
console.log('built', ['app.js', 'index.html', 'artifact.html', 'data/cards.json'].map(f => `${f} ${kb(f)}`).join(', '), `| ${Object.keys(support).length} cards flagged`);
