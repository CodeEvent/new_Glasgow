import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { can, type AppUser } from '../src/services/permissions';
import { hashPin, resetLoginLimits, verifyPin } from '../src/services/accounts';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const area = (hub: string, id = 'a1'): AppUser => ({ id, name: 'Amy', role: 'area', hub });
const senior: AppUser = { id: 's1', name: 'Sam', role: 'senior', hub: null };
const superadmin: AppUser = { id: 'x1', name: 'Gio', role: 'superadmin', hub: null };

describe('permissions', () => {
  it('area supervisors log only in their own area but see everything', () => {
    const amy = area('West Hub');
    expect(can(amy, 'log', { hub: 'West Hub' })).toBe(true);
    expect(can(amy, 'log', { hub: 'East Hub' })).toBe(false);
    expect(can(amy, 'view')).toBe(true);
    expect(can(amy, 'edit', { ownerId: 'a1' })).toBe(true); // fix their own log
    expect(can(amy, 'edit', { ownerId: 'someone' })).toBe(false);
    for (const a of ['delete', 'dashboard', 'events', 'settings', 'users'] as const) expect(can(amy, a)).toBe(false);
  });

  it('seniors view, add, edit and delete everything, but no settings or accounts', () => {
    expect(can(senior, 'log', { hub: 'East Hub' })).toBe(true);
    expect(can(senior, 'edit', { ownerId: 'someone' })).toBe(true);
    for (const a of ['delete', 'dashboard', 'events'] as const) expect(can(senior, a)).toBe(true);
    expect(can(senior, 'settings')).toBe(false);
    expect(can(senior, 'users')).toBe(false);
  });

  it('the superadmin can do everything', () => {
    for (const a of ['log', 'view', 'edit', 'delete', 'dashboard', 'events', 'settings', 'users'] as const) expect(can(superadmin, a, { hub: 'South Hub', ownerId: 'z' })).toBe(true);
  });
});

describe('PINs', () => {
  it('are stored hashed and checked in constant time', async () => {
    const h = await hashPin('482913');
    expect(h).not.toContain('482913');
    expect(await verifyPin('482913', h)).toBe(true);
    expect(await verifyPin('482914', h)).toBe(false);
    expect(await hashPin('482913')).not.toBe(h); // salted
  });
});

