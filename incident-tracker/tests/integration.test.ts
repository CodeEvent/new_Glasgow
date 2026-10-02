import fs from 'fs';
import crypto from 'crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { handleInboundMessage } from '../src/routes/whatsappWebhook';
import { resyncOfflineIncidents } from '../src/services/offlineSync';
import { mockOutbox } from '../src/services/whatsapp';
import { HAS_DB, baseScan, flushAsync, resetDatabase, tempOfflineLog } from './helpers';

const app = createApp();
const scan = (body: object) => request(app).post('/api/scan').send(body);

describe('GET /api/whatsapp/incoming (Meta verification)', () => {
  it('echoes hub.challenge as plain text when the token matches', async () => {
    const res = await request(app)
      .get('/api/whatsapp/incoming')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1158201444' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toBe('1158201444');
  });

  it('rejects a wrong token and missing params', async () => {
    const bad = await request(app)
      .get('/api/whatsapp/incoming')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
    const missing = await request(app).get('/api/whatsapp/incoming').query({ 'hub.mode': 'subscribe' });
    expect(missing.status).toBe(400);
  });
});

describe('POST /api/scan validation', () => {
  it('rejects bad payloads with field-level errors', async () => {
    const res = await scan({ ticket_id: '', hub_location: 'North Hub', steward_name: 'x', action_logged: 'party' });
    expect(res.status).toBe(400);
    const fields = res.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['ticket_id', 'hub_location', 'action_logged']));
  });
});

