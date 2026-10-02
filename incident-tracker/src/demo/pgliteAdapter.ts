import type { PGlite } from '@electric-sql/pglite';
import type { PoolLike } from '../db/pool';

/**
 * Wraps an embedded PGlite database in the small slice of the pg.Pool API the
 * app uses. PGlite has a single backend, so "connections" are handed out one at
 * a time through a FIFO lock: a transaction holds the lock from connect() until
 * release(), and stand-alone pool.query() calls queue behind it. That gives the
 * same isolation the real pool gets from SELECT ... FOR UPDATE.
 *
 * `setOutage(true)` makes every call fail like an unreachable server, which
 * drives the offline-buffer path for demos.
 */
export interface PgliteDemoPool extends PoolLike {
  setOutage(down: boolean): void;
  isDown(): boolean;
  db: PGlite;
}

function outageError(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432 (simulated outage)'), { code: 'ECONNREFUSED' });
}

export function createPglitePool(db: PGlite): PgliteDemoPool {
  let down = false;
  let tail: Promise<void> = Promise.resolve();

  /** Resolves with a release function once the single backend is free. */
  function acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const ready = tail.then(() => release);
    tail = tail.then(() => held);
    return ready;
  }

  async function run(text: string, params?: unknown[]) {
    if (down) throw outageError();
    const res = await db.query(text, (params ?? []) as unknown[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length, fields: res.fields, command: '', oid: 0 };
  }

  const pool = {
    db,
    setOutage(v: boolean) {
      down = v;
    },
    isDown: () => down,
    async query(text: string, params?: unknown[]) {
      if (down) throw outageError();
      const release = await acquire();
      try {
        return await run(text, params);
      } finally {
        release();
      }
    },
    async connect() {
      if (down) throw outageError();
      const release = await acquire();
      let released = false;
      return {
        query: (text: string, params?: unknown[]) => run(text, params),
        release: () => {
          if (released) return;
          released = true;
          // A transaction abandoned mid-way must not leak into the next caller.
          db.query('ROLLBACK').catch(() => undefined).finally(release);
        },
      };
    },
    async end() {
      /* PGlite lifetime is owned by the caller */
    },
  };
  return pool as unknown as PgliteDemoPool;
}
