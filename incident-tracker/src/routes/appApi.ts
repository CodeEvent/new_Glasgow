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
import {
  DashError,
  dashboard,
  endEvent,
  eventCsv,
  eventReport,
  getAppSettings,
  getMapImage,
  listEvents,
  mapInfo,
  publicAddress,
  putAppSettings,
  putBlock,
  putMapImage,
  removeBlock,
  startEvent,
} from '../services/appDashboard';
import { FeedError, appEvents, editRecord, listFeed, removeRecord, type AppEvent } from '../services/appFeed';
import { PhotoError, addPhoto, deletePhoto, getPhoto, listPhotos } from '../services/appPhotos';
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
  // A ticket photo or the seating plan (a cross-site form can't send an image type).
  const photo = (req.path === '/scan-ticket' || req.path === '/map/image' || /^\/records\/[^/]+\/photos$/.test(req.path)) && req.is('image/*');
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
      if (err instanceof AccountError || err instanceof LogError || err instanceof FeedError || err instanceof DashError || err instanceof PhotoError) {
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

appApiRouter.get(
  '/options',
  allow('view'),
  wrap(async (_req, res) => {
    res.json({ ok: true, ...(await logOptions()) });
  }),
);

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

// ---------------------------------------------------------------- dashboard, events, settings, map

appApiRouter.get(
  '/dashboard',
  allow('dashboard'),
  wrap(async (_req, res) => {
    res.json({ ok: true, ...(await dashboard()) });
  }),
);

appApiRouter.get(
  '/events',
  allow('events'),
  wrap(async (_req, res) => {
    res.json({ ok: true, events: await listEvents() });
  }),
);

appApiRouter.post(
  '/events/start',
  allow('events'),
  wrap(async (req, res) => {
    res.json({ ok: true, event: await startEvent(userOf(req), req.body?.name) });
  }),
);

appApiRouter.post(
  '/events/end',
  allow('events'),
  wrap(async (req, res) => {
    res.json({ ok: true, event: await endEvent(userOf(req)) });
  }),
);

appApiRouter.get(
  '/events/:id/report',
  allow('events'),
  wrap(async (req, res) => {
    res.json({ ok: true, ...(await eventReport(String(req.params.id))) });
  }),
);

appApiRouter.get(
  '/events/:id/records.csv',
  allow('events'),
  wrap(async (req, res) => {
    const { name, csv } = await eventCsv(String(req.params.id));
    const safe = name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="gatekeeper-${safe}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }),
);

appApiRouter.get(
  '/settings',
  allow('settings'),
  wrap(async (_req, res) => {
    res.json({ ok: true, settings: await getAppSettings(), ...(await publicAddress()) });
  }),
);

appApiRouter.put(
  '/settings',
  allow('settings'),
  wrap(async (req, res) => {
    res.json({ ok: true, settings: await putAppSettings(userOf(req), req.body ?? {}) });
  }),
);

appApiRouter.get(
  '/map',
  allow('dashboard'),
  wrap(async (_req, res) => {
    res.json({ ok: true, ...(await mapInfo()) });
  }),
);

appApiRouter.get(
  '/map/image',
  allow('dashboard'),
  wrap(async (_req, res) => {
    const img = await getMapImage();
    if (!img) throw new DashError('No plan uploaded yet.', 404);
    res.setHeader('content-type', img.mime);
    res.setHeader('cache-control', 'private, max-age=300');
    res.send(img.data);
  }),
);

appApiRouter.put(
  '/map/image',
  allow('settings'),
  express.raw({ type: 'image/*', limit: '10mb' }),
  wrap(async (req, res) => {
    await putMapImage(userOf(req), req.body, req.get('content-type') ?? '');
    res.json({ ok: true });
  }),
);

appApiRouter.put(
  '/map/blocks/:block',
  allow('settings'),
  wrap(async (req, res) => {
    res.json({ ok: true, blocks: await putBlock(userOf(req), String(req.params.block), req.body ?? {}) });
  }),
);

appApiRouter.delete(
  '/map/blocks/:block',
  allow('settings'),
  wrap(async (req, res) => {
    res.json({ ok: true, blocks: await removeBlock(userOf(req), String(req.params.block)) });
  }),
);

// ---------------------------------------------------------------- photos

appApiRouter.post(
  '/records/:id/photos',
  allow(),
  express.raw({ type: 'image/*', limit: '5mb' }),
  wrap(async (req, res) => {
    const photo = await addPhoto(userOf(req), String(req.params.id), req.query.kind, req.body, req.get('content-type') ?? '');
    res.json({ ok: true, photo });
  }),
);

appApiRouter.get(
  '/records/:id/photos',
  allow('view'),
  wrap(async (req, res) => {
    res.json({ ok: true, photos: await listPhotos(String(req.params.id)) });
  }),
);

appApiRouter.get(
  '/photos/:id',
  allow('view'),
  wrap(async (req, res) => {
    const p = await getPhoto(String(req.params.id));
    res.setHeader('content-type', p.mime);
    res.setHeader('cache-control', 'private, max-age=600');
    // A photo is only ever an image: no scripts, nothing else loaded, even if opened on its own.
    res.setHeader('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('content-disposition', 'inline');
    res.send(p.data);
  }),
);

appApiRouter.delete(
  '/photos/:id',
  allow(),
  wrap(async (req, res) => {
    await deletePhoto(userOf(req), String(req.params.id));
    res.json({ ok: true });
  }),
);
