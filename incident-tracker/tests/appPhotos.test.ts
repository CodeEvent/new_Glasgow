import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { resetLoginLimits } from '../src/services/accounts';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

describe.skipIf(!HAS_DB)('photos of the person or the ticket (PostgreSQL)', () => {
  const KEY = 'test-admin-key-123456';
  const app = createApp();
  const json = (r: request.Test) => r.set('content-type', 'application/json');
  type Agent = ReturnType<typeof request.agent>;
  let amy: Agent; // area, West
  let bob: Agent; // area, East
  let sam: Agent; // senior
  let n = 0;
  const cid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  let ticketId = '';
  const photo = (a: Agent, kind = 'person', body: Buffer = JPEG, type = 'image/jpeg') =>
    a.post(`/api/app/records/${encodeURIComponent(ticketId)}/photos?kind=${kind}`).set('content-type', type).send(body);

  beforeAll(async () => {
    tempOfflineLog();
    process.env.ADMIN_API_KEY = KEY;
    resetConfigCache();
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
    await getPool().query('DELETE FROM app_sessions; DELETE FROM app_devices; DELETE FROM app_users; DELETE FROM audit_log; DELETE FROM app_log_requests');
    resetLoginLimits();
    const gio = request.agent(app);
    await json(gio.post('/api/app/setup')).send({ admin_key: KEY, name: 'Gio', pin: '482913' });
    for (const [name, role, hub, pin] of [['Amy', 'area', 'West Hub', '246813'], ['Bob', 'area', 'East Hub', '135724'], ['Sam', 'senior', null, '135791']]) {
      await json(gio.post('/api/app/users')).send({ name, role, hub, pin });
    }
    const loginAs = async (name: string, pin: string) => {
      const a = request.agent(app);
      await json(a.post('/api/app/login')).send({ name, pin });
      return a;
    };
    amy = await loginAs('Amy', '246813');
    bob = await loginAs('Bob', '135724');
    sam = await loginAs('Sam', '135791');
    const r = await json(amy.post('/api/app/logs')).send({ client_id: cid(), decision: 'refused', seats: [{ section: '313', row: 'YY', seat: '56' }], reasons: ['Intoxicated'] });
    ticketId = r.body.results[0].ticket_id;
  });
  afterAll(async () => {
    delete process.env.ADMIN_API_KEY;
    resetConfigCache();
    await closePool();
  });

  it('anyone logged in adds a photo of the person or the ticket; everyone can see it', async () => {
    const r = await photo(amy, 'person');
    expect(r.status).toBe(200);
    expect(r.body.photo).toMatchObject({ kind: 'person', by: 'Amy' });
    expect((await photo(bob, 'ticket')).status).toBe(200); // another area: it only adds information
    const list = (await sam.get(`/api/app/records/${encodeURIComponent(ticketId)}/photos`)).body.photos;
    expect(list.map((p: { kind: string; by: string }) => `${p.kind}:${p.by}`)).toEqual(['ticket:Bob', 'person:Amy']);
    const img = await bob.get(`/api/app/photos/${list[1].id}`);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toContain('private');
    expect(Buffer.compare(img.body, JPEG)).toBe(0);
    // Shown as a count in the feed and in seat checks
    expect((await amy.get('/api/app/feed')).body.items[0].photos).toBe(2);
    expect((await amy.get('/api/app/seat?section=313&row=YY&seat=56')).body.record.photos).toBe(2);
    const audit = (await getPool().query("SELECT user_name, detail FROM audit_log WHERE action = 'photo_added' ORDER BY id")).rows;
    expect(audit.map((a) => a.user_name)).toEqual(['Amy', 'Bob']);
  });

  it('needs a login, a real image type, a sensible size, and a record that exists', async () => {
    expect((await request(app).post(`/api/app/records/${encodeURIComponent(ticketId)}/photos`).set('content-type', 'image/jpeg').send(JPEG)).status).toBe(401);
    expect((await request(app).get(`/api/app/records/${encodeURIComponent(ticketId)}/photos`)).status).toBe(401);
    expect((await photo(amy, 'person', Buffer.from('<svg/>'), 'image/svg+xml')).status).toBe(415);
    expect((await photo(amy, 'selfie')).status).toBe(400);
    expect((await photo(amy, 'person', Buffer.alloc(6 * 1024 * 1024, 1))).status).toBe(413);
    const missing = await amy.post('/api/app/records/SEAT-NOPE/photos?kind=person').set('content-type', 'image/jpeg').send(JPEG);
    expect(missing.status).toBe(404);
    expect((await amy.get('/api/app/photos/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('a stored file that isn’t a real image is never served as a page (no scripts)', async () => {
    const { rows } = await getPool().query(
      "INSERT INTO ticket_photos (ticket_id, mime_type, data) VALUES ($1, 'text/html', $2) RETURNING id",
      [ticketId, Buffer.from('<script>fetch("/api/app/users")</script>')],
    );
    const r = await amy.get(`/api/app/photos/${rows[0].id}`);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['content-security-policy']).toContain('sandbox');
    const ok = await amy.get(`/api/app/photos/${(await photo(amy)).body.photo.id}`);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['content-security-policy']).toContain('sandbox');
  });

  it('the 6-photo limit holds even when photos arrive at once', async () => {
    const all = await Promise.all(Array.from({ length: 10 }, () => photo(amy)));
    expect(all.filter((r) => r.status === 200)).toHaveLength(6);
    expect((await getPool().query('SELECT count(*)::int AS n FROM ticket_photos')).rows[0].n).toBe(6);
  });

  it('at most 6 photos per record', async () => {
    for (let i = 0; i < 6; i++) expect((await photo(amy)).status).toBe(200);
    expect((await photo(amy)).status).toBe(409);
  });

  it('only seniors and the superadmin delete photos; they go with the record', async () => {
    const id = (await photo(amy)).body.photo.id;
    expect((await amy.delete(`/api/app/photos/${id}`)).status).toBe(403);
    expect((await sam.delete(`/api/app/photos/${id}`)).status).toBe(200);
    expect((await sam.get(`/api/app/records/${encodeURIComponent(ticketId)}/photos`)).body.photos).toHaveLength(0);
    await photo(amy);
    await sam.delete(`/api/app/records/${encodeURIComponent(ticketId)}`);
    expect((await getPool().query('SELECT count(*)::int AS n FROM ticket_photos')).rows[0].n).toBe(0);
  });
});
