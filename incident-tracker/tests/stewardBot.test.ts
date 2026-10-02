import QRCode from 'qrcode';
import { Jimp } from 'jimp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool';
import { decodeQrFromImage, ticketCodeFromQr } from '../src/services/qrImage';
import { purgeExpired } from '../src/services/retention';
import { StewardBot, parseDecision, parseHub, parseLogCommand, type InboundMessage } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const SAFETIX = 'SAFETIX:eyJ0IjoiVE0tODQ3Mjk0LVgiLCJzIjoiNjIzODQxMDk4MjM3NDEiLCJ0cyI6MTc5MDk2MTE2Mn0.rotating.token.abc123';

async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { width: 400, margin: 4 });
}
async function plainPhoto(): Promise<Buffer> {
  const img = new Jimp({ width: 120, height: 90, color: 0x336699ff });
  return img.getBuffer('image/png');
}

describe('log message parsing', () => {
  it('reads decision, seat, hub and notes from one line', () => {
    expect(parseLogCommand('REFUSED BB 212 100 West green hat, very drunk')).toEqual({
      decision: 'refused', section: 'BB', row: '212', seat: '100', hub: 'West Hub', notes: 'green hat, very drunk',
    });
    expect(parseLogCommand('30 bb 212 100 hospitality')).toEqual({ decision: 'cool_off', section: 'BB', row: '212', seat: '100', hub: 'Hospitality Hub' });
    expect(parseLogCommand('sent away Section BB Row 212 Seat 100 swaying')).toMatchObject({ decision: 'cool_off', seat: '100', notes: 'swaying' });
    expect(parseLogCommand('Refused')).toEqual({ decision: 'refused' });
  });

  it('reads "30 min" and section-row-seat order', () => {
    for (const d of ['30 min', '30min', '30 mins', '30 minutes']) {
      expect(parseLogCommand(`${d} 52 YY 14 East drunk`)).toEqual({ decision: 'cool_off', section: '52', row: 'YY', seat: '14', hub: 'East Hub', notes: 'drunk' });
    }
    expect(parseDecision('30 min')).toBe('cool_off');
  });

  it('ignores ordinary chat', () => {
    for (const t of ['really busy at the south gate', 'see you 10', 'r u there', 'sa', 'coolest night ever']) {
      expect(parseLogCommand(t)).toBeNull();
    }
  });

  it('parses single-word answers', () => {
    expect(parseDecision('30')).toBe('cool_off');
    expect(parseDecision('refused')).toBe('refused');
    expect(parseHub('hosp')).toBe('Hospitality Hub');
    expect(parseHub('South hub')).toBe('South Hub');
  });
});

describe('QR codes in photos', () => {
  it('decodes a Ticketmaster-style QR and fingerprints long payloads', async () => {
    const raw = await decodeQrFromImage(await qrPng(SAFETIX));
    expect(raw).toBe(SAFETIX);
    expect(await ticketCodeFromQr(raw!)).toMatch(/^QR-[0-9a-f]{32}$/);
    expect(await ticketCodeFromQr('TM-847294-X')).toBe('TM-847294-X');
  });

  it('returns null for photos without a QR code or non-images', async () => {
    expect(await decodeQrFromImage(await plainPhoto())).toBeNull();
    expect(await decodeQrFromImage(Buffer.from('not an image'))).toBeNull();
  });
});

