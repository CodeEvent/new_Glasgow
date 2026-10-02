import { Jimp } from 'jimp';
import jsQR from 'jsqr';

/**
 * Reads a QR code from a photo or screenshot (e.g. a Ticketmaster ticket on a
 * customer's phone). Returns the decoded text, or null when there's no QR.
 * Tries the full image first, then a downscaled copy, which helps with large,
 * noisy phone photos of screens.
 */
export async function decodeQrFromImage(image: Buffer): Promise<string | null> {
  let img;
  try {
    img = await Jimp.read(image);
  } catch {
    return null; // not an image we can read
  }
  const attempt = (w: number, h: number, data: Uint8ClampedArray) =>
    jsQR(data, w, h, { inversionAttempts: 'attemptBoth' })?.data ?? null;

  const full = img.bitmap;
  const MAX = 1600;
  if (Math.max(full.width, full.height) <= MAX) {
    const hit = attempt(full.width, full.height, new Uint8ClampedArray(full.data));
    if (hit) return hit;
  }
  for (const size of [1000, 640]) {
    if (Math.max(full.width, full.height) <= size) continue;
    const copy = img.clone();
    if (copy.bitmap.width >= copy.bitmap.height) copy.resize({ w: size });
    else copy.resize({ h: size });
    const hit = attempt(copy.bitmap.width, copy.bitmap.height, new Uint8ClampedArray(copy.bitmap.data));
    if (hit) return hit;
  }
  return null;
}

/** Ticket IDs are at most 64 characters; longer QR payloads are stored as a stable fingerprint. */
export async function ticketCodeFromQr(raw: string): Promise<string> {
  const value = raw.trim();
  if (value.length <= 64) return value;
  const { createHash } = await import('crypto');
  return `QR-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}
