import crypto from 'crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
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
import { LogError, checkSeat, describeWithAi, logIncident, logOptions, scanTicket, searchRecords } from '../services/appLog';
import { FeedError, appEvents, editRecord, listFeed, removeRecord, type AppEvent } from '../services/appFeed';
import { can, type Action, type AppUser } from '../services/permissions';

/**
 * The Gatekeeper app's API (/api/app). Logged-in people carry an HttpOnly, SameSite=Strict session
 * cookie; every change must be sent as JSON, which a form on another site can't do.
 */

export const appApiRouter = Router();
const COOKIE = 'gk_session';

type AuthedRequest = Request & { user: AppUser; token: string };

const DEVICE_COOKIE = 'gk_device'; // this phone has logged in with the right PIN before (see accounts.ts)

function cookieToken(req: Request, name = COOKIE): string | undefined {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(v.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function setSession(req: Request, res: Response, s: { token: string; deviceToken: string }) {
  const base = { httpOnly: true, sameSite: 'strict' as const, secure: req.secure, path: '/' };
  res.cookie(COOKIE, s.token, { ...base, maxAge: SESSION_HOURS * 3_600_000 });
  res.cookie(DEVICE_COOKIE, s.deviceToken, { ...base, maxAge: 90 * 24 * 3_600_000 });
}

// Changes only as JSON (blocks cross-site form posts).
appApiRouter.use((req, res, next) => {
  const photo = req.path === '/scan-ticket' && req.is('image/*'); // a ticket photo (a cross-site form can't send this type)
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE' && !req.is('application/json') && !photo) {
    res.status(415).json({ ok: false, error: 'Send JSON' });
    return;
  }
  next();
});

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch((err) => {
      if (err instanceof AccountError || err instanceof LogError || err instanceof FeedError) {
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
    setSession(req, res, await login(user.name, req.body?.pin, Date.now(), req.ip ?? 'unknown'));
    res.json({ ok: true, user });
  }),
);

appApiRouter.post(
  '/login',
  wrap(async (req, res) => {
    const session = await login(req.body?.name, req.body?.pin, Date.now(), req.ip ?? 'unknown', cookieToken(req, DEVICE_COOKIE));
    setSession(req, res, session);
    const user = session.user;
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

// ---------------------------------------------------------------- logging and checking

const userOf = (req: Request) => (req as AuthedRequest).user;

appApiRouter.get('/options', allow('view'), (_req, res) => {
  res.json({ ok: true, ...logOptions() });
});

appApiRouter.post(
  '/logs',
  allow(),
  wrap(async (req, res) => {
    res.json({ ok: true, ...(await logIncident(userOf(req), req.body)) });
  }),
);

appApiRouter.get(
  '/seat',
  allow('view'),
  wrap(async (req, res) => {
    const record = await checkSeat(req.query);
    res.json({ ok: true, found: !!record, record });
  }),
);

appApiRouter.get(
  '/search',
  allow('view'),
  wrap(async (req, res) => {
    res.json({ ok: true, records: await searchRecords(req.query.q) });
  }),
);

appApiRouter.post(
  '/describe',
  allow(),
  wrap(async (req, res) => {
    res.json({ ok: true, fields: await describeWithAi(req.body?.text, userOf(req)) });
  }),
);

appApiRouter.post(
  '/scan-ticket',
  allow(),
  express.raw({ type: 'image/*', limit: '8mb' }),
  wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new LogError('Send a photo of the ticket.', 415);
    res.json({ ok: true, ...(await scanTicket(req.body)) });
  }),
);

// ---------------------------------------------------------------- live feed, alerts, editing

appApiRouter.get(
  '/feed',
  allow('view'),
  wrap(async (req, res) => {
    res.json({ ok: true, items: await listFeed(userOf(req)) });
  }),
);

/** Alerts pushed to open phones (server-sent events). Ends when the login does. */
appApiRouter.get('/stream', allow('view'), (req, res) => {
  const token = (req as AuthedRequest).token;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // don't let a proxy hold the events back
  });
  res.write(':ok\n\n');
  const send = (e: AppEvent) => res.write(`event: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
  appEvents.on('event', send);
  const beat = setInterval(async () => {
    if (await sessionUser(token).catch(() => null)) res.write(':beat\n\n');
    else res.end();
  }, 25_000);
  (beat as { unref?: () => void }).unref?.();
  req.on('close', () => {
    clearInterval(beat);
    appEvents.off('event', send);
  });
});

appApiRouter.patch(
  '/records/:id',
  allow(),
  wrap(async (req, res) => {
    await editRecord(userOf(req), String(req.params.id), req.body ?? {});
    res.json({ ok: true });
  }),
);

appApiRouter.delete(
  '/records/:id',
  allow(),
  wrap(async (req, res) => {
    await removeRecord(userOf(req), String(req.params.id));
    res.json({ ok: true });
  }),
);
