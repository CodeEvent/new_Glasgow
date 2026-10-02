import { getPool } from '../db/pool';
import type { BaileysModule } from './baileys';

/**
 * Baileys auth state kept in PostgreSQL (table wa_session) instead of files, so
 * a linked phone stays linked across restarts and redeploys on hosts with
 * throwaway disks (Render, Fly, Railway).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function usePostgresAuthState(b: Pick<BaileysModule, 'BufferJSON' | 'initAuthCreds' | 'proto'>) {
  const pool = getPool();
  const encode = (v: unknown) => JSON.stringify(v, b.BufferJSON.replacer);
  const decode = (s: string) => JSON.parse(s, b.BufferJSON.reviver);

  const read = async (keys: string[]): Promise<Map<string, any>> => {
    const { rows } = await pool.query<{ key: string; value: string }>('SELECT key, value FROM wa_session WHERE key = ANY($1)', [keys]);
    return new Map(rows.map((r) => [r.key, decode(r.value)]));
  };
  const write = (key: string, value: unknown) =>
    pool.query(
      `INSERT INTO wa_session (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = TIMEZONE('utc'::text, NOW())`,
      [key, encode(value)],
    );

  const creds = (await read(['creds'])).get('creds') ?? b.initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const found = await read(ids.map((id) => `${type}:${id}`));
          const out: Record<string, any> = {};
          for (const id of ids) {
            let value = found.get(`${type}:${id}`) ?? null;
            if (type === 'app-state-sync-key' && value) value = b.proto.Message.AppStateSyncKeyData.fromObject(value);
            out[id] = value;
          }
          return out;
        },
        set: async (data: Record<string, Record<string, unknown>>) => {
          const tasks: Promise<unknown>[] = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              const key = `${type}:${id}`;
              tasks.push(value ? write(key, value) : pool.query('DELETE FROM wa_session WHERE key = $1', [key]));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds).then(() => undefined),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Forget the linked phone entirely (used after a logout or an unlink from the phone). */
export async function clearPostgresAuthState(): Promise<void> {
  await getPool().query('DELETE FROM wa_session');
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { rows } = await getPool().query<{ value: T }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value ?? fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await getPool().query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = TIMEZONE('utc'::text, NOW())`,
    [key, JSON.stringify(value)],
  );
}
