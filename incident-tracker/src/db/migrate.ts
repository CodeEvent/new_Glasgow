import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

/**
 * Minimal migration runner. Applies migrations/NNN_name.up.sql in order (each in
 * its own transaction) and records them in schema_migrations; `down` reverts the latest.
 * Only needs DATABASE_URL, so it can run before the WhatsApp credentials exist.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

export async function migrate(direction: 'up' | 'down', databaseUrl = process.env.DATABASE_URL, steps = 1) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const client = new Client({
    connectionString: databaseUrl,
    ssl: ['true', '1'].includes((process.env.DATABASE_SSL ?? '').toLowerCase()) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    const applied = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const names = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.up.sql'))
      .map((f) => f.replace(/\.up\.sql$/, ''))
      .sort();

    const run = async (name: string, file: string, record: () => Promise<unknown>) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await record();
        await client.query('COMMIT');
        console.log(`[migrate] ${direction} ${name} ✓`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`[migrate] ${direction} ${name} failed: ${(err as Error).message}`);
      }
    };

    if (direction === 'up') {
      const pending = names.filter((n) => !applied.has(n));
      if (!pending.length) console.log('[migrate] nothing to apply');
      for (const name of pending) {
        await run(name, `${name}.up.sql`, () => client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]));
      }
    } else {
      const toRevert = names.filter((n) => applied.has(n)).reverse().slice(0, steps);
      if (!toRevert.length) console.log('[migrate] nothing to revert');
      for (const name of toRevert) {
        await run(name, `${name}.down.sql`, () => client.query('DELETE FROM schema_migrations WHERE name = $1', [name]));
      }
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const steps = Number(process.argv[3] ?? 1) || 1;
  migrate(direction, process.env.DATABASE_URL, steps).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
