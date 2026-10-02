import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Optional shared-key guard for steward endpoints. When STEWARD_API_KEY is set,
 * requests must send it in the `x-api-key` header. Unset = open (dev / closed networks only).
 */
export function stewardAuth(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.STEWARD_API_KEY?.trim();
  if (!key) return next();
  const given = Buffer.from(req.get('x-api-key') ?? '');
  const expected = Buffer.from(key);
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
  res.status(401).json({ ok: false, error: 'Invalid or missing x-api-key' });
}