describe.skipIf(!HAS_DB)('accounts API (PostgreSQL)', () => {
  const KEY = 'test-admin-key-123456';
  const app = createApp();
  const json = (r: request.Test) => r.set('content-type', 'application/json');

  beforeEach(async () => {
    tempOfflineLog();
    process.env.ADMIN_API_KEY = KEY;
    resetConfigCache();
    await resetDatabase();
    await getPool().query('DELETE FROM app_sessions; DELETE FROM app_users; DELETE FROM audit_log');
    resetLoginLimits();
  });
  afterAll(async () => {
    delete process.env.ADMIN_API_KEY;
    resetConfigCache();
    await closePool();
  });

  /** Creates the superadmin through first-time setup and returns a logged-in agent. */
  async function setupSuperadmin() {
    const agent = request.agent(app);
    const r = await json(agent.post('/api/app/setup')).send({ admin_key: KEY, name: 'Gio', pin: '482913' });
    expect(r.status).toBe(200);
    return agent;
  }

  it('first-time setup needs the admin key, and only works once', async () => {
    expect((await request(app).get('/api/app/me')).body).toMatchObject({ ok: false, needs_setup: true });
    expect((await json(request(app).post('/api/app/setup')).send({ admin_key: 'wrong', name: 'Eve', pin: '111111' })).status).toBe(401);
    const agent = await setupSuperadmin();
    const me = await agent.get('/api/app/me');
    expect(me.body.user).toMatchObject({ name: 'Gio', role: 'superadmin' });
    expect((await json(request(app).post('/api/app/setup')).send({ admin_key: KEY, name: 'Eve', pin: '111111' })).status).toBe(409);
  });

  it('the superadmin adds people; they log in with name + PIN; the cookie is HttpOnly', async () => {
    const gio = await setupSuperadmin();
    const add = await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '2468' });
    expect(add.status).toBe(200);
    expect(add.body.user).not.toHaveProperty('pin_hash');
    const login = await json(request(app).post('/api/app/login')).send({ name: ' amy ', pin: '2468' });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ name: 'Amy', role: 'area', hub: 'West Hub' });
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/gk_session=[^;]+;.*HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const list = await gio.get('/api/app/users');
    expect(list.body.users.map((u: { name: string }) => u.name).sort()).toEqual(['Amy', 'Gio']);
    expect(JSON.stringify(list.body)).not.toContain('scrypt');
  });

  it('checks the rules for people and PINs', async () => {
    const gio = await setupSuperadmin();
    const add = (body: object) => json(gio.post('/api/app/users')).send(body);
    expect((await add({ name: 'Amy', role: 'area', pin: '2468' })).body.error).toMatch(/area/i); // area needs a hub
    expect((await add({ name: 'Sam', role: 'senior', pin: '1234' })).body.error).toMatch(/6/); // admins need 6+ digits
    expect((await add({ name: 'Bob', role: 'area', hub: 'East Hub', pin: '12a4' })).body.error).toMatch(/digits/);
    expect((await add({ name: 'Bob', role: 'king', pin: '123456' })).status).toBe(400);
    await add({ name: 'Bob', role: 'area', hub: 'East Hub', pin: '1357' });
    expect((await add({ name: 'BOB', role: 'area', hub: 'East Hub', pin: '1357' })).body.error).toMatch(/already/i);
  });

  it('only the superadmin manages accounts', async () => {
    const gio = await setupSuperadmin();
    await json(gio.post('/api/app/users')).send({ name: 'Sam', role: 'senior', pin: '135791' });
    const sam = request.agent(app);
    await json(sam.post('/api/app/login')).send({ name: 'Sam', pin: '135791' });
    expect((await sam.get('/api/app/users')).status).toBe(403);
    expect((await json(sam.post('/api/app/users')).send({ name: 'X', role: 'superadmin', pin: '123456' })).status).toBe(403);
    expect((await request(app).get('/api/app/users')).status).toBe(401);
  });

  it('wrong PINs: same answer for unknown names, and a lockout after 5 tries', async () => {
    const gio = await setupSuperadmin();
    await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '2468' });
    const tryLogin = (name: string, pin: string) => json(request(app).post('/api/app/login')).send({ name, pin });
    const unknown = await tryLogin('Nobody', '0000');
    const wrong = await tryLogin('Amy', '0000');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error).toBe(wrong.body.error);
    for (let i = 0; i < 4; i++) await tryLogin('Amy', '0000');
    const locked = await tryLogin('Amy', '2468'); // right PIN, but locked
    expect(locked.status).toBe(429);
    // unknown names lock the same way (no hint about who exists)
    for (let i = 0; i < 4; i++) await tryLogin('Nobody', '0000');
    expect((await tryLogin('Nobody', '0000')).status).toBe(429);
  });

  it('logout ends the session; a deactivated person is logged out at once', async () => {
    const gio = await setupSuperadmin();
    const add = await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '2468' });
    const amy = request.agent(app);
    await json(amy.post('/api/app/login')).send({ name: 'Amy', pin: '2468' });
    expect((await amy.get('/api/app/me')).body.user.name).toBe('Amy');
    await json(gio.patch(`/api/app/users/${add.body.user.id}`)).send({ active: false });
    expect((await amy.get('/api/app/me')).status).toBe(401);
    await json(gio.post('/api/app/logout')).send({});
    expect((await gio.get('/api/app/me')).status).toBe(401);
  });

  it('the last superadmin can’t be removed or demoted', async () => {
    const gio = await setupSuperadmin();
    const me = (await gio.get('/api/app/me')).body.user;
    expect((await json(gio.patch(`/api/app/users/${me.id}`)).send({ role: 'senior' })).body.error).toMatch(/last superadmin/i);
    expect((await json(gio.patch(`/api/app/users/${me.id}`)).send({ active: false })).body.error).toMatch(/last superadmin/i);
    expect((await gio.delete(`/api/app/users/${me.id}`)).body.error).toMatch(/last superadmin/i);
  });

  it('changes are written to the audit log', async () => {
    const gio = await setupSuperadmin();
    await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '2468' });
    const { rows } = await getPool().query('SELECT user_name, action, detail FROM audit_log ORDER BY id');
    expect(rows.map((r) => r.action)).toEqual(['setup', 'user_added']);
    expect(rows[1]).toMatchObject({ user_name: 'Gio' });
    expect(JSON.stringify(rows)).not.toContain('2468');
  });

  it('rejects form posts from other sites (needs JSON)', async () => {
    const r = await request(app).post('/api/app/login').type('form').send('name=Amy&pin=2468');
    expect(r.status).toBe(415);
  });
});
