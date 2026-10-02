// Minimal POSIX path helpers for the browser build.
function normalize(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}
export function resolve(...parts) {
  let acc = '/demo';
  for (const p of parts) acc = p.startsWith('/') ? p : `${acc}/${p}`;
  return normalize(acc);
}
export function join(...parts) { return normalize(parts.join('/')); }
export function dirname(p) { const n = normalize(p); return n.slice(0, n.lastIndexOf('/')) || '/'; }
export function basename(p) { return p.slice(p.lastIndexOf('/') + 1); }
export default { resolve, join, dirname, basename };
