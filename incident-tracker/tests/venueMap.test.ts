import { Jimp } from 'jimp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { StewardBot } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const KEY = 'map-test-key';
const app = createApp();
const api = (method: 'get' | 'put' | 'delete', path: string) => request(app)[method]('/admin/api/map' + path).set('x-admin-key', KEY);

beforeAll(() => {
  process.env.ADMIN_API_KEY = KEY;
  resetConfigCache();
});

describe('seating map API: auth', () => {
  it('needs the admin key', async () => {
    expect((await request(app).get('/admin/api/map/')).status).toBe(401);
    expect((await request(app).put('/admin/api/map/image').set('content-type', 'image/png').send(Buffer.from('x'))).status).toBe(401);
  });
});

describe.skipIf(!HAS_DB)('seating map API (PostgreSQL)', () => {
  let png: Buffer;
  const say = (text: string) => new StewardBot().handle({ chatId: 'g@g.us', senderId: 'd', senderName: 'Dave', text, at: new Date() });
  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    await getPool().query('DELETE FROM venue_map');
    await getPool().query("DELETE FROM app_settings WHERE key = 'map_blocks'");
    png = await new Jimp({ width: 30, height: 20, color: 0x3366ccff }).getBuffer('image/png');
  });
  afterAll(async () => {
    await closePool();
  });

  it('starts empty', async () => {
    const res = await api('get', '/');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, hasImage: false, blocks: {}, sections: {} });
  });

  it('stores the plan image on this server and serves it back', async () => {
    const up = await api('put', '/image').set('content-type', 'image/png').send(png);
    expect(up.status).toBe(200);
    expect((await api('get', '/')).body.hasImage).toBe(true);
    const img = await api('get', '/image').buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(img.body as Buffer, png)).toBe(0);
  });

  it('refuses files that are not images, and images over 10 MB', async () => {
    expect((await api('put', '/image').set('content-type', 'text/html').send('<script>')).status).toBe(415);
    expect((await api('put', '/image').set('content-type', 'image/svg+xml').send('<svg/>')).status).toBe(415); // SVG can carry scripts
    const big = Buffer.alloc(10 * 1024 * 1024 + 10);
    expect((await api('put', '/image').set('content-type', 'image/png').send(big)).status).toBe(413);
  });

  it('places, moves and removes blocks', async () => {
    expect((await api('put', '/blocks').send({ block: '313', x: 0.25, y: 0.5 })).status).toBe(200);
    await api('put', '/blocks').send({ block: '101', x: 0.1, y: 0.9 });
    await api('put', '/blocks').send({ block: '313', x: 0.3, y: 0.55 }); // moved
    expect((await api('get', '/')).body.blocks).toEqual({ '313': { x: 0.3, y: 0.55 }, '101': { x: 0.1, y: 0.9 } });
    expect((await api('delete', '/blocks/101')).status).toBe(200);
    expect(Object.keys((await api('get', '/')).body.blocks)).toEqual(['313']);
  });

  it('rejects bad positions and block names', async () => {
    expect((await api('put', '/blocks').send({ block: '313', x: 1.5, y: 0.2 })).status).toBe(400);
    expect((await api('put', '/blocks').send({ block: '<b>', x: 0.1, y: 0.2 })).status).toBe(400);
    expect((await api('put', '/blocks').send({ block: '313' })).status).toBe(400);
  });

  it('counts tonight’s records per block', async () => {
    await say('REFUSED 313 YY 56 West 1 -');
    await say('EJECTED 313 YY 57 West 2 -');
    await say('30 313 ZZ 10 East 1 -');
    await say('REFUSED 101 A 1 South 1 -');
    const { sections } = (await api('get', '/')).body;
    expect(sections['313']).toMatchObject({ refused: 1, ejected: 1, away: 1, total: 3 });
    expect(sections['313'].seats).toEqual(expect.arrayContaining(['YY 56', 'YY 57', 'ZZ 10']));
    expect(sections['101']).toMatchObject({ refused: 1, total: 1 });
  });

  it('lets the records list filter by section (for tapping a block)', async () => {
    await say('REFUSED 313 YY 56 West 1 -');
    await say('REFUSED 101 A 1 South 1 -');
    const res = await request(app).get('/admin/api/records/?section=313').set('x-admin-key', KEY);
    expect(res.body.records.map((r: { section: string }) => r.section)).toEqual(['313']);
  });
});
