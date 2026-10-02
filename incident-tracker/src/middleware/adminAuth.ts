import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '../config/env';

/** Guards /admin APIs with ADMIN_API_KEY (header x-admin-key). Disabled entirely when no key is set. */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const key = getConfig().ADMIN_API_KEY;
  if (!key) {
    res.status(503).json({ ok: false, error: 'Admin is disabled: set ADMIN_API_KEY on the server' });
    return;
  }
  const given = Buffer.from(req.get('x-admin-key') ?? '');
  const expected = Buffer.from(key);
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
  res.status(401).json({ ok: false, error: 'Wrong admin key' });
}
