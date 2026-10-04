import crypto from 'crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { getConfig } from '../config/env';
import {
  AccountError,
  SESSION_HOURS,
  audit,
  createUser,
  deleteUser,
  hasUsers,
  listUsers,
  login,
  logout,
  sessionUser,
  updateUser,
} from '../services/accounts';
import { can, type Action, type AppUser } from '../services/permissions';

/**
 * The Gatekeeper app's API (/api/app). Logged-in people carry an HttpOnly, SameSite=Strict session
 * cookie; every change must be sent as JSON, which a form on another site can't do.
 */

export const appApiRouter = Router();
const COOKIE = 'gk_session';

type AuthedRequest = Request & { user: AppUser; token: string };

function cookieToken(req: Request): string | undefined {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setSession(req: Request, res: Response, token: string) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: SESSION_HOURS * 3_600_000 });
}

// Changes only as JSON (blocks cross-site form posts).
appApiRouter.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE' && !req.is('application/json')) {
    res.status(415).json({ ok: false, error: 'Send JSON' });
    return;
  }
  next();
});

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch((err) => {
      if (err instanceof AccountError) {
        res.status(err.status).json({ ok: false, error: err.message });
        return;
      }
      next(err);
    });

/** Logged in, and (optionally) allowed to do `action`. */
function allow(action?: Action) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = cookieToken(req);
    sessionUser(token)
      .then(async (user) => {
        if (!user) {
          res.status(401).json({ ok: false, error: 'Please log in.', needs_setup: !(await hasUsers()) });
          return;
        }
        if (action && !can(user, action)) {
          res.status(403).json({ ok: false, error: 'You don’t have permission for that.' });
          return;
        }
        Object.assign(req, { user, token });
        next();
      })
      .catch(next);
  };
}

// ---------------------------------------------------------------- setup, login, logout

/** First run only: the person with the server's admin key creates the superadmin. */
appApiRouter.post(
  '/setup',
  wrap(async (req, res) => {
    const key = getConfig().ADMIN_API_KEY;
    const given = Buffer.from(String(req.body?.admin_key ?? ''));
    if (!key || given.length !== Buffer.from(key).length || !crypto.timingSafeEqual(given, Buffer.from(key))) {
      res.status(401).json({ ok: false, error: 'Wrong admin key (the one printed when the server was installed).' });
      return;
    }
    if (await hasUsers()) {
      res.status(409).json({ ok: false, error: 'Already set up. Log in instead.' });
      return;
    }
    const user = await createUser({ name: req.body?.name, role: 'superadmin', pin: req.body?.pin }, null);
    await audit(user, 'setup', `${user.name} set up the app`);
    const { token } = await login(user.name, req.body?.pin);
    setSession(req, res, token);
    res.json({ ok: true, user });
  }),
);

appApiRouter.post(
  '/login',
  wrap(async (req, res) => {
    const { user, token } = await login(req.body?.name, req.body?.pin);
    setSession(req, res, token);
    res.json({ ok: true, user });
  }),
);

appApiRouter.post(
  '/logout',
  wrap(async (req, res) => {
    await logout(cookieToken(req));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  }),
);

appApiRouter.get('/me', allow(), (req, res) => {
  res.json({ ok: true, user: (req as AuthedRequest).user });
});

// ---------------------------------------------------------------- accounts (superadmin)

appApiRouter.get(
  '/users',
  allow('users'),
  wrap(async (_req, res) => {
    res.json({ ok: true, users: await listUsers() });
  }),
);

appApiRouter.post(
  '/users',
  allow('users'),
  wrap(async (req, res) => {
    res.json({ ok: true, user: await createUser(req.body ?? {}, (req as AuthedRequest).user) });
  }),
);

appApiRouter.patch(
  '/users/:id',
  allow('users'),
  wrap(async (req, res) => {
    res.json({ ok: true, user: await updateUser(String(req.params.id), req.body ?? {}, (req as AuthedRequest).user) });
  }),
);

appApiRouter.delete(
  '/users/:id',
  allow('users'),
  wrap(async (req, res) => {
    await deleteUser(String(req.params.id), (req as AuthedRequest).user);
    res.json({ ok: true });
  }),
);
