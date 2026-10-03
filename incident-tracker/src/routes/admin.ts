import path from 'path';
import { Router, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { getConfig } from '../config/env';
import { linkedWhatsApp } from '../channels/linkedWhatsApp';
import { adminAuth } from '../middleware/adminAuth';
import { deleteRecord, getPhoto, getRecord, listRecords, parseFilter, recordsToCsv, updateRecord } from '../services/adminRecords';

export const adminRouter = Router();

// The page itself holds no secrets; every action it takes needs the admin key.
adminRouter.get('/whatsapp', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', '..', 'public', 'admin-whatsapp.html'));
});

adminRouter.get('/records', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', '..', 'public', 'admin-records.html'));
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

// ---- records: everything stewards logged, for supervisors
const records = Router();
records.use(adminAuth);

records.get(
  '/',
  wrap(async (req, res) => {
    const rows = await listRecords(parseFilter(req.query as Record<string, unknown>));
    res.json({ ok: true, now: new Date(), records: rows });
  }),
);
records.get(
  '/export.csv',
  wrap(async (req, res) => {
    const rows = await listRecords(parseFilter(req.query as Record<string, unknown>), 10_000);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="gatekeeper-records-${stamp}.csv"`);
    res.send('\ufeff' + recordsToCsv(rows)); // BOM so Excel reads the emoji and accents
  }),
);
records.get(
  '/:id',
  wrap(async (req, res) => {
    const r = await getRecord(String(req.params.id));
    if (!r) return void res.status(404).json({ ok: false, error: 'Record not found (it may have been deleted)' });
    res.json({ ok: true, record: r });
  }),
);
records.get(
  '/:id/photos/:photoId',
  wrap(async (req, res) => {
    const p = await getPhoto(String(req.params.id), String(req.params.photoId));
    if (!p) return void res.status(404).json({ ok: false, error: 'Photo not found' });
    res.setHeader('Content-Type', /^image\/(jpeg|png|webp|gif)$/.test(p.mime) ? p.mime : 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(p.data);
  }),
);
records.patch(
  '/:id',
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const ok = await updateRecord(String(req.params.id), {
      status: b.status ?? undefined,
      description: typeof b.description === 'string' ? b.description : undefined,
      reasoning: typeof b.reasoning === 'string' ? b.reasoning : undefined,
    });
    if (!ok) return void res.status(404).json({ ok: false, error: 'Record not found (it may have been deleted)' });
    res.json({ ok: true, record: await getRecord(String(req.params.id)) });
  }),
);
records.delete(
  '/:id',
  wrap(async (req, res) => {
    const ok = await deleteRecord(String(req.params.id));
    res.status(ok ? 200 : 404).json({ ok, error: ok ? undefined : 'Record not found' });
  }),
);

adminRouter.use('/api/records', records);
