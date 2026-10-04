import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { can, type AppUser } from '../src/services/permissions';
import { deviceKey, hashPin, login, resetLoginLimits, setLoginTrackingCap, verifyPin } from '../src/services/accounts';
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
    await getPool().query('DELETE FROM app_sessions; DELETE FROM app_devices; DELETE FROM app_users; DELETE FROM audit_log');
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
    const add = await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' });
    expect(add.status).toBe(200);
    expect(add.body.user).not.toHaveProperty('pin_hash');
    const login = await json(request(app).post('/api/app/login')).send({ name: ' amy ', pin: '246813' });
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
    expect((await add({ name: 'Amy', role: 'area', pin: '246813' })).body.error).toMatch(/area/i); // area needs a hub
    expect((await add({ name: 'Sam', role: 'senior', pin: '1234' })).body.error).toMatch(/6/); // 6+ digits
    expect((await add({ name: 'Ann', role: 'area', hub: 'East Hub', pin: '1234' })).body.error).toMatch(/6/);
    expect((await add({ name: 'Bob', role: 'area', hub: 'East Hub', pin: '12a456' })).body.error).toMatch(/digits/);
    expect((await add({ name: 'Bob', role: 'king', pin: '123456' })).status).toBe(400);
    await add({ name: 'Bob', role: 'area', hub: 'East Hub', pin: '135724' });
    expect((await add({ name: 'BOB', role: 'area', hub: 'East Hub', pin: '135724' })).body.error).toMatch(/already/i);
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
    await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' });
    const tryLogin = (name: string, pin: string) => json(request(app).post('/api/app/login')).send({ name, pin });
    const unknown = await tryLogin('Nobody', '0000');
    const wrong = await tryLogin('Amy', '0000');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error).toBe(wrong.body.error);
    for (let i = 0; i < 4; i++) await tryLogin('Amy', '0000');
    const locked = await tryLogin('Amy', '246813'); // right PIN, but locked
    expect(locked.status).toBe(429);
    // unknown names lock the same way (no hint about who exists)
    for (let i = 0; i < 4; i++) await tryLogin('Nobody', '0000');
    expect((await tryLogin('Nobody', '0000')).status).toBe(429);
  });

  it('wrong PINs sent at the same moment still lock after 5', async () => {
    const gio = await setupSuperadmin();
    await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' });
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => json(request(app).post('/api/app/login')).send({ name: 'Amy', pin: String(1000 + i) })));
    expect(burst.filter((r) => r.status === 401)).toHaveLength(5);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(7);
    expect((await json(request(app).post('/api/app/login')).send({ name: 'Amy', pin: '246813' })).status).toBe(429);
  });

  it('flooding with made-up names doesn’t unlock a locked name', async () => {
    const gio = await setupSuperadmin();
    await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' });
    setLoginTrackingCap(5);
    try {
      for (let i = 0; i < 5; i++) await json(request(app).post('/api/app/login')).send({ name: 'Amy', pin: '0000' });
      for (let i = 0; i < 8; i++) await json(request(app).post('/api/app/login').set('x-forwarded-for', `10.0.0.${i}`)).send({ name: `Fake${i}`, pin: '0000' });
      expect((await json(request(app).post('/api/app/login')).send({ name: 'Amy', pin: '246813' })).status).toBe(429);
    } finally {
      setLoginTrackingCap(10_000);
    }
  });

  it('a stranger can’t lock a supervisor out: the lock is for that name on that device', async () => {
    const gio = await setupSuperadmin();
    await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' });
    const from = (ip: string, pin: string) => json(request(app).post('/api/app/login').set('x-forwarded-for', ip)).send({ name: 'Amy', pin });
    for (let i = 0; i < 5; i++) expect((await from('10.0.0.66', '000000')).status).toBe(401);
    expect((await from('10.0.0.66', '246813')).status).toBe(429); // the stranger's device is locked
    expect((await from('10.0.0.7', '246813')).status).toBe(200); // Amy's phone is not
  });

  it('20 wrong PINs from any devices lock the name; the superadmin can unlock it', async () => {
    const gio = await setupSuperadmin();
    const amyId = (await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' })).body.user.id;
    const from = (ip: string, pin: string) => json(request(app).post('/api/app/login').set('x-forwarded-for', ip)).send({ name: 'Amy', pin });
    for (let d = 0; d < 4; d++) for (let i = 0; i < 5; i++) await from(`10.1.0.${d}`, '000000');
    expect((await from('10.1.0.99', '246813')).status).toBe(429);
    const { rows } = await getPool().query("SELECT action, detail FROM audit_log WHERE action = 'login_locked'");
    expect(rows.map((r) => r.detail)).toContain('amy');
    await json(gio.patch(`/api/app/users/${amyId}`)).send({ unlock: true });
    expect((await from('10.1.0.99', '246813')).status).toBe(200);
  });

  it('a connection that guesses at many names is stopped, but staff phones on it still log in', async () => {
    const gio = await setupSuperadmin();
    // Gio's phone has logged in before on the shared Wi-Fi (it carries the trusted-device cookie).
    const gioPhone = request.agent(app);
    await json(gioPhone.post('/api/app/login').set('x-forwarded-for', '10.9.9.9')).send({ name: 'Gio', pin: '482913' });
    for (const name of ['Amy', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay']) await json(gio.post('/api/app/users')).send({ name, role: 'area', hub: 'West Hub', pin: '246813' });
    const from = (name: string, pin: string) => json(request(app).post('/api/app/login').set('x-forwarded-for', '10.9.9.9')).send({ name, pin });
    for (const name of ['Amy', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay']) for (let i = 0; i < 5; i++) await from(name, '000000');
    expect((await from('Gio', '482913')).status).toBe(429); // a stranger on that connection: stopped
    expect((await json(gioPhone.post('/api/app/login').set('x-forwarded-for', '10.9.9.9')).send({ name: 'Gio', pin: '482913' })).status).toBe(200);
  });

  it('a trusted phone still logs in while its name is locked everywhere', async () => {
    const gio = await setupSuperadmin();
    await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' });
    const amyPhone = request.agent(app);
    expect((await json(amyPhone.post('/api/app/login')).send({ name: 'Amy', pin: '246813' })).headers['set-cookie']?.join(';')).toMatch(/gk_device=[^;]+;.*HttpOnly/i);
    for (let d = 0; d < 4; d++) for (let i = 0; i < 5; i++) await json(request(app).post('/api/app/login').set('x-forwarded-for', `10.2.0.${d}`)).send({ name: 'Amy', pin: '000000' });
    expect((await json(request(app).post('/api/app/login').set('x-forwarded-for', '10.2.0.50')).send({ name: 'Amy', pin: '246813' })).status).toBe(429);
    expect((await json(amyPhone.post('/api/app/login')).send({ name: 'Amy', pin: '246813' })).status).toBe(200);
  });

  it('each new lock on a name lasts twice as long', async () => {
    await setupSuperadmin();
    const t0 = Date.now();
    const guess = async (at: number, d: number) => {
      for (let i = 0; i < 5; i++) await login('Gio', '000000', at, `10.3.${d}.${i}`).catch(() => undefined);
    };
    for (let d = 0; d < 4; d++) await guess(t0, d); // 20 wrong: locked 15 min
    await expect(login('Gio', '482913', t0 + 10 * 60_000, '10.3.9.1')).rejects.toMatchObject({ status: 429 });
    await expect(login('Gio', '482913', t0 + 16 * 60_000, '10.3.9.1')).resolves.toBeTruthy(); // over; a right PIN doesn't reset the level
    const t1 = t0 + 17 * 60_000;
    for (let d = 0; d < 4; d++) await guess(t1, d + 10); // 2nd lock: 30 min
    await expect(login('Gio', '482913', t1 + 20 * 60_000, '10.3.9.2')).rejects.toMatchObject({ status: 429 });
    await expect(login('Gio', '482913', t1 + 31 * 60_000, '10.3.9.3')).resolves.toBeTruthy();
  });

  it('made-up names can’t push out a guesser’s counts on a real name', async () => {
    await setupSuperadmin();
    setLoginTrackingCap(5);
    try {
      const from = (name: string, ip: string) => json(request(app).post('/api/app/login').set('x-forwarded-for', ip)).send({ name, pin: '000000' });
      for (let i = 0; i < 4; i++) await from('Gio', '10.4.0.1');
      for (let i = 0; i < 20; i++) await from(`Fake${i}`, `10.4.1.${i}`);
      expect((await from('Gio', '10.4.0.1')).status).toBe(401); // 5th try
      expect((await from('Gio', '10.4.0.1')).status).toBe(429); // still counted: locked
    } finally {
      setLoginTrackingCap(10_000);
    }
  });

  it('old short PINs must be reset; promoting someone needs a new PIN', async () => {
    const gio = await setupSuperadmin();
    const amy = (await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' })).body.user;
    await getPool().query('UPDATE app_users SET pin_hash = $2 WHERE id = $1', [amy.id, await hashPin('2468')]);
    const r = await json(request(app).post('/api/app/login')).send({ name: 'Amy', pin: '2468' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/new 6/i);
    expect((await json(gio.patch(`/api/app/users/${amy.id}`)).send({ role: 'senior' })).body.error).toMatch(/new .*PIN/i);
  });

  it('counts a device’s tries even when they arrive at once', async () => {
    await setupSuperadmin();
    await Promise.all(Array.from({ length: 40 }, (_, i) => json(request(app).post('/api/app/login').set('x-forwarded-for', '10.8.8.8')).send({ name: `Fake${i}`, pin: '000000' })));
    const { _deviceFailures } = await import('../src/services/accounts');
    expect(_deviceFailures('10.8.8.8')).toBeGreaterThanOrEqual(30);
  });

  it('IPv6 phones are grouped by network, so changing address doesn’t reset the count', async () => {
    expect(deviceKey('2001:db8:1:2::a')).toBe(deviceKey('2001:db8:1:2:ffff::b'));
    expect(deviceKey('2001:db8:1:3::a')).not.toBe(deviceKey('2001:db8:1:2::a'));
    expect(deviceKey('::ffff:10.0.0.1')).toBe('10.0.0.1');
    await setupSuperadmin();
    const from = (ip: string) => json(request(app).post('/api/app/login').set('x-forwarded-for', ip)).send({ name: 'Gio', pin: '000000' });
    for (let i = 0; i < 5; i++) await from(`2001:db8:1:2::${i + 1}`);
    expect((await from('2001:db8:1:2::99')).status).toBe(429);
    expect((await from('2001:db8:1:3::1')).status).toBe(401);
  });

  it('logout ends the session; a deactivated person is logged out at once', async () => {
    const gio = await setupSuperadmin();
    const add = await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' });
    const amy = request.agent(app);
    await json(amy.post('/api/app/login')).send({ name: 'Amy', pin: '246813' });
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
    await json(gio.post('/api/app/users')).send({ name: 'Amy', role: 'area', hub: 'West Hub', pin: '246813' });
    const { rows } = await getPool().query('SELECT user_name, action, detail FROM audit_log ORDER BY id');
    expect(rows.map((r) => r.action)).toEqual(['setup', 'user_added']);
    expect(rows[1]).toMatchObject({ user_name: 'Gio' });
    expect(JSON.stringify(rows)).not.toContain('246813');
  });

  it('rejects form posts from other sites (needs JSON)', async () => {
    const r = await request(app).post('/api/app/login').type('form').send('name=Amy&pin=2468');
    expect(r.status).toBe(415);
  });
});
