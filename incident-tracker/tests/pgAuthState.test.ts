import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BaileysModule } from '../src/channels/baileys';
import { clearPostgresAuthState, getSetting, setSetting, usePostgresAuthState } from '../src/channels/pgAuthState';
import { closePool, getPool } from '../src/db/pool';
import { HAS_DB, resetDatabase } from './helpers';

describe.skipIf(!HAS_DB)('WhatsApp session stored in Postgres', () => {
  beforeEach(async () => {
    await resetDatabase();
    await clearPostgresAuthState();
    await getPool().query('DELETE FROM app_settings');
  });
  afterAll(async () => {
    await closePool();
  });

  it('round-trips credentials and keys with binary data intact', async () => {
    // Vitest can't run the app's dynamic-import loader, so import the library directly here.
    const b = (await import('@whiskeysockets/baileys')) as unknown as BaileysModule;
    const first = await usePostgresAuthState(b);
    const original = first.state.creds.noiseKey.private as Uint8Array;
    await first.saveCreds();
    await first.state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } } });

    // A fresh load (e.g. after a redeploy) sees the same identity and keys.
    const second = await usePostgresAuthState(b);
    expect(Buffer.from(second.state.creds.noiseKey.private as Uint8Array).equals(Buffer.from(original))).toBe(true);
    const keys = await second.state.keys.get('pre-key', ['1', '2']);
    expect(Buffer.from(keys['1'].public).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(keys['2']).toBeNull();

    await second.state.keys.set({ 'pre-key': { '1': null } });
    expect((await second.state.keys.get('pre-key', ['1']))['1']).toBeNull();
  });

  it('stores settings', async () => {
    expect(await getSetting('x', [])).toEqual([]);
    await setSetting('x', [{ jid: 'a@g.us', subject: 'Stewards' }]);
    expect(await getSetting('x', [])).toEqual([{ jid: 'a@g.us', subject: 'Stewards' }]);
  });
});
