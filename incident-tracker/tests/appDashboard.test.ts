import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { resetLoginLimits } from '../src/services/accounts';
import { setAppAi } from '../src/services/appLog';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe.skipIf(!HAS_DB)('dashboard, events and settings (PostgreSQL)', () => {
  const KEY = 'test-admin-key-123456';
  const app = createApp();
  const json = (r: request.Test) => r.set('content-type', 'application/json');
  type Agent = ReturnType<typeof request.agent>;
  let gio: Agent; // superadmin
  let amy: Agent; // area, West
  let sam: Agent; // senior
  let n = 0;
  const cid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const log = (agent: Agent, body: object) =>
    json(agent.post('/api/app/logs')).send({ client_id: cid(), decision: 'refused', seats: [{ section: '313', row: 'YY', seat: '56' }], reasons: ['Intoxicated'], ...body });

  beforeAll(async () => {
    tempOfflineLog();
    process.env.ADMIN_API_KEY = KEY;
    resetConfigCache();
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
    await getPool().query(
      "DELETE FROM app_sessions; DELETE FROM app_devices; DELETE FROM app_users; DELETE FROM audit_log; DELETE FROM app_log_requests; DELETE FROM venue_events; DELETE FROM venue_map; DELETE FROM app_settings WHERE key IN ('refusal_policy', 'app_settings', 'map_blocks')",
    );
    resetLoginLimits();
    setAppAi({ handle: async () => ({ kind: 'answer', text: '' }), describe: async () => ({ gender: 'Male' }) });
    gio = request.agent(app);
    await json(gio.post('/api/app/setup')).send({ admin_key: KEY, name: 'Gio', pin: '482913' });
    await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' });
    await json(gio.post('/api/app/users')).send({ name: 'Sam', role: 'senior', pin: '135791' });
    amy = request.agent(app);
    await json(amy.post('/api/app/login')).send({ name: 'Amy', pin: '246813' });
    sam = request.agent(app);
    await json(sam.post('/api/app/login')).send({ name: 'Sam', pin: '135791' });
  });
  afterAll(async () => {
    setAppAi(undefined);
    delete process.env.ADMIN_API_KEY;
    resetConfigCache();
    await closePool();
  });

  it('only seniors and the superadmin see the dashboard and events; only the superadmin the settings', async () => {
    for (const path of ['/api/app/dashboard', '/api/app/events', '/api/app/settings']) expect((await amy.get(path)).status).toBe(403);
    expect((await sam.get('/api/app/dashboard')).status).toBe(200);
    expect((await sam.get('/api/app/events')).status).toBe(200);
    expect((await sam.get('/api/app/settings')).status).toBe(403);
    expect((await json(sam.put('/api/app/settings')).send({ policy: 'x' })).status).toBe(403);
    expect((await gio.get('/api/app/settings')).status).toBe(200);
    expect((await json(amy.post('/api/app/events/start')).send({ name: 'Match' })).status).toBe(403);
  });

  it('counts tonight: by status, area, reason and hour, plus re-entries, people and minors', async () => {
    await log(amy, { reasons: ['Intoxicated', 'Abusive'], party: 3, seats: ['1', '2', '3'].map((seat) => ({ section: '313', row: 'L', seat })) });
    await log(sam, { hub: 'East Hub', decision: 'ejected', reasons: ['Abusive'], seats: [{ section: '200', row: 'B', seat: '9' }], age: 'Minor (under 18)' });
    await log(sam, { hub: 'South Hub', decision: 'cool_off', reasons: ['Under the influence'], seats: [{ section: '200', row: 'B', seat: '10' }] });
    await log(sam, { hub: 'East Hub', reasons: ['Abusive'], seats: [{ section: '313', row: 'L', seat: '1' }] }); // re-entry
    const d = (await sam.get('/api/app/dashboard')).body;
    expect(d.counts).toMatchObject({ logged: 5, refused: 3, ejected: 1, away_now: 1, back_soon: 1, cleared: 0, reentries: 1, minors: 1 });
    expect(d.counts.people).toBe(3 * 3 + 1 + 1); // three records of a group of 3, plus two people
    expect(d.by_hub).toEqual({ 'East Hub': 1, 'West Hub': 3, 'South Hub': 1, 'Hospitality Hub': 0 });
    expect(d.by_reason[0]).toEqual({ reason: 'Abusive', count: 4 }); // 313 L 1 already had it
    expect(d.by_reason.find((r: { reason: string }) => r.reason === 'Intoxicated').count).toBe(3);
    expect(d.by_hour.reduce((s: number, h: { count: number }) => s + h.count, 0)).toBe(5);
    expect(d.sections['313']).toMatchObject({ refused: 3, total: 3 });
    expect(d.sections['200']).toMatchObject({ ejected: 1, away: 1, total: 2 });
    expect(d.event).toBeNull();
  });

  it('events: start, one at a time, end with the final numbers kept; report and spreadsheet', async () => {
    await log(amy, { seats: [{ section: '1', row: 'A', seat: '1' }] }); // before the event
    expect((await json(sam.post('/api/app/events/start')).send({ name: '' })).status).toBe(400);
    const start = await json(sam.post('/api/app/events/start')).send({ name: 'Celtic v Rangers' });
    expect(start.status).toBe(200);
    expect((await json(gio.post('/api/app/events/start')).send({ name: 'Another' })).status).toBe(409);
    await new Promise((r) => setTimeout(r, 20));
    await log(amy, { seats: [{ section: '2', row: 'B', seat: '2' }], clothing: '=HYPERLINK("x")' });
    await log(sam, { hub: 'East Hub', decision: 'ejected', reasons: ['Abusive'], seats: [{ section: '3', row: 'C', seat: '3' }] });
    const live = (await sam.get('/api/app/dashboard')).body;
    expect(live.event).toMatchObject({ name: 'Celtic v Rangers' });
    expect(live.counts.logged).toBe(2); // only since the event started
    const end = await json(sam.post('/api/app/events/end')).send({});
    expect(end.status).toBe(200);
    expect(end.body.event.summary.counts).toMatchObject({ logged: 2, refused: 1, ejected: 1 });
    expect((await json(sam.post('/api/app/events/end')).send({})).status).toBe(409);
    const list = (await sam.get('/api/app/events')).body.events;
    expect(list[0]).toMatchObject({ name: 'Celtic v Rangers', started_by: 'Sam', ended_by: 'Sam' });
    const id = list[0].id;
    const report = (await sam.get(`/api/app/events/${id}/report`)).body;
    expect(report.summary.by_hub['East Hub']).toBe(1);
    const csv = await sam.get(`/api/app/events/${id}/records.csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="gatekeeper-Celtic-v-Rangers.*\.csv"/);
    expect(csv.text).toMatch(/\n2,B,2,/);
    expect(csv.text).not.toMatch(/\n1,A,1,/); // logged before the event
    expect(csv.text).toContain(`'=HYPERLINK`); // no spreadsheet formulas
    // The summary outlives the records (30-day clean-up).
    await getPool().query('TRUNCATE tickets CASCADE');
    expect((await sam.get(`/api/app/events/${id}/report`)).body.summary.counts.logged).toBe(2);
    expect((await sam.get('/api/app/events/00000000-0000-4000-8000-000000000000/report')).status).toBe(404);
    const audit = (await getPool().query("SELECT action FROM audit_log WHERE action LIKE 'event_%' ORDER BY id")).rows.map((r) => r.action);
    expect(audit).toEqual(['event_started', 'event_ended']);
  });

  it('settings: policy, AI on/off and venue name, superadmin only, audited', async () => {
    const put = await json(gio.put('/api/app/settings')).send({ policy: 'Under 18s with alcohol: refuse.', ai_enabled: false, venue_name: 'The Hydro' });
    expect(put.status).toBe(200);
    expect((await gio.get('/api/app/settings')).body.settings).toMatchObject({ policy: 'Under 18s with alcohol: refuse.', ai_enabled: false, venue_name: 'The Hydro' });
    expect((await amy.get('/api/app/options')).body).toMatchObject({ ai: false, venue_name: 'The Hydro', policy: 'Under 18s with alcohol: refuse.' });
    expect((await json(amy.post('/api/app/describe')).send({ text: 'tall lad' })).status).toBe(503);
    expect((await json(gio.put('/api/app/settings')).send({ policy: 'x'.repeat(5000) })).status).toBe(400);
    const audit = (await getPool().query("SELECT detail FROM audit_log WHERE action = 'settings_changed'")).rows;
    expect(audit).toHaveLength(1);
  });

  it('seating map: the superadmin uploads the plan and places sections; seniors see it with counts', async () => {
    expect((await sam.get('/api/app/map')).body).toMatchObject({ has_image: false, blocks: {} });
    expect((await sam.put('/api/app/map/image').set('content-type', 'image/png').send(PNG)).status).toBe(403);
    expect((await gio.put('/api/app/map/image').set('content-type', 'image/png').send(PNG)).status).toBe(200);
    expect((await json(gio.put('/api/app/map/blocks/313')).send({ x: 0.25, y: 0.5 })).status).toBe(200);
    expect((await json(gio.put('/api/app/map/blocks/313')).send({ x: 2, y: 0.5 })).status).toBe(400);
    const m = (await sam.get('/api/app/map')).body;
    expect(m).toMatchObject({ has_image: true, blocks: { '313': { x: 0.25, y: 0.5 } } });
    const img = await sam.get('/api/app/map/image');
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(img.body, PNG)).toBe(0);
    expect((await gio.delete('/api/app/map/blocks/313')).status).toBe(200);
    expect((await sam.get('/api/app/map')).body.blocks).toEqual({});
  });
});
