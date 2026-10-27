// Bundle the Cloudflare Worker (worker/index.js and what it imports, the Anthropic SDK included) into one file,
// worker/build/index.js, which wrangler.toml deploys. It's committed, so Cloudflare's build needs no npm install.
// Usage: node tools/build-worker.mjs (npm run site does it too)
import { build } from 'esbuild';

await build({
  entryPoints: ['worker/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser'],
  target: 'es2022',
  external: ['cloudflare:*'],
  outfile: 'worker/build/index.js',
  legalComments: 'none',
  banner: { js: '// Built by tools/build-worker.mjs from worker/index.js: edit the sources, not this file.' },
});
const fs = await import('node:fs');
console.log('built worker/build/index.js', (fs.statSync('worker/build/index.js').size / 1024).toFixed(0) + 'KB');
