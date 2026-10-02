import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getPool } from './db/pool';
import { hasPendingOfflineIncidents } from './services/offlineBuffer';
import { scanRouter } from './routes/scan';
import { whatsappWebhookRouter } from './routes/whatsappWebhook';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // Keep the raw bytes so the WhatsApp webhook signature can be verified.
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/readyz', async (_req, res) => {
    const pending = hasPendingOfflineIncidents();
    try {
      await getPool().query('SELECT 1');
      res.json({ ok: true, database: 'up', offline_backlog: pending });
    } catch {
      res.status(503).json({ ok: false, database: 'down', offline_backlog: pending });
    }
  });

  app.use('/api', scanRouter);
  app.use('/api/whatsapp', whatsappWebhookRouter);

  // Steward intake form (mobile web app).
  app.use(express.static(path.resolve(__dirname, '..', 'public'), { maxAge: '5m' }));

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, error: 'Malformed JSON body' });
      return;
    }
    console.error('[http] unhandled error:', err);
    res.status(err.status ?? 500).json({ ok: false, error: 'Internal server error' });
  });

  return app;
}
