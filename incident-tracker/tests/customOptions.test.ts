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

  it('accepts a new reason quietly and recognises it next time, without adding it to the list', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West'));
    const [a] = await bot.handle(msg('dave', 'trespassing'));
    expect(a.text).not.toContain('Added');
    expect(a.text).toContain('Male or female?');
    for (let i = 0; i < 5; i++) await bot.handle(msg('dave', '-'));
    expect((await ticket('56')).reasoning).toBe('Trespassing');

    const [b] = await bot.handle(msg('sarah', 'REFUSED 313 YY 57 West'));
    expect(b.text).not.toContain('Trespassing'); // the visible list stays 1-6
    expect(b.text).not.toContain('*7*');
    expect((await bot.handle(msg('sarah', '7')))[0].text).toContain('Reason?'); // 7 isn't an option
    await bot.handle(msg('sarah', '1 trespassing -')); // the learnt word is recognised
    expect((await ticket('57')).reasoning).toBe('Intoxicated, Trespassing');
  });

  it('never stores duplicates, and maps words that mean an existing option', async () => {
    await bot.handle(msg('dave', 'REFUSED 1 A 1 West'));
    await bot.handle(msg('dave', 'trespassing'));
    await bot.handle(msg('dave', 'CANCEL'));
    await bot.handle(msg('dave', 'REFUSED 1 A 2 West'));
    await bot.handle(msg('dave', '  TRESPASSING '));
    await bot.handle(msg('dave', 'CANCEL'));
    await bot.handle(msg('dave', 'REFUSED 1 A 3 West'));
    await bot.handle(msg('dave', 'drunk')); // = Intoxicated
    const [o] = await bot.handle(msg('dave', 'OPTIONS'));
    expect(o.text.match(/Trespassing/g)).toHaveLength(1);
    expect(o.text).not.toMatch(/Drunk/i);
  });

  it('learns new heights and builds quietly, maps synonyms', async () => {
    await bot.handle(msg('dave', 'REFUSED 1 A 1 West 1'));
    await bot.handle(msg('dave', 'M'));
    expect((await bot.handle(msg('dave', 'very short')))[0].text).toContain('Build?'); // = Short
    const [b] = await bot.handle(msg('dave', 'muscular'));
    expect(b.text).not.toContain('Added');
    expect(b.text).toContain('Minor or adult?');
    await bot.handle(msg('dave', '1'));
    await bot.handle(msg('dave', '-'));
    expect((await ticket('1')).description).toBe('Male · Short · Muscular · Adult');
    await bot.handle(msg('sarah', 'REFUSED 1 A 2 West 1'));
    await bot.handle(msg('sarah', 'F'));
    const [h] = await bot.handle(msg('sarah', '2'));
    expect(h.text).not.toContain('Muscular'); // not shown as an option
    await bot.handle(msg('sarah', 'MUSCULAR'));
    await bot.handle(msg('sarah', '1'));
    await bot.handle(msg('sarah', '-'));
    expect((await ticket('2')).description).toBe('Female · Average height · Muscular · Adult');
    // ...and recognised inside a one-line answer too.
    await bot.handle(msg('sarah', 'REFUSED 1 A 3 West 1'));
    await bot.handle(msg('sarah', 'F tall muscular adult -'));
    expect((await ticket('3')).description).toBe('Female · Tall · Muscular · Adult');
  });

  it('does not add long or rambling answers', async () => {
    await bot.handle(msg('dave', 'REFUSED 1 A 1 West'));
    const [a] = await bot.handle(msg('dave', 'he was really very rude to the stewards and the police at the gate'));
    expect(a.text).toContain('Reason?'); // asked again
    expect((await bot.handle(msg('dave', 'OPTIONS')))[0].text).toContain('No learnt words yet');
  });

  it('keeps new options across restarts, and admins can remove them', async () => {
    await bot.handle(msg('dave', 'REFUSED 1 A 1 West'));
    await bot.handle(msg('dave', 'trespassing'));
    const fresh = new StewardBot();
    fresh.canSupervise = async (id) => id === 'sarah';
    expect((await fresh.handle(msg('dave', 'OPTIONS')))[0].text).toContain('Trespassing');
    expect((await fresh.handle(msg('dave', 'OPTIONS REMOVE Trespassing')))[0].text).toContain('⛔ Only group admins');
    expect((await fresh.handle(msg('sarah', 'OPTIONS REMOVE trespassing')))[0].text).toContain('Forgot *Trespassing*');
    expect((await fresh.handle(msg('sarah', 'OPTIONS')))[0].text).toContain('No learnt words yet');
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
    expect(a.text).not.toContain('Added');
    expect((await bot.handle(msg('dave', 'OPTIONS')))[0].text).toContain('Athletic');
  });
});
