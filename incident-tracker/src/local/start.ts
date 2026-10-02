/**
 * Run Gatekeeper on your own computer, for free: the real WhatsApp group bot
 * with its database saved in ./local-data (embedded PostgreSQL, nothing to install
 * or sign up for). Keep this running while you want the bot to answer.
 *
 *   npm run local      ->  open http://localhost:3000/admin/whatsapp and link the spare phone
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.resolve(process.env.LOCAL_DATA_DIR ?? path.join(ROOT, 'local-data'));
fs.mkdirSync(DATA, { recursive: true });

// The admin key protects the setup page. Made once, then reused.
const keyFile = path.join(DATA, 'admin-key.txt');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(12).toString('hex') + '\n', { mode: 0o600 });
const adminKey = fs.readFileSync(keyFile, 'utf8').trim();

Object.assign(process.env, {
  NODE_ENV: process.env.NODE_ENV ?? 'production',
  DATABASE_URL: 'pglite://local', // placeholder: the embedded database below is used instead
  WA_LINKED_ENABLED: 'true',
  ADMIN_API_KEY: adminKey,
  OFFLINE_LOG_PATH: path.join(DATA, 'offline_incidents.log'),
  PORT: process.env.PORT ?? '3000',
  // Only this computer can reach the server: nobody else on the Wi-Fi can open the setup page or the API.
  HOST: process.env.HOST ?? '127.0.0.1',
});
// Never pick up cloud WhatsApp settings from a .env file in local mode.
for (const k of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'STEWARD_API_KEY']) delete process.env[k];

async function migrate(db: import('@electric-sql/pglite').PGlite) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const dir = path.join(ROOT, 'migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.up.sql')).sort()) {
    const name = file.replace(/\.up\.sql$/, '');
    if (done.has(name)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    });
    console.log(`[local] database updated: ${name}`);
  }
}

async function main() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { setPool } = await import('../db/pool');
  const { createPglitePool } = await import('../demo/pgliteAdapter');

  const db = await PGlite.create(path.join(DATA, 'pgdata'));
  await migrate(db);
  setPool(createPglitePool(db));

  const close = () => db.close().catch(() => undefined);
  process.once('exit', close);

  // Start the normal server (it uses the pool set above).
  await import('../server');

  const port = process.env.PORT;
  const bar = '═'.repeat(64);
  console.log(`\n╔${bar}╗`);
  console.log('  GATEKEEPER is running on this computer');
  console.log(`  1. Open      http://localhost:${port}/admin/whatsapp`);
  console.log(`  2. Admin key ${adminKey}`);
  console.log('  3. Scan the QR with the spare phone (WhatsApp > Linked devices)');
  console.log('  4. Tick your work group, Save, Send test');
  console.log(`  Data is saved in ${DATA}`);
  console.log('  Keep this window open and the computer awake. Ctrl+C to stop.');
  console.log(`╚${bar}╝\n`);
}

main().catch((err) => {
  console.error('[local] failed to start:', err);
  process.exit(1);
});
