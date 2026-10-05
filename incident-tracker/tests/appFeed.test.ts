import type { AddressInfo } from 'net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { resetLoginLimits } from '../src/services/accounts';
import { appEvents, checkReadmits, type AppEvent } from '../src/services/appFeed';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

describe.skipIf(!HAS_DB)('live feed, alerts and editing (PostgreSQL)', () => {
  const KEY = 'test-admin-key-123456';
  const app = createApp();
  const json = (r: request.Test) => r.set('content-type', 'application/json');
  type Agent = ReturnType<typeof request.agent>;
  let gio: Agent;
  let amy: Agent; // area, West
  let bob: Agent; // area, East
  let sam: Agent; // senior
  let n = 0;
  const cid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const log = (agent: Agent, body: object) =>
    json(agent.post('/api/app/logs')).send({ client_id: cid(), decision: 'refused', seats: [{ section: '313', row: 'YY', seat: '56' }], reasons: ['Intoxicated'], ...body });
  const ticketId = async (seat: string) => (await getPool().query('SELECT ticket_id FROM tickets WHERE seat_number = $1', [seat])).rows[0].ticket_id as string;
  const ticket = async (seat: string) => (await getPool().query('SELECT * FROM tickets WHERE seat_number = $1', [seat])).rows[0];
  const events: AppEvent[] = [];
  const listener = (e: AppEvent) => events.push(e);

  beforeAll(async () => {
    tempOfflineLog();
    process.env.ADMIN_API_KEY = KEY;
    resetConfigCache();
    await resetDatabase();
    appEvents.on('event', listener);
  });
  beforeEach(async () => {
    await resetDatabase();
    await getPool().query('DELETE FROM app_sessions; DELETE FROM app_devices; DELETE FROM app_users; DELETE FROM audit_log; DELETE FROM app_log_requests');
    resetLoginLimits();
    events.length = 0;
    gio = request.agent(app);
    await json(gio.post('/api/app/setup')).send({ admin_key: KEY, name: 'Gio', pin: '482913' });
    const people: Array<[string, string, string | null, string]> = [['Amy', 'area', 'West Hub', '246813'], ['Bob', 'area', 'East Hub', '135724'], ['Sam', 'senior', null, '135791']];
    for (const [name, role, hub, pin] of people) await json(gio.post('/api/app/users')).send({ name, role, hub, pin });
    const loginAs = async (name: string, pin: string) => {
      const a = request.agent(app);
      await json(a.post('/api/app/login')).send({ name, pin });
      return a;
    };
    amy = await loginAs('Amy', '246813');
    bob = await loginAs('Bob', '135724');
    sam = await loginAs('Sam', '135791');
  });
  afterAll(async () => {
    appEvents.off('event', listener);
    delete process.env.ADMIN_API_KEY;
    resetConfigCache();
    await closePool();
  });

  it('the feed shows every area’s logs, newest first, with who may change what', async () => {
    await log(amy, { seats: [{ section: '1', row: 'A', seat: '1' }], gender: 'Male' });
    await log(sam, { hub: 'South Hub', decision: 'cool_off', seats: [{ section: '1', row: 'A', seat: '2' }] });
    const feedFor = async (a: Agent) => (await a.get('/api/app/feed')).body.items;
    const forBob = await feedFor(bob);
    expect(forBob.map((i: { seat: string }) => i.seat)).toEqual(['1 A 2', '1 A 1']);
    expect(forBob[1]).toMatchObject({ status: 'refused', hub: 'West Hub', by: 'Amy', description: 'Male', reasoning: 'Intoxicated', reentry: false, can_edit: false, can_delete: false });
    expect(forBob[0]).toMatchObject({ status: 'sent_away', hub: 'South Hub', by: 'Sam' });
    expect(forBob[0].back_at).toBeTruthy();
    const forAmy = await feedFor(amy);
    expect(forAmy.find((i: { seat: string }) => i.seat === '1 A 1')).toMatchObject({ can_edit: true, can_delete: false });
    expect((await feedFor(sam)).every((i: { can_edit: boolean; can_delete: boolean }) => i.can_edit && i.can_delete)).toBe(true);
    expect((await request(app).get('/api/app/feed')).status).toBe(401);
  });

  it('a re-entry shows in the feed and raises an alert for everyone', async () => {
    await log(amy, {});
    await log(bob, { reasons: ['Abusive'] });
    const items = (await sam.get('/api/app/feed')).body.items;
    expect(items[0]).toMatchObject({ seat: '313 YY 56', hub: 'East Hub', by: 'Bob', reentry: true });
    const alerts = events.filter((e) => e.kind === 'log');
    expect(alerts.map((e) => e.kind === 'log' && e.reentry)).toEqual([false, true]);
    expect(alerts[1]).toMatchObject({ seat: '313 YY 56', hub: 'East Hub', by: 'Bob', first_hub: 'West Hub' });
  });

  it('area supervisors fix their own logs only, and can’t clear anyone', async () => {
    await log(amy, {});
    await log(sam, { hub: 'East Hub', seats: [{ section: '9', row: 'B', seat: '9' }] });
    const mine = await ticketId('56');
    const theirs = await ticketId('9');
    const edit = (a: Agent, id: string, body: object) => json(a.patch(`/api/app/records/${encodeURIComponent(id)}`)).send(body);
    expect((await edit(amy, mine, { description: 'Male · red coat' })).status).toBe(200);
    expect((await ticket('56')).description).toBe('Male · red coat');
    expect((await edit(amy, theirs, { description: 'x' })).status).toBe(403);
    expect((await edit(bob, mine, { description: 'x' })).status).toBe(403);
    expect((await edit(amy, mine, { status: 'admitted' })).status).toBe(403);
    expect((await edit(amy, 'SEAT-NOPE', { description: 'x' })).status).toBe(404);
    expect((await amy.delete(`/api/app/records/${encodeURIComponent(mine)}`)).status).toBe(403);
  });

  it('an area supervisor can’t undo a later decision by someone else, or make a record less serious', async () => {
    await log(amy, { decision: 'cool_off' });
    const id = await ticketId('56');
    const edit = (body: object) => json(amy.patch(`/api/app/records/${encodeURIComponent(id)}`)).send(body);
    expect((await edit({ status: 'refused' })).status).toBe(200); // more serious: fine
    expect((await edit({ status: 'ejected' })).status).toBe(200);
    expect((await edit({ status: 'refused' })).status).toBe(403); // less serious
    expect((await edit({ status: 'sent_away' })).status).toBe(403);
    expect((await ticket('56')).reasoning).toMatch(/^Ejected/);
    // Editing just the reason keeps it ejected (the mark can't be dropped that way)
    expect((await edit({ reasoning: 'Abusive' })).status).toBe(200);
    expect((await ticket('56')).reasoning).toBe('Ejected: Abusive');
    // A senior logs over it: it's no longer only Amy's
    await log(sam, { hub: 'East Hub', reasons: ['Abusive'] });
    expect((await edit({ description: 'x' })).status).toBe(403);
    const mineInFeed = (await amy.get('/api/app/feed')).body.items.filter((i: { seat: string }) => i.seat === '313 YY 56');
    expect(mineInFeed.every((i: { can_edit: boolean }) => !i.can_edit)).toBe(true);
  });

  it('seniors change the status, clear and delete; it’s all in the audit log', async () => {
    await log(amy, { reasons: ['Abusive'] });
    const id = await ticketId('56');
    const edit = (body: object) => json(sam.patch(`/api/app/records/${encodeURIComponent(id)}`)).send(body);
    await edit({ status: 'ejected' });
    expect(await ticket('56')).toMatchObject({ current_status: 'completely_refused', reasoning: 'Ejected: Abusive' });
    await edit({ status: 'refused' });
    expect((await ticket('56')).reasoning).toBe('Abusive');
    await edit({ status: 'sent_away' });
    expect((await ticket('56')).current_status).toBe('cooling_off');
    await edit({ status: 'admitted', reasoning: 'Abusive, calmed down', party: 2 });
    expect(await ticket('56')).toMatchObject({ current_status: 'admitted', reasoning: 'Abusive, calmed down', party_size: 2 });
    expect((await sam.delete(`/api/app/records/${encodeURIComponent(id)}`)).status).toBe(200);
    expect(await ticket('56')).toBeUndefined();
    const { rows } = await getPool().query("SELECT user_name, action, detail FROM audit_log WHERE action LIKE 'record_%' ORDER BY id");
    expect(rows.map((r) => r.action)).toEqual(['record_edited', 'record_edited', 'record_edited', 'record_edited', 'record_deleted']);
    expect(rows[0]).toMatchObject({ user_name: 'Sam' });
    expect(rows[0].detail).toContain('313 YY 56');
    expect(events.filter((e) => e.kind === 'change')).toHaveLength(5);
  });

  it('rejects edits that don’t make sense', async () => {
    await log(sam, { hub: 'East Hub' });
    const id = await ticketId('56');
    const edit = (body: object) => json(sam.patch(`/api/app/records/${encodeURIComponent(id)}`)).send(body);
    expect((await edit({ status: 'maybe' })).status).toBe(400);
    expect((await edit({ party: 0 })).status).toBe(400);
    expect((await edit({})).status).toBe(400);
  });

  it('says when someone sent away may come back', async () => {
    await log(amy, { decision: 'cool_off' });
    await getPool().query("UPDATE tickets SET cool_down_until = NOW() - INTERVAL '1 minute' WHERE seat_number = '56'");
    await checkReadmits(new Date(Date.now() - 5 * 60_000), new Date());
    const r = events.find((e) => e.kind === 'readmit');
    expect(r).toMatchObject({ kind: 'readmit', seat: '313 YY 56', hub: 'West Hub' });
  });

  it('streams alerts to logged-in phones (server-sent events)', async () => {
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      expect((await fetch(`http://127.0.0.1:${port}/api/app/stream`)).status).toBe(401);
      const cookie = (await json(request(app).post('/api/app/login')).send({ name: 'Amy', pin: '246813' })).headers['set-cookie'] as unknown as string[];
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/app/stream`, { headers: { cookie: cookie.map((c) => c.split(';')[0]).join('; ') }, signal: ac.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const read = async () => new TextDecoder().decode((await reader.read()).value);
      expect(await read()).toContain(':ok');
      await log(bob, { seats: [{ section: '7', row: 'C', seat: '3' }] });
      let got = '';
      for (let i = 0; i < 5 && !got.includes('7 C 3'); i++) got += await read();
      expect(got).toContain('event: log');
      expect(got).toContain('7 C 3');
      ac.abort();
    } finally {
      server.close();
    }
  });
});
