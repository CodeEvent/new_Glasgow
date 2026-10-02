import path from 'path';
import { Router, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { getConfig } from '../config/env';
import { linkedWhatsApp } from '../channels/linkedWhatsApp';
import { adminAuth } from '../middleware/adminAuth';

export const adminRouter = Router();

// The page itself holds no secrets; every action it takes needs the admin key.
adminRouter.get('/whatsapp', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', '..', 'public', 'admin-whatsapp.html'));
});

const api = Router();
api.use(adminAuth);

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) =>
    fn(req, res).catch((err) => res.status(400).json({ ok: false, error: (err as Error).message }));

api.get(
  '/status',
  wrap(async (_req, res) => {
    const cfg = getConfig();
    const wa = linkedWhatsApp;
    res.json({
      ok: true,
      enabled: cfg.WA_LINKED_ENABLED,
      post_alerts: cfg.WA_LINKED_POST_ALERTS,
      status: cfg.WA_LINKED_ENABLED ? wa.status : 'disabled',
      me: wa.me,
      last_error: wa.lastError,
      qr: wa.qr ? await QRCode.toDataURL(wa.qr, { margin: 1, width: 320 }) : null,
      groups: wa.groups,
      unselected_groups_with_activity: wa.seenGroups.size,
    });
  }),
);
api.post(
  '/pair',
  wrap(async (req, res) => {
    const code = await linkedWhatsApp.pairingCode(String(req.body?.phone ?? ''));
    res.json({ ok: true, code: code.match(/.{1,4}/g)?.join('-') ?? code });
  }),
);
api.get(
  '/groups',
  wrap(async (_req, res) => {
    res.json({ ok: true, groups: await linkedWhatsApp.listGroups() });
  }),
);
api.post(
  '/groups',
  wrap(async (req, res) => {
    const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
    await linkedWhatsApp.setGroups(groups.map((g: { jid?: unknown; subject?: unknown }) => ({ jid: String(g.jid ?? ''), subject: String(g.subject ?? '') })));
    res.json({ ok: true, groups: linkedWhatsApp.groups });
  }),
);
api.post(
  '/test',
  wrap(async (req, res) => {
    await linkedWhatsApp.sendTest(String(req.body?.jid ?? ''));
    res.json({ ok: true });
  }),
);
api.post(
  '/logout',
  wrap(async (_req, res) => {
    await linkedWhatsApp.logout();
    res.json({ ok: true });
  }),
);

adminRouter.use('/api/whatsapp', api);