describe.skipIf(!HAS_DB)('scan state machine (PostgreSQL)', () => {
  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('Scenario A: new cool-off incident computes a 30 minute window and broadcasts', async () => {
    const res = await scan(baseScan);
    expect(res.status).toBe(201);
    expect(res.body.scenario).toBe('NEW_INCIDENT');
    expect(res.body.ticket.current_status).toBe('cooling_off');
    expect(res.body.event.action_logged).toBe('initial_cool_off');
    expect(res.body.ticket.reasoning).toBe('Slurred speech, Stumbling');

    const windowMs = new Date(res.body.ticket.cool_down_until).getTime() - new Date(res.body.ticket.created_at).getTime();
    expect(windowMs).toBe(30 * 60_000);

    await flushAsync();
    expect(mockOutbox).toHaveLength(1);
    expect(mockOutbox[0].priority).toBe('standard');
    expect(mockOutbox[0].text.body).toContain('COOL-OFF LOGGED — West Hub');
    expect(mockOutbox[0].to).toBe('GROUP-SUPERVISORS');
  });

  it('Scenario A: completely refused has no cool-down', async () => {
    const res = await scan({ ...baseScan, action_logged: 'refused' });
    expect(res.body.ticket.current_status).toBe('completely_refused');
    expect(res.body.ticket.cool_down_until).toBeNull();
    expect(res.body.event.action_logged).toBe('initial_refusal');
  });

  it('Scenario B: hub hopping logs a breach, leaves status alone, blocks the steward and fires a high alert', async () => {
    await scan(baseScan);
    mockOutbox.length = 0;

    const res = await scan({ ...baseScan, hub_location: 'South Hub', steward_name: 'Steward Sarah' });
    expect(res.status).toBe(200);
    expect(res.body.scenario).toBe('HUB_HOP_BYPASS');
    expect(res.body.screen.block_entry).toBe(true);
    expect(res.body.event).toMatchObject({ action_logged: 'bypass_attempt', is_breach_event: true, hub_location: 'South Hub' });
    expect(res.body.ticket.current_status).toBe('cooling_off');

    const { rows } = await getPool().query('SELECT current_status FROM tickets WHERE ticket_id = $1', [baseScan.ticket_id]);
    expect(rows[0].current_status).toBe('cooling_off');

    await flushAsync();
    expect(mockOutbox).toHaveLength(1);
    expect(mockOutbox[0].priority).toBe('high');
    expect(mockOutbox[0].text.body).toContain(
      '🚨 *CRITICAL RE-SCAN DETECTED:* Ticket TM-847294-X is attempting a gate-bypass at *South Hub*! Original cool-off logged at *West Hub*',
    );
    expect(mockOutbox[0].text.body).toContain('(Male, 6ft, neon green hat)');
  });

  it('Scenario C: admission of a flagged ticket is a critical breach naming the steward', async () => {
    await scan({ ...baseScan, action_logged: 'refused' });
    mockOutbox.length = 0;

    const res = await scan({ ...baseScan, hub_location: 'East Hub', steward_name: 'Steward Kevin', action_logged: 'admitted' });
    expect(res.body.scenario).toBe('UNAUTHORIZED_ADMISSION');
    expect(res.body.ticket.current_status).toBe('admitted');
    expect(res.body.event).toMatchObject({ action_logged: 'unauthorized_admission', is_breach_event: true });

    await flushAsync();
    expect(mockOutbox[0].priority).toBe('critical');
    expect(mockOutbox[0].text.body).toContain('UNAUTHORIZED ADMISSION');
    expect(mockOutbox[0].text.body).toContain('Steward Kevin');
    expect(mockOutbox[0].text.body).toContain('*Breach entry point:* East Hub');
  });

  it('admission after the cool-off has expired is not a breach', async () => {
    const fortyMinsAgo = new Date(Date.now() - 40 * 60_000).toISOString();
    await scan({ ...baseScan, occurred_at: fortyMinsAgo });
    const res = await scan({ ...baseScan, action_logged: 'admitted' });
    expect(res.body.scenario).toBe('CLEARED_ADMISSION');
    expect(res.body.event).toMatchObject({ action_logged: 'cleared_admission', is_breach_event: false });
  });

  it('serialises simultaneous first scans of the same ticket at two hubs', async () => {
    const [a, b] = await Promise.all([scan(baseScan), scan({ ...baseScan, hub_location: 'Hospitality Hub', steward_name: 'John' })]);
    const scenarios = [a.body.scenario, b.body.scenario].sort();
    expect(scenarios).toEqual(['HUB_HOP_BYPASS', 'NEW_INCIDENT']);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM scan_events');
    expect(rows[0].n).toBe(2);
  });

  it('pre-check endpoint reports a flagged ticket', async () => {
    await scan(baseScan);
    const res = await request(app).get(`/api/tickets/${baseScan.ticket_id}`);
    expect(res.body).toMatchObject({ found: true, flagged: true, origin_hub: 'West Hub' });
    expect(res.body.mins_left).toBe(30);
    const miss = await request(app).get('/api/tickets/UNKNOWN-1');
    expect(miss.body).toMatchObject({ found: false });
  });

  it('two-way bot: "Check" returns the profile with history; unknown IDs get the not-found reply', async () => {
    await scan(baseScan);
    await scan({ ...baseScan, hub_location: 'South Hub', steward_name: 'Steward Sarah' });
    await scan({ ...baseScan, hub_location: 'Hospitality Hub', steward_name: 'Steward John' });
    mockOutbox.length = 0;

    const reply = await handleInboundMessage({ id: crypto.randomUUID(), from: '447700900000', groupId: 'GROUP-SUPERVISORS', text: 'check tm-847294-x' });
    expect(reply).toContain('🤖 *TICKET PROFILE RETRIEVED* 🤖');
    expect(reply).toContain('*Ticket ID:* TM-847294-X');
    expect(reply).toContain('*Current Status:* 🟠 COOLING OFF');
    expect(reply).toMatch(/\*Remaining Time:\* (29|30) minutes/);
    expect(reply).toContain('*Party Size:* 4 People');
    expect(reply).toContain('🔄 *Scan Event History:* (⚠️ 2 breach events)');
    expect(reply).toContain('[South Hub]: 🚨 Bypass Attempt Intercepted by Steward Sarah (Blocked).');
    expect(mockOutbox.at(-1)?.to).toBe('GROUP-SUPERVISORS');

    const miss = await handleInboundMessage({ id: crypto.randomUUID(), from: 'x', groupId: 'GROUP-SUPERVISORS', text: 'Check NOPE-1' });
    expect(miss).toBe('❌ *No Database Record Extracted for Ticket ID:* NOPE-1');

    const otherGroup = await handleInboundMessage({ id: crypto.randomUUID(), from: 'x', groupId: 'RANDOM', text: 'Check TM-847294-X' });
    expect(otherGroup).toBeNull();
  });

  it('webhook POST acks immediately and enforces the app signature when configured', async () => {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    expect((await request(app).post('/api/whatsapp/incoming').set('content-type', 'application/json').send(payload)).status).toBe(200);

    process.env.WHATSAPP_APP_SECRET = 'shh';
    resetConfigCache();
    try {
      const unsigned = await request(app).post('/api/whatsapp/incoming').set('content-type', 'application/json').send(payload);
      expect(unsigned.status).toBe(401);
      const sig = 'sha256=' + crypto.createHmac('sha256', 'shh').update(payload).digest('hex');
      const signed = await request(app)
        .post('/api/whatsapp/incoming')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', sig)
        .send(payload);
      expect(signed.status).toBe(200);
    } finally {
      delete process.env.WHATSAPP_APP_SECRET;
      resetConfigCache();
    }
  });

  it('offline buffer: DB outage writes offline_incidents.log, alerts WhatsApp, then re-syncs with original timestamps', async () => {
    const logFile = tempOfflineLog();
    const goodUrl = process.env.DATABASE_URL!;

    // Simulate the database dropping.
    await closePool();
    process.env.DATABASE_URL = 'postgres://postgres@127.0.0.1:1/unreachable';
    resetConfigCache();
    try {
      const res = await scan(baseScan);
      expect(res.status).toBe(202);
      expect(res.body.buffered).toBe(true);
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).payload.ticket_id).toBe(baseScan.ticket_id);
      await flushAsync();
      expect(mockOutbox.at(-1)?.text.body).toContain('DATABASE OFFLINE');
    } finally {
      await closePool();
      process.env.DATABASE_URL = goodUrl;
      resetConfigCache();
    }

    const buffered = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    mockOutbox.length = 0;
    const report = await resyncOfflineIncidents();
    expect(report).toMatchObject({ synced: 1, failed: 0, requeued: 0 });
    expect(fs.existsSync(logFile)).toBe(false);
    expect(fs.existsSync(logFile.replace(/\.log$/, '.synced.log'))).toBe(true);

    const { rows } = await getPool().query('SELECT created_at FROM tickets WHERE ticket_id = $1', [baseScan.ticket_id]);
    expect(Math.abs(new Date(rows[0].created_at).getTime() - new Date(buffered.payload.occurred_at).getTime())).toBeLessThan(1000);
    expect(mockOutbox[0].text.body).toContain('DELAYED SYNC');
  });
});

describe('steward access key', () => {
  it('guards steward endpoints but never the Meta webhook', async () => {
    process.env.STEWARD_API_KEY = 'gate-key';
    try {
      expect((await request(app).post('/api/scan').send({})).status).toBe(401);
      expect((await request(app).post('/api/scan').set('x-api-key', 'gate-key').send({})).status).toBe(400);
      const hook = await request(app)
        .get('/api/whatsapp/incoming')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': 'ok' });
      expect(hook.status).toBe(200);
    } finally {
      delete process.env.STEWARD_API_KEY;
    }
  });
});
