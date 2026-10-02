// In-memory stand-in for the slice of node:fs the engine uses (offline log, dead-letter log).
const files = new Map();
const enoent = (p) => Object.assign(new Error(`ENOENT: no such file, '${p}'`), { code: 'ENOENT' });
const dirOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

export function existsSync(p) { return files.has(p); }
export function statSync(p) { if (!files.has(p)) throw enoent(p); return { size: files.get(p).length, isFile: () => true }; }
export function readFileSync(p) { if (!files.has(p)) throw enoent(p); return files.get(p); }
export function writeFileSync(p, data) { files.set(p, String(data)); }
export function appendFileSync(p, data) { files.set(p, (files.get(p) ?? '') + String(data)); }
export function renameSync(a, b) { if (!files.has(a)) throw enoent(a); files.set(b, files.get(a)); files.delete(a); }
export function rmSync(p) { files.delete(p); }
export function mkdirSync() {}
export function readdirSync(dir) {
  const d = dir.replace(/\/+$/, '') || '/';
  return [...files.keys()].filter((f) => dirOf(f) === d).map((f) => f.slice(f.lastIndexOf('/') + 1));
}
export default { existsSync, statSync, readFileSync, writeFileSync, appendFileSync, renameSync, rmSync, mkdirSync, readdirSync };
