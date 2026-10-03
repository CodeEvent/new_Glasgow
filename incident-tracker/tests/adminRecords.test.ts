import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { recordsToCsv } from '../src/services/adminRecords';
import { StewardBot } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const KEY = 'test-admin-key';
const app = createApp();
const get = (path: string) => request(app).get('/admin/api/records' + path).set('x-admin-key', KEY);

beforeAll(() => {
  process.env.ADMIN_API_KEY = KEY;
  resetConfigCache();
});

describe('records API auth', () => {
  it('needs the admin key', async () => {
    expect((await request(app).get('/admin/api/records/')).status).toBe(401);
    expect((await request(app).get('/admin/api/records/').set('x-admin-key', 'nope')).status).toBe(401);
    expect((await request(app).delete('/admin/api/records/X')).status).toBe(401);
  });

  it('serves the page without the key (the page holds no data)', async () => {
    const res = await request(app).get('/admin/records');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Gatekeeper Records');
  });
});

describe('CSV export', () => {
  it('quotes commas and neutralises spreadsheet formulas', () => {
    const csv = recordsToCsv([
      {
        ticket_id: 'SEAT-1', current_status: 'completely_refused', description: 'Male · green hat, "big"', reasoning: '=HYPERLINK("x")',
        cool_down_until: null, created_at: new Date(0), updated_at: new Date(0), section: '52', row_label: 'YY', seat_number: '14',
        origin_hub: 'West Hub', origin_steward: 'Dave', origin_at: new Date(0), breaches: 1, photos: 0,
      },
    ]);
    const line = csv.split('\r\n')[1];
    expect(line).toContain('"Male · green hat, ""big"""');
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line.startsWith('52,YY,14,Refused,')).toBe(true);
  });
});

describe.skipIf(!HAS_DB)('records API (PostgreSQL)', () => {
  let bot: StewardBot;
  const say = (senderId: string, text: string) =>
    bot.handle({ chatId: 'g@g.us', senderId, senderName: senderId === 'd' ? 'Dave' : 'Sarah', text, at: new Date() });

  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    bot = new StewardBot();
    await say('d', 'REFUSED 52 YY 14 West 1 M 2 2 adult green hat');
    await say('d', '30 BB 1 2 West 2 -');
    await say('s', '30 BB 1 2 South 2 -'); // hub-hop
  });
  afterAll(async () => {
    await closePool();
  });

  it('lists everything with first hub, steward and hub-hop count', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(2);
    const r = res.body.records.find((x: { section: string }) => x.section === '52');
    expect(r).toMatchObject({ current_status: 'completely_refused', reasoning: 'Intoxicated', origin_hub: 'West Hub', origin_steward: 'Dave', breaches: 0 });
    expect(r.description).toBe('Male · Average height · Average build · Adult · green hat');
    const hop = res.body.records.find((x: { section: string }) => x.section === 'BB');
    expect(hop.breaches).toBe(1);
  });

  it('searches and filters', async () => {
    expect((await get('/?q=52%20yy%2014')).body.records).toHaveLength(1);
    expect((await get('/?q=green')).body.records).toHaveLength(1);
    expect((await get('/?q=abusive')).body.records[0].section).toBe('BB');
    expect((await get('/?status=cooling_off')).body.records).toHaveLength(1);
    expect((await get('/?hub=South%20Hub')).body.records).toHaveLength(1);
    expect((await get('/?breaches=1')).body.records).toHaveLength(1);
    expect((await get('/?hub=Nowhere')).body.records).toHaveLength(2); // unknown filter values are ignored
  });

  it('shows one record with its history, edits it and deletes it', async () => {
    const id = (await get('/?q=BB')).body.records[0].ticket_id;
    const one = await get('/' + encodeURIComponent(id));
    expect(one.body.record.events.map((e: { action_logged: string }) => e.action_logged)).toEqual(['initial_cool_off', 'bypass_attempt']);

    const upd = await request(app)
      .patch('/admin/api/records/' + encodeURIComponent(id))
      .set('x-admin-key', KEY)
      .send({ status: 'completely_refused', reasoning: 'Abusive', description: 'Female · red coat' });
    expect(upd.status).toBe(200);
    expect(upd.body.record).toMatchObject({ current_status: 'completely_refused', cool_down_until: null, reasoning: 'Abusive', description: 'Female · red coat' });

    const back = await request(app).patch('/admin/api/records/' + encodeURIComponent(id)).set('x-admin-key', KEY).send({ status: 'cooling_off' });
    expect(new Date(back.body.record.cool_down_until).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);

    const bad = await request(app).patch('/admin/api/records/' + encodeURIComponent(id)).set('x-admin-key', KEY).send({ status: 'party' });
    expect(bad.status).toBe(400);

    expect((await request(app).delete('/admin/api/records/' + encodeURIComponent(id)).set('x-admin-key', KEY)).status).toBe(200);
    expect((await get('/' + encodeURIComponent(id))).status).toBe(404);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM scan_events WHERE ticket_id = $1', [id]);
    expect(rows[0].n).toBe(0);
  });

  it('exports CSV', async () => {
    const res = await get('/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/gatekeeper-records-.*\.csv/);
    expect(res.text).toContain('52,YY,14,Refused,Intoxicated,');
  });

  it('returns stored photos', async () => {
    const id = (await get('/?q=52')).body.records[0].ticket_id;
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const { rows } = await getPool().query<{ id: string }>(
      "INSERT INTO ticket_photos (ticket_id, mime_type, data) VALUES ($1, 'image/png', $2) RETURNING id",
      [id, png],
    );
    const res = await get(`/${encodeURIComponent(id)}/photos/${rows[0].id}`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect((await get(`/${encodeURIComponent(id)}/photos/not-a-uuid`)).status).toBe(404);
  });
});
