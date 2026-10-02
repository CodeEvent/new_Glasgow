// Route definitions are inert in the browser demo; the UI calls the handlers directly.
export function Router() { const r = { get: () => r, post: () => r, use: () => r }; return r; }
export default Object.assign(() => { throw new Error('express is not available in the browser demo'); }, { Router });
