import { Pool, PoolClient } from 'pg';
import { getConfig } from '../config/env';

/** The subset of pg.Pool the app uses, so an embedded engine (PGlite) can stand in for demos. */
export type PoolLike = Pick<Pool, 'query' | 'connect' | 'end'>;

let pool: PoolLike | null = null;

/** Replace the connection pool (demo / embedded database). */
export function setPool(custom: PoolLike | null): void {
  pool = custom;
}

export function getPool(): PoolLike {
  if (!pool) {
    const cfg = getConfig();
    const pgPool = new Pool({
      connectionString: cfg.DATABASE_URL,
      // Supabase requires TLS; its pooler presents a cert chain Node may not trust by default.
      ssl: cfg.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
      max: cfg.DB_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      application_name: 'hub-incident-tracker',
    });
    // An idle client erroring (e.g. DB restart) must not crash the process.
    pgPool.on('error', (err) => console.error('[db] idle client error:', err.message));
    pool = pgPool;
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/** Runs fn inside BEGIN/COMMIT, rolling back on any thrown error. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const CONNECTIVITY_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN',
]);

/**
 * True when the error means "the database is unreachable", as opposed to a
 * data/logic error. Only these errors are diverted to the offline buffer.
 */
export function isConnectivityError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code && CONNECTIVITY_CODES.has(e.code)) return true;
  // SQLSTATE class 08 = connection exception; 57P01-03 = admin shutdown / cannot connect now.
  if (e.code && (/^08/.test(e.code) || ['57P01', '57P02', '57P03', '53300'].includes(e.code))) return true;
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('connection terminated') ||
    msg.includes('timeout exceeded when trying to connect') ||
    msg.includes('connection refused') ||
    msg.includes('client has encountered a connection error')
  );
}