describe.skipIf(!HAS_DB)('steward WhatsApp flow (PostgreSQL)', () => {
  let clock = Date.now();
  let bot: StewardBot;
  const msg = (senderId: string, text: string | null, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    chatId: 'work-group@g.us',
    senderId,
    senderName: senderId === 'sarah' ? 'Sarah' : senderId === 'dave' ? 'Dave' : 'Priya',
    text,
    at: new Date(clock),
    ...extra,
  });

  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    clock = Date.now();
    bot = new StewardBot(() => clock);
  });
  afterAll(async () => {
    await closePool();
  });

  it('logs in one message and answers a check by seat', async () => {
    const [r] = await bot.handle(msg('dave', 'REFUSED BB 212 100 West green hat, very drunk'));
    expect(r.text).toContain('✅ Logged 🔴 *REFUSED* · BB 212 100');
    expect(r.text).toContain('West Hub');

    const [c] = await bot.handle(msg('sarah', 'BB 212 100'));
    expect(c.text).toContain('🔴 *REFUSED*');
    expect(c.text).toContain('green hat, very drunk');
    expect(c.text).toContain('by Dave');
  });

  it('walks a steward through a QR photo step by step, remembering their hub next time', async () => {
    const [a] = await bot.handle(msg('dave', null, { image: { data: await qrPng(SAFETIX), mime: 'image/png' } }));
    expect(a.text).toContain('🎟️ Ticket QR read.');
    expect(a.text).toContain('Refused or sent away');
    const [b] = await bot.handle(msg('dave', '30'));
    expect(b.text).toContain('Which seat?');
    const [c] = await bot.handle(msg('dave', 'BB 212 100'));
    expect(c.text).toContain('Which hub');
    const [d] = await bot.handle(msg('dave', 'west'));
    expect(d.text).toContain('Reason?');
    const [e] = await bot.handle(msg('dave', 'stumbling, slurring'));
    expect(e.text).toContain('✅ Logged 🟠 *SENT AWAY 30 MIN* · BB 212 100');
    expect(e.text).toContain('back after');

    const { rows } = await getPool().query('SELECT ticket_id, seat_key FROM tickets');
    expect(rows[0].ticket_id).toMatch(/^QR-/);
    expect(rows[0].seat_key).toBe('BB|212|100');

    // Next log from Dave: hub isn't asked again.
    const [f] = await bot.handle(msg('dave', 'REFUSED C 4 22 aggressive'));
    expect(f.text).toContain('✅ Logged 🔴 *REFUSED* · C 4 22');
    expect(f.text).toContain('Hub: West Hub (remembered)');
  });

  it('stores the customer photo and sends it back with a check', async () => {
    const photo = await plainPhoto();
    const [a] = await bot.handle(msg('dave', 'REFUSED BB 212 100 West', { image: { data: photo, mime: 'image/png' } }));
    expect(a.text).toContain('📷 Photo saved. Reason?');
    await bot.handle(msg('dave', 'very drunk'));
    const [c] = await bot.handle(msg('sarah', 'BB 212 100'));
    expect(c.image?.data.equals(photo)).toBe(true);
  });

  it('flags a second attempt at another hub', async () => {
    await bot.handle(msg('dave', '30 BB 212 100 West very drunk'));
    clock += 10 * 60_000;
    const [r] = await bot.handle(msg('sarah', '30 BB 212 100 South -', { at: new Date(clock) }));
    expect(r.text).toContain('🚨 *ALREADY SENT AWAY* · BB 212 100');
    expect(r.text).toContain('First at *West Hub*');
    expect(r.text).toContain('Do not admit');
  });

  it('says NOT REFUSED for unknown seats and stays quiet for chat and random photos', async () => {
    const [r] = await bot.handle(msg('sarah', 'BB 1 2'));
    expect(r.text).toContain('✅ *NOT REFUSED*');
    expect(await bot.handle(msg('sarah', 'anyone want a coffee?'))).toEqual([]);
    expect(await bot.handle(msg('sarah', null, { image: { data: await plainPhoto(), mime: 'image/png' } }))).toEqual([]);
  });

  it('keeps stewards apart, supports CANCEL and UNDO', async () => {
    await bot.handle(msg('dave', 'REFUSED'));
    // Sarah's check isn't swallowed by Dave's half-finished log.
    const [check] = await bot.handle(msg('sarah', 'BB 9 9'));
    expect(check.text).toContain('NOT REFUSED');
    expect((await bot.handle(msg('dave', 'cancel')))[0].text).toContain('Cancelled');

    await bot.handle(msg('priya', 'REFUSED D 1 1 East -'));
    expect((await bot.handle(msg('priya', 'undo')))[0].text).toContain('Removed your last record');
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM tickets');
    expect(rows[0].n).toBe(0);
  });

  it('deletes records older than the retention window', async () => {
    await bot.handle(msg('dave', 'REFUSED BB 212 100 West -'));
    // The updated_at trigger would reset the timestamp, so backdate with it switched off.
    await getPool().query('ALTER TABLE tickets DISABLE TRIGGER trg_tickets_updated_at');
    try {
      await getPool().query("UPDATE tickets SET created_at = created_at - interval '25 hours', updated_at = NOW() - interval '25 hours'");
    } finally {
      await getPool().query('ALTER TABLE tickets ENABLE TRIGGER trg_tickets_updated_at');
    }
    expect(await purgeExpired(24)).toBe(1);
    const [c] = await bot.handle(msg('sarah', 'BB 212 100'));
    expect(c.text).toContain('NOT REFUSED');
  });
});
