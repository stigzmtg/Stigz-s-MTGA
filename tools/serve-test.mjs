// Serve dist/ for local browser tests, swapping CDN React for the local npm copy.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PORT = +(process.argv[2] || 8765);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.avif': 'image/avif', '.webmanifest': 'application/manifest+json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let file;
  if (p.startsWith('/vendor/')) file = path.resolve('node_modules', p.includes('react-dom') ? 'react-dom/umd/react-dom.production.min.js' : 'react/umd/react.production.min.js');
  else file = path.join(path.resolve('dist'), p);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  let body = fs.readFileSync(file);
  if (p === '/index.html') body = Buffer.from(body.toString().replace(/https:\/\/cdnjs[^"]+react-dom[^"]+/, '/vendor/react-dom.js').replace(/https:\/\/cdnjs[^"]+react\.production[^"]+/, '/vendor/react.js').replace(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/, ''));
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-length': body.length });
  res.end(body);
}).listen(PORT, () => console.log('serving on', PORT));
