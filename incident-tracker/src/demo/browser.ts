/**
 * Browser entry for the hosted demo. Bundled by demo/build-web.mjs together with
 * the real engine modules; Node built-ins are swapped for small in-memory stubs.
 */
import { PGlite } from '@electric-sql/pglite';
// esbuild inlines the migration file as a string (text loader).
import migration001 from '../../migrations/001_init_incident_schema.up.sql';
import migration002 from '../../migrations/002_seat_location.up.sql';
import { createDemoEngine, type DemoEngine } from './engine';

declare global {
  interface Window {
    gatekeeperReady: Promise<DemoEngine>;
  }
}

async function loadWasm(url: string): Promise<WebAssembly.Module> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch ${url} (HTTP ${res.status})`);
  // compileStreaming needs an application/wasm content type; fall back if the host serves something else.
  if (WebAssembly.compileStreaming && res.headers.get('content-type')?.includes('application/wasm')) {
    return WebAssembly.compileStreaming(res);
  }
  return WebAssembly.compile(await res.arrayBuffer());
}

/**
 * PostgreSQL's filesystem bundle ships as gzip + base64 text, because the artifact
 * host only serves web media types. Decoded here with the browser's own gzip support.
 */
async function loadFsBundle(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch ${url} (HTTP ${res.status})`);
  const b64 = (await res.text()).trim();
  const bin = atob(b64);
  const gz = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) gz[i] = bin.charCodeAt(i);
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).blob();
}

window.gatekeeperReady = (async () => {
  const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
    loadWasm('pglite.wasm'),
    loadWasm('initdb.wasm'),
    loadFsBundle('pglite-data.gz.b64.txt'),
  ]);
  const db = await PGlite.create({ pgliteWasmModule, initdbWasmModule, fsBundle });
  return createDemoEngine(db, [migration001, migration002].join('\n'));
})();
