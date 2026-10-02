// The browser demo is text-only; photo handling (QR reading) runs on the real server.
export const Jimp = { read: async () => { throw new Error('photos are not supported in the browser demo'); } };
export default { Jimp };
