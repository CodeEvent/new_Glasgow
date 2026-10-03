import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool';
import { addCustomOption, customOptions } from '../src/services/customOptions';
import { BUILDS, StewardBot, type InboundMessage } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

describe.skipIf(!HAS_DB)('new options added by stewards (PostgreSQL)', () => {
  let bot: StewardBot;
  const msg = (senderId: string, text: string): InboundMessage => ({
    chatId: 'g@g.us', senderId, senderName: senderId === 'dave' ? 'Dave' : 'Sarah', text, at: new Date(),
  });
  const ticket = async (seat: string) =>
    (await getPool().query('SELECT reasoning, description FROM tickets WHERE seat_number = $1', [seat])).rows[0] as { reasoning: string; description: string };

  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    await getPool().query("DELETE FROM app_settings WHERE key = 'custom_options'");
    bot = new StewardBot();
  });
  afterAll(async () => {
    await closePool();
  });

  it('accepts a new reason and offers it next time as a numbered option', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West'));
    const [a] = await bot.handle(msg('dave', 'trespassing'));
    expect(a.text).toContain('➕ Added *Trespassing* to the reasons');
    expect(a.text).toContain('Male or female?');
    await bot.handle(msg('dave', '-'));
    await bot.handle(msg('dave', '-'));
    await bot.handle(msg('dave', '-'));
    await bot.handle(msg('dave', '-'));
    await bot.handle(msg('dave', '-'));
    expect((await ticket('56')).reasoning).toBe('Trespassing');

    const [b] = await bot.handle(msg('sarah', 'REFUSED 313 YY 57 West'));
    expect(b.text).toContain('*7* Trespassing');
    await bot.handle(msg('sarah', '1 7 -'));
    expect((await ticket('57')).reasoning).toBe('Intoxicated, Trespassing');
  });

  it('never adds duplicates, and maps words that mean an existing option', async () => {
    await bot.handle(msg('dave', 'REFUSED 1 A 1 West'));
    await bot.handle(msg('dave', 'trespassing'));
    await bot.handle(msg('dave', 'CANCEL'));
    await bot.handle(msg('dave', 'REFUSED 1 A 2 West'));
    const [a] = await bot.handle(msg('dave', '  TRESPASSING '));
    expect(a.text).not.toContain('➕ Added');
    await bot.handle(msg('dave', 'CANCEL'));
    await bot.handle(msg('dave', 'REFUSED 1 A 3 West'));
    const [b] = await bot.handle(msg('dave', 'drunk'));
    expect(b.text).not.toContain('➕ Added'); // drunk = Intoxicated
    const [o] = await bot.handle(msg('dave', 'OPTIONS'));
    expect(o.text.match(/Trespassing/g)).toHaveLength(1);
    expect(o.text).not.toMatch(/Drunk/i);
  });

  it('adds new heights and builds, maps synonyms', async () => {
    await bot.handle(msg('dave', 'REFUSED 1 A 1 West 1'));
    await bot.handle(msg('dave', 'M'));
    expect((await bot.handle(msg('dave', 'very short')))[0].text).toContain('Build?'); // = Short, nothing added
    const [b] = await bot.handle(msg('dave', 'muscular'));
    expect(b.text).toContain('➕ Added *Muscular* to the builds');
    await bot.handle(msg('dave', '1'));
    await bot.handle(msg('dave', '-'));
    expect((await ticket('1')).description).toBe('Male · Short · Muscular · Adult');
    await bot.handle(msg('sarah', 'REFUSED 1 A 2 West 1'));
    await bot.handle(msg('sarah', 'F'));
    await bot.handle(msg('sarah', '2'));
    expect((await bot.handle(msg('sarah', 'x')))[0].text).toContain('*4* Muscular');
  });

  it('does not add long or rambling answers', async () => {
    await bot.handle(msg('dave', 'REFUSED 1 A 1 West'));
    const [a] = await bot.handle(msg('dave', 'he was really very rude to the stewards and the police at the gate'));
    expect(a.text).toContain('Reason?'); // asked again
    expect((await bot.handle(msg('dave', 'OPTIONS')))[0].text).toContain('No new options yet');
  });

  it('keeps new options across restarts, and admins can remove them', async () => {
    await bot.handle(msg('dave', 'REFUSED 1 A 1 West'));
    await bot.handle(msg('dave', 'trespassing'));
    const fresh = new StewardBot();
    fresh.canSupervise = async (id) => id === 'sarah';
    expect((await fresh.handle(msg('dave', 'OPTIONS')))[0].text).toContain('Trespassing');
    expect((await fresh.handle(msg('dave', 'OPTIONS REMOVE Trespassing')))[0].text).toContain('⛔ Only group admins');
    expect((await fresh.handle(msg('sarah', 'OPTIONS REMOVE trespassing')))[0].text).toContain('Removed *Trespassing*');
    expect((await fresh.handle(msg('sarah', 'OPTIONS')))[0].text).toContain('No new options yet');
  });

  it('the list itself refuses duplicates and fixed options, whatever the case', async () => {
    expect(await addCustomOption('builds', 'Muscular', BUILDS)).toEqual({ term: 'Muscular', added: true });
    expect(await addCustomOption('builds', 'MUSCULAR', BUILDS)).toEqual({ term: 'Muscular', added: false });
    expect(await addCustomOption('builds', 'slim', BUILDS)).toEqual({ term: 'Slim', added: false });
    // Two stewards adding the same word at once.
    await Promise.all([addCustomOption('reasons', 'Spitting', []), addCustomOption('reasons', 'Spitting', [])]);
    expect(customOptions().builds).toEqual(['Muscular']);
    expect(customOptions().reasons.filter((r) => r === 'Spitting')).toHaveLength(1);
  });

  it('adds what the AI reads that is not on the list', async () => {
    bot.ai = {
      handle: async () => ({ kind: 'answer', text: 'x' }),
      describe: async () => ({ gender: 'Male', height: 'Tall', build: 'Athletic', age: 'Adult', clothing: 'red top' }),
    };
    await bot.handle(msg('dave', 'REFUSED 1 A 1 West 1'));
    const [a] = await bot.handle(msg('dave', 'tall athletic lad, red top'));
    expect(a.text).toContain('👤 Male · Tall · Athletic · Adult · red top');
    expect((await bot.handle(msg('dave', 'OPTIONS')))[0].text).toContain('Athletic');
  });
});
