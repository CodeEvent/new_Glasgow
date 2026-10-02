export function randomUUID() { return globalThis.crypto.randomUUID(); }
export function createHmac() { throw new Error('createHmac is not available in the browser demo'); }
export function timingSafeEqual(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
export default { randomUUID, createHmac, timingSafeEqual };
