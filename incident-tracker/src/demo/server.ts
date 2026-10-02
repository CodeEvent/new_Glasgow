/**
 * One-command local demo: real Express app + embedded PostgreSQL (PGlite) + mock WhatsApp.
 *
 *   npm run demo            -> http://localhost:3000/demo  (control room)
 *                              http://localhost:3000/      (real steward form)
 *
 * No Postgres install, no Meta account. Data lives in memory unless DEMO_DATA_DIR is set.
 */
import fs from 'fs';
import path from 'path';

const DEMO_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'pglite://embedded',
  WHATSAPP_ACCESS_TOKEN: 'demo-token',
  WHATSAPP_PHONE_NUMBER_ID: '100000000000000',
  WHATSAPP_GROUP_ID: 'DEMO-SUPERVISORS-GROUP',
  WHATSAPP_VERIFY_TOKEN: 'demo-verify-token',
  MOCK_WHATSAPP_API: 'true',
  MOCK_WHATSAPP_QUIET: 'true',
  OFFLINE_LOG_PATH: path.join('demo-data', 'offline_incidents.log'),
  OFFLINE_SYNC_INTERVAL_MS: '3000',
  TZ_DISPLAY: 'Europe/London',
};
// The demo is deliberately self-contained: it never reads .env, so it cannot touch a real database or Meta.
for (const [k, v] of Object.entries(DEMO_DEFAULTS)) process.env[k] = process.env[`DEMO_${k}`] ?? v;
delete process.env.STEWARD_API_KEY;
delete process.env.WHATSAPP_APP_SECRET;

const ROOT = path.resolve(__dirname, '..', '..');

async function main() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { validateEnvOrExit } = await import('../config/env');
  const { createApp } = await import('../app');
  const { createDemoEngine } = await import('./engine');
  const express = (await import('express')).default;

  const config = validateEnvOrExit();
  fs.mkdirSync(path.dirname(path.resolve(config.OFFLINE_LOG_PATH)), { recursive: true });

  const dataDir = process.env.DEMO_DATA_DIR;
  const db = dataDir ? await PGlite.create(path.resolve(dataDir)) : await PGlite.create();
  const migDir = path.join(ROOT, 'migrations');
  const migration = fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith('.up.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(migDir, f), 'utf8'))
    .join('\n');
  const engine = await createDemoEngine(db, migration);

  const ui = fs.readFileSync(path.join(ROOT, 'demo', 'ui.html'), 'utf8');
  const page =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    `</head><body><script>window.GK_MODE='server'</script>${ui}</body></html>`;

  const app = createApp({
    extend(app) {
      app.get('/demo', (_req, res) => {
        res.type('html').send(page);
      });

      const demo = express.Router();

      // Live feed of every message the engine "sends" to the WhatsApp group.
      demo.get('/feed', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        for (const m of engine.messages()) res.write(`data: ${JSON.stringify(m)}\n\n`);
        const off = engine.onMessage((m) => res.write(`data: ${JSON.stringify(m)}\n\n`));
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
        req.on('close', () => {
          off();
          clearInterval(ping);
        });
      });

      // A steward's message in the work group -> the WhatsApp group bot's conversation logic.
      demo.post('/chat', async (req, res) => {
        res.json(await engine.chat(String(req.body?.text ?? '').slice(0, 1000)));
      });

      demo.post('/outage', async (req, res) => {
        await engine.setOutage(Boolean(req.body?.down));
        res.json({ ok: true, down: engine.pool.isDown() });
      });
      demo.post('/time-travel', async (req, res) => {
        await engine.timeTravel(String(req.body?.ticket_id ?? ''), Number(req.body?.minutes ?? 30));
        res.json({ ok: true });
      });
      demo.post('/reset', async (_req, res) => {
        await engine.reset();
        res.json({ ok: true });
      });
      demo.get('/state', async (_req, res) => {
        res.json(await engine.state());
      });

      app.use('/demo/api', demo);
    },
  });

  app.listen(config.PORT, () => {
    const bar = '═'.repeat(58);
    console.log(`\n╔${bar}╗`);
    console.log(`  GATEKEEPER DEMO is running`);
    console.log(`  Control room ........ http://localhost:${config.PORT}/demo`);
    console.log(`  Steward phone form .. http://localhost:${config.PORT}/`);
    console.log(`  Database ............ embedded PostgreSQL (${dataDir ? `saved in ${dataDir}` : 'in memory'})`);
    console.log(`  WhatsApp ............ mocked (messages appear in the control room)`);
    console.log(`  Offline log ......... ${path.resolve(config.OFFLINE_LOG_PATH)}`);
    console.log(`╚${bar}╝\n`);
  });
}

main().catch((err) => {
  console.error('[demo] failed to start:', err);
  process.exit(1);
});
