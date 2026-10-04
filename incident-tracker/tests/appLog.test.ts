import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { resetLoginLimits } from '../src/services/accounts';
import { setAppAi, setTicketReader } from '../src/services/appLog';
import { customOptions, refreshCustomOptions } from '../src/services/customOptions';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

describe.skipIf(!HAS_DB)('app logging (PostgreSQL)', () => {
  const KEY = 'test-admin-key-123456';
  const app = createApp();
  const json = (r: request.Test) => r.set('content-type', 'application/json');
  let gio: ReturnType<typeof request.agent>;
  let amy: ReturnType<typeof request.agent>; // area supervisor, West
  let sam: ReturnType<typeof request.agent>; // senior
  let amyId = '';
  let n = 0;
  const cid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const base = { decision: 'refused', seats: [{ section: '313', row: 'yy', seat: '56' }], reasons: ['Intoxicated'] };
  const log = (agent: ReturnType<typeof request.agent>, body: object) => json(agent.post('/api/app/logs')).send({ client_id: cid(), ...base, ...body });
  const ticket = async (seat: string) =>
    (await getPool().query("SELECT t.*, (SELECT array_agg(e.user_id) FROM scan_events e WHERE e.ticket_id = t.ticket_id) AS users FROM tickets t WHERE seat_number = $1", [seat])).rows[0];

  beforeAll(async () => {
    tempOfflineLog();
    process.env.ADMIN_API_KEY = KEY;
    resetConfigCache();
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
    await getPool().query("DELETE FROM app_sessions; DELETE FROM app_devices; DELETE FROM app_users; DELETE FROM audit_log; DELETE FROM app_log_requests; DELETE FROM app_settings WHERE key = 'custom_options'");
    await refreshCustomOptions();
    resetLoginLimits();
    setAppAi(undefined);
    gio = request.agent(app);
    await json(gio.post('/api/app/setup')).send({ admin_key: KEY, name: 'Gio', pin: '482913' });
    amyId = (await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' })).body.user.id;
    await json(gio.post('/api/app/users')).send({ name: 'Sam', role: 'senior', pin: '135791' });
    amy = request.agent(app);
    await json(amy.post('/api/app/login')).send({ name: 'Amy', pin: '246813' });
    sam = request.agent(app);
    await json(sam.post('/api/app/login')).send({ name: 'Sam', pin: '135791' });
  });
  afterAll(async () => {
    delete process.env.ADMIN_API_KEY;
    resetConfigCache();
    await closePool();
  });

  it('needs a login', async () => {
    expect((await json(request(app).post('/api/app/logs')).send(base)).status).toBe(401);
    expect((await request(app).get('/api/app/options')).status).toBe(401);
  });

  it('gives the options for the buttons', async () => {
    const r = await amy.get('/api/app/options');
    expect(r.body.reasons).toEqual(['Intoxicated', 'Abusive', 'Under the influence', 'Intoxicated minor', 'Found in possession', 'Other']);
    expect(r.body.heights).toEqual(['Short', 'Average height', 'Tall']);
    expect(r.body.builds).toEqual(['Slim', 'Average build', 'Heavy']);
    expect(r.body.ages).toEqual(['Adult', 'Minor (under 18)']);
    expect(r.body.hubs).toEqual(['East Hub', 'West Hub', 'South Hub', 'Hospitality Hub']);
    expect(r.body.cool_off_minutes).toBe(30);
    expect(r.body.ai).toBe(false);
  });

  it('an area supervisor logs in their own area (the default), with the full description', async () => {
    const r = await log(amy, { reasons: ['Intoxicated', 'Abusive'], gender: 'Male', height: 'Tall', build: 'Average build', age: 'Adult', clothing: 'green hat' });
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ seat: '313 YY 56', status: 'refused', block: true, reentry: false });
    const t = await ticket('56');
    expect(t.current_status).toBe('completely_refused');
    expect(t.reasoning).toBe('Intoxicated, Abusive');
    expect(t.description).toBe('Male · Tall · Average build · Adult · green hat');
    expect(t.users).toEqual([amyId]);
    const ev = (await getPool().query('SELECT hub_location, steward_name FROM scan_events')).rows[0];
    expect(ev).toEqual({ hub_location: 'West Hub', steward_name: 'Amy' });
  });

  it('an area supervisor can’t log in another area; a senior can', async () => {
    expect((await log(amy, { hub: 'East Hub' })).status).toBe(403);
    expect((await log(sam, { hub: 'East Hub' })).status).toBe(200);
    expect((await log(sam, {})).body.error).toMatch(/area/i); // seniors must say where
  });

  it('ejected and 30 minutes', async () => {
    await log(sam, { hub: 'South Hub', decision: 'ejected', reasons: ['Abusive'] });
    expect((await ticket('56')).reasoning).toBe('Ejected: Abusive');
    const r = await log(sam, { hub: 'South Hub', decision: 'cool_off', seats: [{ section: '313', row: 'YY', seat: '57' }] });
    expect(r.body.results[0]).toMatchObject({ status: 'sent_away', block: true });
    const t = await ticket('57');
    expect(t.current_status).toBe('cooling_off');
    const mins = (new Date(t.cool_down_until).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(28);
    expect(mins).toBeLessThanOrEqual(30);
  });

  it('a re-entry at another hub is flagged, and the reason added', async () => {
    await log(amy, {});
    const r = await log(sam, { hub: 'East Hub', reasons: ['Abusive'] });
    expect(r.body.results[0]).toMatchObject({ reentry: true, block: true, first_hub: 'West Hub', status: 'refused' });
    expect((await ticket('56')).reasoning).toBe('Intoxicated, Already refused, tried re-entry, Abusive');
  });

  it('several seats: one record each, as a group', async () => {
    const r = await log(amy, { seats: ['205', '206', '207'].map((seat) => ({ section: '300', row: 'L', seat })) });
    expect(r.body.results.map((x: { seat: string }) => x.seat)).toEqual(['300 L 205', '300 L 206', '300 L 207']);
    expect((await ticket('206')).party_size).toBe(3);
  });

  it('a resent log (offline queue) is saved once', async () => {
    const body = { client_id: cid(), ...base };
    const a = await json(amy.post('/api/app/logs')).send(body);
    const b = await json(amy.post('/api/app/logs')).send(body);
    expect(b.status).toBe(200);
    expect(b.body.results).toEqual(a.body.results);
    expect(b.body.duplicate).toBe(true);
    expect((await getPool().query('SELECT count(*)::int AS n FROM scan_events')).rows[0].n).toBe(1);
  });

  it('a log saved offline by someone else can’t be sent under your login', async () => {
    const r = await log(sam, { hub: 'East Hub', author_id: amyId });
    expect(r.status).toBe(409);
    expect((await log(amy, { author_id: amyId })).status).toBe(200);
  });

  it('keeps the time it was logged on the phone (offline)', async () => {
    const at = new Date(Date.now() - 20 * 60_000).toISOString();
    await log(amy, { decision: 'cool_off', occurred_at: at });
    const mins = (new Date((await ticket('56')).cool_down_until).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(8);
    expect(mins).toBeLessThanOrEqual(10);
  });

  it('explains what’s missing or wrong', async () => {
    expect((await log(amy, { reasons: [] })).body.error).toMatch(/reason/i);
    expect((await log(amy, { reasons: ['Other'] })).body.error).toMatch(/other/i);
    expect((await log(amy, { seats: [{ section: '313', row: 'YY', seat: '' }] })).body.error).toMatch(/seat/i);
    expect((await log(amy, { seats: [{ section: '3<1', row: 'YY', seat: '5' }] })).status).toBe(400);
    expect((await log(amy, { decision: 'maybe' })).status).toBe(400);
    expect((await log(amy, { seats: Array.from({ length: 21 }, (_, i) => ({ section: '1', row: 'A', seat: String(i + 1) })) })).body.error).toMatch(/20/);
    expect((await log(amy, { client_id: 'nope' })).status).toBe(400);
  });

  it('accepts a reason that isn’t on the list, and learns it quietly', async () => {
    await log(amy, { reasons: ['Intoxicated', ' trespassing '] });
    expect((await ticket('56')).reasoning).toBe('Intoxicated, Trespassing');
    expect(customOptions().reasons).toContain('Trespassing');
    expect((await amy.get('/api/app/options')).body.reasons).not.toContain('Trespassing');
    expect((await log(amy, { reasons: ['Other'], other_reason: 'threw a bottle' , seats: [{ section: '1', row: 'A', seat: '1' }] })).status).toBe(200);
    expect((await ticket('1')).reasoning).toBe('Other: threw a bottle');
  });

  it('checks a seat as it’s typed (for the re-entry warning)', async () => {
    expect((await amy.get('/api/app/seat?section=313&row=YY&seat=56')).body).toMatchObject({ ok: true, found: false });
    await log(sam, { hub: 'East Hub', decision: 'ejected', reasons: ['Abusive'], gender: 'Male' });
    const r = await amy.get('/api/app/seat?section=313&row=yy&seat=56');
    expect(r.body).toMatchObject({ ok: true, found: true, record: { seat: '313 YY 56', status: 'ejected', first_hub: 'East Hub', by: 'Sam', description: 'Male' } });
  });

  it('searches a section or a row', async () => {
    await log(amy, { seats: ['1', '2'].map((seat) => ({ section: '313', row: 'L', seat })) });
    await log(amy, { seats: [{ section: '313', row: 'M', seat: '9' }] });
    expect((await amy.get('/api/app/search?q=313')).body.records).toHaveLength(3);
    expect((await amy.get('/api/app/search?q=313 L')).body.records).toHaveLength(2);
    expect((await amy.get('/api/app/search?q=green')).body.records).toHaveLength(0);
  });

  it('fills the description from a sentence with the AI, when it’s on', async () => {
    expect((await json(amy.post('/api/app/describe')).send({ text: 'tall lad green hat' })).status).toBe(503);
    setAppAi({
      handle: async () => ({ kind: 'answer', text: '' }),
      describe: async () => ({ gender: 'Male', height: 'Tall', clothing: 'green hat' }),
    });
    expect((await amy.get('/api/app/options')).body.ai).toBe(true);
    const r = await json(amy.post('/api/app/describe')).send({ text: 'tall lad green hat' });
    expect(r.body).toMatchObject({ ok: true, fields: { gender: 'Male', height: 'Tall', clothing: 'green hat' } });
  });

  it('reads the seat from a ticket photo', async () => {
    setTicketReader(async () => ({ seats: [{ section: '313', row: 'YY', seat: '56' }], code: null }));
    const r = await amy.post('/api/app/scan-ticket').set('content-type', 'image/jpeg').send(Buffer.from('fake-jpeg'));
    expect(r.body).toMatchObject({ ok: true, seats: [{ section: '313', row: 'YY', seat: '56' }] });
    expect((await amy.post('/api/app/scan-ticket').set('content-type', 'text/plain').send('x')).status).toBe(415);
  });
});
