import { Jimp } from 'jimp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool';
import { StewardBot, type InboundMessage } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const seat = (section: string, row: string, n: string) => ({ section, row, seat: n });

describe.skipIf(!HAS_DB)('seats read from a ticket photo (PostgreSQL)', () => {
  let bot: StewardBot;
  let photo: Buffer;
  let ocrResult: Array<{ section: string; row: string; seat: string }> = [];
  let ocrCalls = 0;
  const msg = (senderId: string, text: string | null, withPhoto = false): InboundMessage => ({
    chatId: 'g@g.us', senderId, senderName: senderId === 'dave' ? 'Dave' : 'Sarah', text, at: new Date(),
    image: withPhoto ? { data: photo, mime: 'image/png' } : null,
  });
  const count = async () => (await getPool().query('SELECT count(*)::int AS n FROM tickets')).rows[0].n;

  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    bot = new StewardBot();
    ocrCalls = 0;
    bot.ocr = async () => (ocrCalls++, ocrResult);
    photo = await new Jimp({ width: 40, height: 40, color: 0xffffffff }).getBuffer('image/png');
  });
  afterAll(async () => {
    await closePool();
  });

  it('fills the seat from a ticket photo captioned REFUSED', async () => {
    ocrResult = [seat('313', 'YY', '56')];
    const [a] = await bot.handle(msg('dave', 'REFUSED', true));
    expect(a.text).toContain('🎫 Seat from the ticket: *313 YY 56*');
    expect(a.text).toContain('Which hub');
    await bot.handle(msg('dave', '2'));
    const [b] = await bot.handle(msg('dave', '1 -'));
    expect(b.text).toContain('✅ Logged 🔴 *REFUSED* · 313 YY 56');
  });

  it('asks which seats when the ticket shows several, across rows', async () => {
    ocrResult = [seat('313', 'YY', '56'), seat('313', 'YY', '57'), seat('313', 'ZZ', '10')];
    const [a] = await bot.handle(msg('dave', 'EJECTED', true));
    expect(a.text).toContain('*1* 313 YY 56');
    expect(a.text).toContain('*2* 313 YY 57');
    expect(a.text).toContain('*3* 313 ZZ 10');
    expect((await bot.handle(msg('dave', '7')))[0].text).toContain('*1* 313 YY 56'); // not an option: asked again
    expect((await bot.handle(msg('dave', '1 3')))[0].text).toContain('Which hub');
    await bot.handle(msg('dave', '2'));
    const [done] = await bot.handle(msg('dave', '1 -'));
    expect(done.text).toContain('✅ Logged ⛔ *EJECTED* · 313 YY 56 · 313 ZZ 10');
    const { rows } = await getPool().query('SELECT row_label, seat_number FROM tickets ORDER BY row_label');
    expect(rows).toEqual([{ row_label: 'YY', seat_number: '56' }, { row_label: 'ZZ', seat_number: '10' }]);
  });

  it('accepts ALL for every seat shown', async () => {
    ocrResult = [seat('300', 'L', '205'), seat('300', 'L', '206')];
    await bot.handle(msg('dave', 'REFUSED West', true));
    const [b] = await bot.handle(msg('dave', 'all'));
    expect(b.text).toContain('Reason?');
    await bot.handle(msg('dave', '1 -'));
    expect(await count()).toBe(2);
  });

  it('reads the seat when the photo answers "Which seat?"', async () => {
    ocrResult = [seat('52', 'YY', '14')];
    await bot.handle(msg('dave', 'LOG'));
    expect((await bot.handle(msg('dave', '1')))[0].text).toContain('Which seat?');
    const [a] = await bot.handle(msg('dave', null, true));
    expect(a.text).toContain('🎫 Seat from the ticket: *52 YY 14*');
  });

  it('SCAN checks the seats, and a decision sent next logs them', async () => {
    await bot.handle(msg('sarah', 'REFUSED 313 YY 56 West 1 -'));
    ocrResult = [seat('313', 'YY', '56'), seat('313', 'YY', '57')];
    const [c] = await bot.handle(msg('dave', 'SCAN', true));
    expect(c.text).toMatch(/🔴 \*313 YY 56\*/);
    expect(c.text).toMatch(/✅ \*313 YY 57\* · not refused/);
    expect(c.text).toContain('To log these, send *REFUSED*, *30* or *EJECTED*');
    const [d] = await bot.handle(msg('dave', 'REFUSED South 2 -'));
    expect(d.text).toContain('313 YY 56, 57');
    expect(d.text).toContain('🚨'); // 56 was already refused at West
    expect(await count()).toBe(2);
  });

  it('treats a photo with no seat on it as the customer photo', async () => {
    ocrResult = [];
    const [a] = await bot.handle(msg('dave', 'REFUSED', true));
    expect(a.text).toContain('📷 Photo saved.');
    expect(a.text).toContain('Which seat?');
  });

  it('does not run OCR on ordinary photos or when the seat is already given', async () => {
    ocrResult = [seat('1', 'A', '1')];
    expect(await bot.handle(msg('dave', null, true))).toEqual([]); // a photo in the group chat
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West', true));
    expect(ocrCalls).toBe(0);
  });
});
