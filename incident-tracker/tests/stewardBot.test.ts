import QRCode from 'qrcode';
import { Jimp } from 'jimp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool';
import { decodeQrFromImage, ticketCodeFromQr } from '../src/services/qrImage';
import { purgeExpired } from '../src/services/retention';
import { StewardBot, parseDecision, parseDetails, parseHub, parseLogCommand, type InboundMessage } from '../src/services/stewardBot';
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
      decision: 'refused', section: 'BB', row: '212', seat: '100', hub: 'West Hub', clothing: 'green hat, very drunk',
    });
    expect(parseLogCommand('REFUSED 52 YY 14 West 1 3 M 3 2 adult green hat')).toEqual({
      decision: 'refused', section: '52', row: 'YY', seat: '14', hub: 'West Hub', reasons: ['Intoxicated', 'Under the influence'],
      gender: 'Male', height: 'Tall', build: 'Average build', age: 'Adult', clothing: 'green hat',
    });
    expect(parseLogCommand('30 bb 212 100 hospitality')).toEqual({ decision: 'cool_off', section: 'BB', row: '212', seat: '100', hub: 'Hospitality Hub' });
    expect(parseLogCommand('sent away Section BB Row 212 Seat 100 swaying')).toMatchObject({ decision: 'cool_off', seat: '100', clothing: 'swaying' });
    expect(parseLogCommand('Refused')).toEqual({ decision: 'refused' });
  });

  it('reads "30 min" and section-row-seat order', () => {
    for (const d of ['30 min', '30min', '30 mins', '30 minutes']) {
      expect(parseLogCommand(`${d} 52 YY 14 East drunk`)).toEqual({ decision: 'cool_off', section: '52', row: 'YY', seat: '14', hub: 'East Hub', reasons: ['Intoxicated'] });
    }
    expect(parseDecision('30 min')).toBe('cool_off');
  });

  it('reads one or more reasons', () => {
    expect(parseDetails('1 3 5')).toEqual({ reasons: ['Intoxicated', 'Under the influence', 'Found in possession'] });
    expect(parseDetails('1,3,5')).toEqual(parseDetails('1 3 5'));
    expect(parseDetails('135')).toEqual(parseDetails('1 3 5'));
    expect(parseDetails('2 2 abusive')).toEqual({ reasons: ['Abusive'] }); // no repeats
    expect(parseDetails('drunk & abusive')).toEqual({ reasons: ['Intoxicated', 'Abusive'] });
    expect(parseDetails('6 1')).toEqual({ reasons: ['Other', 'Intoxicated'] });
    expect(parseDetails('7')).toEqual({ clothing: '7' });
    expect(parseDetails('stumbling')).toEqual({ clothing: 'stumbling' });
  });

  it('reads the description options in the order they are asked', () => {
    expect(parseDetails('4 f 1 1 minor red dress')).toEqual({
      reasons: ['Intoxicated minor'], gender: 'Female', height: 'Short', build: 'Slim', age: 'Minor (under 18)', clothing: 'red dress',
    });
    expect(parseDetails('possession male tall heavy adult')).toEqual({
      reasons: ['Found in possession'], gender: 'Male', height: 'Tall', build: 'Heavy', age: 'Adult',
    });
    expect(parseDetails('3 -')).toEqual({ reasons: ['Under the influence'], gender: '', height: '', build: '', age: '', clothing: '' });
    expect(parseDetails('abusive green hat')).toEqual({ reasons: ['Abusive'], clothing: 'green hat' });
    expect(parseDetails('2 f black dress 3', 'reasons')).toEqual({ reasons: ['Abusive'], gender: 'Female', clothing: 'black dress 3' });
    expect(parseDetails('2', 'height')).toEqual({ height: 'Average height' });
    expect(parseDetails('3', 'build')).toEqual({ build: 'Heavy' });
    expect(parseDetails('average', 'build')).toEqual({ build: 'Average build' });
    expect(parseDetails('2', 'age')).toEqual({ age: 'Minor (under 18)' });
    expect(parseDetails('A', 'age')).toEqual({ age: 'Adult' });
    expect(parseDetails('a green hat', 'gender')).toEqual({ clothing: 'a green hat' }); // "a" is not "adult" here
    expect(parseDetails('F 1 3 black jacket', 'gender')).toEqual({ gender: 'Female', height: 'Short', build: 'Heavy', clothing: 'black jacket' });
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
    const [r] = await bot.handle(msg('dave', 'REFUSED BB 212 100 West 1 2 M 3 2 adult green hat, very drunk'));
    expect(r.text).toContain('✅ Logged 🔴 *REFUSED* · BB 212 100');
    expect(r.text).toContain('West Hub');
    expect(r.text).toContain('📝 Intoxicated, Abusive');
    expect(r.text).toContain('👤 Male · Tall · Average build · Adult · green hat, very drunk');

    const [c] = await bot.handle(msg('sarah', 'BB 212 100'));
    expect(c.text).toContain('🔴 *REFUSED*');
    expect(c.text).toContain('green hat, very drunk');
    expect(c.text).toContain('Intoxicated, Abusive');
    expect(c.text).toContain('by Dave');
  });

  it('walks a steward through a QR photo step by step, remembering their hub next time', async () => {
    const [a] = await bot.handle(msg('dave', null, { image: { data: await qrPng(SAFETIX), mime: 'image/png' } }));
    expect(a.text).toContain('🎟️ Ticket QR read.');
    expect(a.text).toContain('Refused entry, or sent away for 30 minutes?');
    const [b] = await bot.handle(msg('dave', '2'));
    expect(b.text).toContain('Which seat?');
    const [c] = await bot.handle(msg('dave', 'BB 212 100'));
    expect(c.text).toContain('Which hub');
    const [d] = await bot.handle(msg('dave', 'west'));
    expect(d.text).toContain('Reason?');
    expect(d.text).toContain('*4* Intoxicated minor');
    expect(d.text).toContain('e.g. *1 3 5*');
    expect((await bot.handle(msg('dave', 'stumbling')))[0].text).toContain('Reason?'); // not an option: asked again
    expect((await bot.handle(msg('dave', '3 5')))[0].text).toContain('Male or female?');
    expect((await bot.handle(msg('dave', 'm')))[0].text).toContain('Height?');
    expect((await bot.handle(msg('dave', '3')))[0].text).toContain('Build?');
    expect((await bot.handle(msg('dave', '-')))[0].text).toContain('Minor or adult?');
    expect((await bot.handle(msg('dave', '2')))[0].text).toContain('What are they wearing?');
    const [e] = await bot.handle(msg('dave', 'black jacket'));
    expect(e.text).toContain('✅ Logged 🟠 *SENT AWAY 30 MIN* · BB 212 100');
    expect(e.text).toContain('📝 Under the influence, Found in possession');
    expect(e.text).toContain('👤 Male · Tall · Minor (under 18) · black jacket');
    expect(e.text).toContain('back after');

    const { rows } = await getPool().query('SELECT ticket_id, seat_key FROM tickets');
    expect(rows[0].ticket_id).toMatch(/^QR-/);
    expect(rows[0].seat_key).toBe('BB|212|100');

    // Next log from Dave: hub isn't asked again.
    const [f] = await bot.handle(msg('dave', 'REFUSED C 4 22 2 -'));
    expect(f.text).toContain('✅ Logged 🔴 *REFUSED* · C 4 22');
    expect(f.text).toContain('Hub: West Hub (remembered)');
  });

  it('stores the customer photo and sends it back with a check', async () => {
    const photo = await plainPhoto();
    const [a] = await bot.handle(msg('dave', 'REFUSED BB 212 100 West', { image: { data: photo, mime: 'image/png' } }));
    expect(a.text).toContain('📷 Photo saved. Reason?');
    await bot.handle(msg('dave', '1 -'));
    const [c] = await bot.handle(msg('sarah', 'BB 212 100'));
    expect(c.image?.data.equals(photo)).toBe(true);
  });

  it('flags a second attempt at another hub', async () => {
    await bot.handle(msg('dave', '30 BB 212 100 West 1 -'));
    clock += 10 * 60_000;
    const [r] = await bot.handle(msg('sarah', '30 BB 212 100 South 1 -', { at: new Date(clock) }));
    expect(r.text).toContain('🚨 *ALREADY SENT AWAY* · BB 212 100');
    expect(r.text).toContain('First at *West Hub*');
    expect(r.text).toContain('Do not admit');
  });

  it('asks what happened when Other is one of the reasons', async () => {
    expect((await bot.handle(msg('dave', 'REFUSED 52 YY 14 West 2 6')))[0].text).toContain('What happened?');
    expect((await bot.handle(msg('dave', '-')))[0].text).toContain('What happened?'); // Other can't be skipped
    expect((await bot.handle(msg('dave', 'threw a bottle')))[0].text).toContain('Male or female?');
    const [r] = await bot.handle(msg('dave', 'F 2 3 -'));
    expect(r.text).toContain('📝 Abusive, Other: threw a bottle');
    expect(r.text).toContain('👤 Female · Average height · Heavy');
  });

  it('starts a log with LOG or a photo captioned with the seat, asking every question', async () => {
    const [a] = await bot.handle(msg('dave', 'log'));
    expect(a.text).toContain('Refused entry, or sent away');
    expect((await bot.handle(msg('dave', '1')))[0].text).toContain('Which seat?');
    await bot.handle(msg('priya', '52 YY 14', { image: { data: await plainPhoto(), mime: 'image/png' } }));
    const [b] = await bot.handle(msg('priya', '30'));
    expect(b.text).toContain('Which hub');
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

    await bot.handle(msg('priya', 'REFUSED D 1 1 East 2 -'));
    expect((await bot.handle(msg('priya', 'undo')))[0].text).toContain('Removed your last record');
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM tickets');
    expect(rows[0].n).toBe(0);
  });

  it('deletes records older than the retention window', async () => {
    await bot.handle(msg('dave', 'REFUSED BB 212 100 West 1 -'));
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
