// Serves dist-web/ locally the way the artifact host does: page fragment wrapped in a skeleton,
// strict CSP (scripts and fetches only from this origin, WebAssembly allowed). Usage: node demo/serve-web.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist-web');
const port = Number(process.argv[2] ?? 4173);
const types = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const csp = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "connect-src 'self'",
  "img-src 'self' data:",
].join('; ');

http
  .createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(dir, path.normalize(name));
    if (!file.startsWith(dir) || !fs.existsSync(file)) return res.writeHead(404).end('not found');
    let body = fs.readFileSync(file);
    if (name === 'index.html') {
      body = Buffer.from(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>' +
          body.toString('utf8') + '</body></html>',
      );
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': csp });
    res.end(body);
  })
  .listen(port, () => console.log(`Hosted demo preview: http://localhost:${port}/`));
