// Builds the hosted demo into dist-web/: index.html (UI fragment), the bundled engine and PGlite's runtime files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-web');
const stub = (name) => path.join(root, 'demo', 'web-stubs', `${name}.js`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const env = {
  NODE_ENV: 'production',
  DATABASE_URL: 'pglite://browser',
  WHATSAPP_ACCESS_TOKEN: 'demo-token',
  WHATSAPP_PHONE_NUMBER_ID: '100000000000000',
  WHATSAPP_GROUP_ID: 'DEMO-SUPERVISORS-GROUP',
  WHATSAPP_VERIFY_TOKEN: 'demo-verify-token',
  MOCK_WHATSAPP_API: 'true',
  MOCK_WHATSAPP_QUIET: 'true',
  OFFLINE_LOG_PATH: '/demo/offline_incidents.log',
  OFFLINE_SYNC_INTERVAL_MS: '3000',
  TZ_DISPLAY: 'Europe/London',
};

await build({
  entryPoints: [path.join(root, 'src', 'demo', 'browser.ts')],
  outfile: path.join(out, 'gatekeeper-engine.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  loader: { '.sql': 'text' },
  plugins: [
    {
      // Swap Node-only modules for in-memory browser stubs (exact specifiers only).
      name: 'browser-stubs',
      setup(b) {
        const map = { fs: 'fs', 'fs/promises': 'fs-promises', path: 'path', crypto: 'crypto', express: 'express', pg: 'pg', jimp: 'jimp' };
        b.onResolve({ filter: /^(node:)?(fs|fs\/promises|path|crypto|express|pg|jimp)$/ }, (args) => ({
          path: stub(map[args.path.replace(/^node:/, '')]),
        }));
      },
    },
  ],
  define: {
    'process.env': 'globalThis.__GK_ENV',
    'import.meta.url': 'globalThis.__GK_BASE',
  },
  banner: {
    js: `globalThis.__GK_ENV=${JSON.stringify(env)};globalThis.__GK_BASE=document.baseURI;globalThis.process=globalThis.process||{env:globalThis.__GK_ENV,versions:{},platform:"browser"};`,
  },
  logLevel: 'warning',
});

const pg = path.join(root, 'node_modules', '@electric-sql', 'pglite', 'dist');
for (const f of ['pglite.wasm', 'initdb.wasm']) fs.copyFileSync(path.join(pg, f), path.join(out, f));
// Artifact hosting only serves web media types, so the filesystem bundle travels as gzip + base64 text.
const zlib = await import('node:zlib');
fs.writeFileSync(
  path.join(out, 'pglite-data.gz.b64.txt'),
  zlib.gzipSync(fs.readFileSync(path.join(pg, 'pglite.data')), { level: 9 }).toString('base64'),
);

// The page itself is a fragment: the artifact host (or demo/serve-web) wraps it in a document skeleton.
const ui = fs.readFileSync(path.join(root, 'demo', 'ui.html'), 'utf8');
const html = ui.replace(
  /(<title>[^<]*<\/title>)/,
  `$1\n<script>window.GK_MODE='browser'</script>\n<script src="gatekeeper-engine.js"></script>`,
);
fs.writeFileSync(path.join(out, 'index.html'), html);

for (const f of fs.readdirSync(out)) {
  console.log(`  dist-web/${f.padEnd(22)} ${(fs.statSync(path.join(out, f)).size / 1024 / 1024).toFixed(2)} MB`);
}
