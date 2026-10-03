import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool';
import { StewardBot, parseLogCommand, parseSeatAnswer, type InboundMessage } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

describe('several seats in one message: parsing', () => {
  it('reads a list of seats after the row', () => {
    expect(parseLogCommand('REFUSED 300 L 205 206 207 West 1 -')).toMatchObject({
      section: '300', row: 'L', seat: '205', extraSeats: ['206', '207'], hub: 'West Hub', reasons: ['Intoxicated'],
    });
    expect(parseLogCommand('REFUSED 223 Y 100 101 102 103 104 South 2 -')).toMatchObject({
      section: '223', row: 'Y', seat: '100', extraSeats: ['101', '102', '103', '104'], hub: 'South Hub', reasons: ['Abusive'],
    });
  });

  it('accepts commas, "and" and ranges', () => {
    expect(parseLogCommand('REFUSED 300 L 205, 206 and 207 West')).toMatchObject({ seat: '205', extraSeats: ['206', '207'], hub: 'West Hub' });
    expect(parseLogCommand('REFUSED 300 L 205,206,207 West')).toMatchObject({ seat: '205', extraSeats: ['206', '207'] });
    expect(parseLogCommand('REFUSED 300 L 205-207 West')).toMatchObject({ seat: '205', extraSeats: ['206', '207'] });
    expect(parseLogCommand('30 300 L 205 & 206 East')).toMatchObject({ seat: '205', extraSeats: ['206'], hub: 'East Hub' });
  });

  it('drops repeats and caps the group at 20 seats', () => {
    expect(parseLogCommand('REFUSED 300 L 205 205 206 West')).toMatchObject({ seat: '205', extraSeats: ['206'] });
    const big = parseLogCommand('REFUSED 300 L 100-140 West');
    expect(big?.extraSeats).toHaveLength(19);
  });

  it('keeps small numbers after a big seat as reasons, not seats', () => {
    const p = parseLogCommand('REFUSED 300 L 205 1 2 -');
    expect(p).toMatchObject({ seat: '205', reasons: ['Intoxicated', 'Abusive'] });
    expect(p?.extraSeats).toBeUndefined();
    expect(parseLogCommand('REFUSED 300 L 205 West 1 2 -')?.extraSeats).toBeUndefined();
    expect(parseLogCommand('REFUSED 52 YY 14 West 1 3 M 3 2 adult green hat')?.extraSeats).toBeUndefined();
  });

  it('reads a list as the answer to "Which seat?"', () => {
    expect(parseSeatAnswer('300 L 205 206 207')).toEqual({ section: '300', row: 'L', seat: '205', extraSeats: ['206', '207'] });
    expect(parseSeatAnswer('300 L 205')).toEqual({ section: '300', row: 'L', seat: '205' });
  });
});

describe.skipIf(!HAS_DB)('several seats in one message (PostgreSQL)', () => {
  let bot: StewardBot;
  const msg = (senderId: string, text: string): InboundMessage => ({
    chatId: 'g@g.us', senderId, senderName: senderId === 'dave' ? 'Dave' : 'Sarah', text, at: new Date(),
  });
  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    bot = new StewardBot();
  });
  afterAll(async () => {
    await closePool();
  });

  it('logs one record per seat, sharing the answers, as a group', async () => {
    const [r] = await bot.handle(msg('dave', 'REFUSED 300 L 205 206 207 West 1 M 3 2 adult green hats'));
    expect(r.text).toContain('✅ Logged 🔴 *REFUSED* · 300 L 205, 206, 207');
    expect(r.text).toContain('👥 Group of 3');
    const { rows } = await getPool().query('SELECT seat_number, party_size, reasoning, description FROM tickets ORDER BY seat_number');
    expect(rows.map((t) => t.seat_number)).toEqual(['205', '206', '207']);
    for (const t of rows) {
      expect(t.party_size).toBe(3);
      expect(t.reasoning).toBe('Intoxicated');
      expect(t.description).toContain('green hats');
    }
    expect((await bot.handle(msg('sarah', '300 L 206')))[0].text).toContain('🔴 *REFUSED*');
    expect((await bot.handle(msg('sarah', 'LIST')))[0].text).toContain('🔴 *REFUSED* (3)');
  });

  it('asks the questions once for the whole group', async () => {
    await bot.handle(msg('dave', 'LOG'));
    await bot.handle(msg('dave', '2'));
    const [a] = await bot.handle(msg('dave', '223 Y 100-104'));
    expect(a.text).toContain('Which hub');
    await bot.handle(msg('dave', '3'));
    const [b] = await bot.handle(msg('dave', '1 -'));
    expect(b.text).toContain('✅ Logged 🟠 *SENT AWAY 30 MIN* · 223 Y 100, 101, 102, 103, 104');
    expect((await getPool().query('SELECT count(*)::int AS n FROM tickets')).rows[0].n).toBe(5);
  });

  it('checks several seats at once', async () => {
    await bot.handle(msg('dave', 'REFUSED 300 L 205 206 West 1 -'));
    const [c] = await bot.handle(msg('sarah', '300 L 205 206 207'));
    expect(c.text).toContain('300 L 205');
    expect(c.text).toMatch(/🔴 \*300 L 205\*/);
    expect(c.text).toMatch(/🔴 \*300 L 206\*/);
    expect(c.text).toMatch(/✅ \*300 L 207\* · not refused/);
  });

  it('UNDO removes the whole group', async () => {
    await bot.handle(msg('dave', 'REFUSED 300 L 205 206 207 West 1 -'));
    expect((await bot.handle(msg('dave', 'undo')))[0].text).toContain('Removed your last record');
    expect((await getPool().query('SELECT count(*)::int AS n FROM tickets')).rows[0].n).toBe(0);
  });

  it('flags group members already refused at another hub', async () => {
    await bot.handle(msg('dave', 'REFUSED 300 L 206 West 1 -'));
    const [r] = await bot.handle(msg('sarah', 'REFUSED 300 L 205 206 207 South 1 -'));
    expect(r.text).toContain('🚨');
    expect(r.text).toContain('300 L 206');
    expect(r.text).toContain('Do not admit');
  });
});
