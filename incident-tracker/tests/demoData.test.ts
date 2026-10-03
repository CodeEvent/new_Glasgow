import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { StewardBot } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const KEY = 'demo-test-key';
const app = createApp();

beforeAll(() => {
  process.env.ADMIN_API_KEY = KEY;
  resetConfigCache();
});

describe('demo data API: safety', () => {
  it('needs the admin key', async () => {
    expect((await request(app).post('/admin/api/demo/reset').send({ confirm: 'DELETE ALL' })).status).toBe(401);
  });
});

describe.skipIf(!HAS_DB)('demo data (PostgreSQL)', () => {
  const reset = (body: unknown) => request(app).post('/admin/api/demo/reset').set('x-admin-key', KEY).send(body as object);
  const q = async (sql: string) => (await getPool().query(sql)).rows;
  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('refuses without the exact confirmation', async () => {
    expect((await reset({})).status).toBe(400);
    expect((await reset({ confirm: 'yes' })).status).toBe(400);
  });

  it('deletes every real record and loads the demo records', async () => {
    await new StewardBot().handle({ chatId: 'g@g.us', senderId: 'real', senderName: 'Real Steward', text: 'REFUSED 999 Z 1 West 1 -', at: new Date() });
    const res = await reset({ confirm: 'DELETE ALL' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, deleted: 1 });
    expect(res.body.created).toBeGreaterThanOrEqual(12);

    expect(await q("SELECT 1 FROM tickets WHERE section = '999'")).toEqual([]); // the real one is gone
    expect(await q("SELECT 1 FROM scan_events WHERE steward_name NOT LIKE 'Demo%'")).toEqual([]);
    const tickets = await q('SELECT section, row_label, seat_number, current_status, reasoning, description, party_size, cool_down_until FROM tickets');
    const has = (fn: (t: Record<string, unknown>) => boolean) => tickets.some(fn);
    expect(has((t) => /^Ejected/.test(String(t.reasoning)))).toBe(true);
    expect(has((t) => String(t.reasoning).includes('Already refused, tried re-entry'))).toBe(true);
    expect(has((t) => t.current_status === 'admitted')).toBe(true);
    expect(has((t) => t.current_status === 'cooling_off' && new Date(t.cool_down_until as string) > new Date())).toBe(true);
    expect(has((t) => t.current_status === 'cooling_off' && new Date(t.cool_down_until as string) <= new Date())).toBe(true);
    expect(has((t) => String(t.description).includes('Minor (under 18)'))).toBe(true);
    expect(has((t) => Number(t.party_size) === 3)).toBe(true);
    expect(has((t) => String(t.reasoning).startsWith('Other:'))).toBe(true);
    expect((await q('SELECT count(*)::int AS n FROM ticket_notes'))[0].n).toBeGreaterThan(0);
    expect((await q('SELECT count(*)::int AS n FROM scan_events WHERE is_breach_event'))[0].n).toBeGreaterThan(0);
  });

  it('dates every demo action in the past, like a real night', async () => {
    const before = Date.now();
    await reset({ confirm: 'DELETE ALL' });
    const cleared = (await q("SELECT description FROM tickets WHERE section = '12'"))[0].description as string;
    const at = /Cleared by Demo · Sam (\d\d:\d\d)/.exec(cleared)?.[1];
    const fmt = (t: number) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(t));
    expect(at).toBe(fmt(before - 65 * 60_000)); // cleared 65 minutes before loading, not "now"
    const notes = await q('SELECT created_at FROM ticket_notes');
    for (const n of notes) expect(new Date(n.created_at as string).getTime()).toBeLessThan(before - 30 * 60_000);
  });

  it('can just clear, without loading demo records', async () => {
    await reset({ confirm: 'DELETE ALL' });
    const res = await reset({ confirm: 'DELETE ALL', demo: false });
    expect(res.body).toMatchObject({ ok: true, created: 0 });
    expect((await q('SELECT count(*)::int AS n FROM tickets'))[0].n).toBe(0);
  });

  it('keeps the WhatsApp link, groups, policy and map', async () => {
    await getPool().query("INSERT INTO app_settings (key, value) VALUES ('selected_groups', '[1]'::jsonb), ('refusal_policy', '{\"text\":\"x\"}'::jsonb) ON CONFLICT (key) DO NOTHING");
    await reset({ confirm: 'DELETE ALL' });
    expect((await q("SELECT key FROM app_settings WHERE key IN ('selected_groups', 'refusal_policy') ORDER BY key")).map((r) => r.key)).toEqual(['refusal_policy', 'selected_groups']);
  });
});
