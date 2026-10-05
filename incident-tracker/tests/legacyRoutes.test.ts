import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetConfigCache } from '../src/config/env';

/** On the phone the app is published through a tunnel, so the older routes without logins are not served. */
describe('older routes without logins (LEGACY_API)', () => {
  afterEach(() => {
    delete process.env.LEGACY_API;
    resetConfigCache();
  });

  it('are not served when switched off; the app and the admin pages still are', async () => {
    process.env.LEGACY_API = 'false';
    resetConfigCache();
    const app = createApp();
    expect((await request(app).post('/api/scan').send({})).status).toBe(404);
    expect((await request(app).get('/api/tickets/lookup?section=1&row=A&seat=1')).status).toBe(404);
    expect((await request(app).get('/api/tickets/ABC')).status).toBe(404);
    expect((await request(app).post('/api/whatsapp/incoming').send({})).status).toBe(404);
    expect((await request(app).get('/index.html')).status).toBe(404); // the old intake form
    const home = await request(app).get('/');
    expect(home.status).toBe(302);
    expect(home.headers.location).toBe('/app/');
    expect((await request(app).get('/app/')).status).toBe(200);
    expect((await request(app).get('/api/app/me')).status).not.toBe(404);
    expect([401, 503]).toContain((await request(app).get('/admin/api/records/')).status); // needs the admin key
  });

  it('are served by default (cloud deployments that still use them)', async () => {
    resetConfigCache();
    const app = createApp();
    expect((await request(app).post('/api/scan').send({})).status).not.toBe(404);
    expect((await request(app).get('/')).status).toBe(200);
  });
});
