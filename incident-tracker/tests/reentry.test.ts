import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool';
import { StewardBot, type InboundMessage } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

describe.skipIf(!HAS_DB)('re-entry attempts (PostgreSQL)', () => {
  let bot: StewardBot;
  const msg = (senderId: string, text: string): InboundMessage => ({
    chatId: 'g@g.us', senderId, senderName: senderId === 'dave' ? 'Dave' : 'Sarah', text, at: new Date(),
  });
  const reasoning = async (seat: string) =>
    (await getPool().query('SELECT reasoning FROM tickets WHERE seat_number = $1', [seat])).rows[0]?.reasoning as string;

  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    bot = new StewardBot();
  });
  afterAll(async () => {
    await closePool();
  });

  it('asks which hub they are trying to get in at, even with a shift hub, and records the re-entry', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1 -'));
    await bot.handle(msg('sarah', 'HUB SOUTH'));
    const [a] = await bot.handle(msg('sarah', 'REFUSED 313 YY 56'));
    expect(a.text).toContain('⚠️ *Already on record:*');
    expect(a.text).toContain('Which hub are they trying to get in at?');
    expect(a.text).toContain('Your shift hub: *South* (reply *3*)');
    expect((await bot.handle(msg('sarah', '3')))[0].text).toContain('Reason?');
    const [r] = await bot.handle(msg('sarah', '2 -'));
    expect(r.text).toContain('🚨 *ALREADY REFUSED* · 313 YY 56');
    expect(r.text).toContain('📝 Intoxicated, Already refused, tried re-entry, Abusive');
    expect(await reasoning('56')).toBe('Intoxicated, Already refused, tried re-entry, Abusive');
  });

  it('does not ask the hub when it is in the message', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1 -'));
    const [r] = await bot.handle(msg('sarah', 'REFUSED 313 YY 56 East 1 -'));
    expect(r.text).toContain('🚨 *ALREADY REFUSED*');
    expect(await reasoning('56')).toBe('Intoxicated, Already refused, tried re-entry');
  });

  it('says "sent away" for someone still cooling off', async () => {
    await bot.handle(msg('dave', '30 52 YY 14 West 3 -'));
    await bot.handle(msg('sarah', '30 52 YY 14 East 3 -'));
    expect(await reasoning('14')).toBe('Under the influence, Already sent away, tried re-entry');
  });

  it('does not repeat the re-entry reason on a third attempt', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1 -'));
    await bot.handle(msg('sarah', 'REFUSED 313 YY 56 East 1 -'));
    await bot.handle(msg('sarah', 'REFUSED 313 YY 56 South 1 -'));
    expect(await reasoning('56')).toBe('Intoxicated, Already refused, tried re-entry');
  });

  it('counts re-entries in STATS', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1 -'));
    await bot.handle(msg('sarah', 'REFUSED 313 YY 56 East 1 -'));
    expect((await bot.handle(msg('sarah', 'STATS')))[0].text).toContain('Already refused, tried re-entry 1');
  });

  it('marks only the group members who tried again', async () => {
    await bot.handle(msg('dave', 'REFUSED 300 L 206 West 1 -'));
    await bot.handle(msg('sarah', 'REFUSED 300 L 205 206 South 2 -'));
    expect(await reasoning('206')).toBe('Intoxicated, Already refused, tried re-entry, Abusive');
    expect(await reasoning('205')).toBe('Abusive');
  });

  it('still uses the shift hub for new people', async () => {
    await bot.handle(msg('sarah', 'HUB SOUTH'));
    expect((await bot.handle(msg('sarah', 'REFUSED 1 A 1 1 -')))[0].text).toContain('✅ Logged');
  });
});
