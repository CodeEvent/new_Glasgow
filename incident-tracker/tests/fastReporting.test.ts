import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool';
import type { AiHelper, AiResult } from '../src/services/aiAgent';
import { StewardBot, type InboundMessage } from '../src/services/stewardBot';
import type { SeatRef } from '../src/services/ticketOcr';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const GROUP = 'g@g.us';
const DM = '447700900111@s.whatsapp.net';

/** A scripted AI helper that records how it was called. */
function fakeAi(over: Partial<AiHelper> = {}) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record = <T>(fn: string, value: T) => async (...args: unknown[]) => (calls.push({ fn, args }), value);
  const ai: AiHelper = {
    handle: record<AiResult>('handle', { kind: 'answer', text: 'ok' }),
    describe: record('describe', null),
    advise: record<AiResult>('advise', { kind: 'answer', text: 'Suggestion: 30-minute cool-off.' }),
    handleAudio: record<AiResult>('handleAudio', { kind: 'answer', text: 'heard you' }),
    ...over,
  };
  for (const k of Object.keys(over) as (keyof AiHelper)[]) {
    const f = over[k] as (...a: unknown[]) => Promise<unknown>;
    (ai as unknown as Record<string, unknown>)[k] = async (...args: unknown[]) => (calls.push({ fn: k, args }), f(...args));
  }
  return { ai, calls };
}

describe.skipIf(!HAS_DB)('faster reporting (PostgreSQL)', () => {
  let bot: StewardBot;
  let ocrSeats: SeatRef[] = [];
  const photo = Buffer.from('fake-image');
  const msg = (senderId: string, text: string | null, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    chatId: GROUP, senderId, senderName: senderId === 'dave' ? 'Dave' : 'Sarah', text, at: new Date(), ...extra,
  });
  const tickets = async () => (await getPool().query('SELECT section, row_label, seat_number, reasoning, description, (SELECT hub_location FROM scan_events e WHERE e.ticket_id = t.ticket_id LIMIT 1) AS hub FROM tickets t ORDER BY seat_number')).rows;

  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    await getPool().query("DELETE FROM app_settings WHERE key = 'refusal_policy'");
    bot = new StewardBot();
    ocrSeats = [];
    bot.ocr = async () => ocrSeats;
  });
  afterAll(async () => {
    await closePool();
  });

  describe('HUB per shift', () => {
    it('sets the hub once, skips the hub question, and can be cleared', async () => {
      expect((await bot.handle(msg('dave', 'HUB WEST')))[0].text).toContain('Your hub is *West Hub* for this shift');
      expect((await bot.handle(msg('dave', 'hub')))[0].text).toContain('West Hub');
      const [r] = await bot.handle(msg('dave', 'REFUSED 313 YY 56 1 -'));
      expect(r.text).toContain('✅ Logged 🔴 *REFUSED* · 313 YY 56');
      expect((await tickets())[0].hub).toBe('West Hub');
      // A hub in the message still wins.
      await bot.handle(msg('dave', 'REFUSED 313 YY 57 South 1 -'));
      expect((await tickets())[1].hub).toBe('South Hub');
      expect((await bot.handle(msg('dave', 'HUB OFF')))[0].text).toContain('cleared');
      expect((await bot.handle(msg('dave', 'REFUSED 313 YY 58 1 -')))[0].text).toContain('Which hub');
    });

    it('explains bad hub names', async () => {
      expect((await bot.handle(msg('dave', 'HUB NORTH')))[0].text).toContain('East, West, South or Hospitality');
    });
  });

  describe('description questions with the AI on', () => {
    it('asks male/female, height, build, minor/adult and clothing one at a time (no "describe them")', async () => {
      const { ai, calls } = fakeAi();
      bot.ai = ai;
      const steps: Array<[string, string]> = [
        ['REFUSED 313 YY 56 West 1 2', 'Male or female?'],
        ['M', 'Height?'],
        ['3', 'Build?'],
        ['2', 'Minor or adult?'],
        ['1', 'What are they wearing?'],
        ['green hat, black jacket', '✅ Logged'],
      ];
      for (const [say, expected] of steps) {
        const [r] = await bot.handle(msg('dave', say));
        expect(r.text).toContain(expected);
        expect(r.text).not.toContain('Describe them');
      }
      expect((await tickets())[0].description).toBe('Male · Tall · Average build · Adult · green hat, black jacket');
      expect(calls.filter((c) => c.fn === 'describe')).toHaveLength(0);
    });

    it('a sentence at "Male or female?" is read by the AI, then only what’s missing is asked', async () => {
      const { ai, calls } = fakeAi({ describe: async () => ({ gender: 'Male', height: 'Tall', build: 'Heavy', age: 'Adult' }) });
      bot.ai = ai;
      expect((await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1')))[0].text).toContain('Male or female?');
      const [b] = await bot.handle(msg('dave', 'tall heavy lad about 20'));
      expect(b.text).toContain('What are they wearing?');
      expect((await bot.handle(msg('dave', 'green hat')))[0].text).toContain('👤 Male · Tall · Heavy · Adult · green hat');
      expect(calls.filter((c) => c.fn === 'describe')).toHaveLength(1);
    });

    it('needs no AI for "-" or for the short codes', async () => {
      const { ai, calls } = fakeAi();
      bot.ai = ai;
      await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1'));
      expect((await bot.handle(msg('dave', '-')))[0].text).toContain('Height?'); // skips just that question
      await bot.handle(msg('dave', 'CANCEL'));
      await bot.handle(msg('dave', 'REFUSED 313 YY 57 West 1'));
      expect((await bot.handle(msg('dave', 'M 3 2 adult green hat')))[0].text).toContain('👤 Male · Tall · Average build · Adult · green hat');
      expect(calls.filter((c) => c.fn === 'describe')).toHaveLength(0);
    });

    it('asks again if the AI can’t read it', async () => {
      const { ai } = fakeAi({ describe: async () => null });
      bot.ai = ai;
      await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1'));
      expect((await bot.handle(msg('dave', 'some words')))[0].text).toContain('Male or female?');
    });
  });

  describe('ticket photo + a few words', () => {
    it('reads the seat on the phone and the words with the AI, then confirms', async () => {
      ocrSeats = [{ section: '313', row: 'YY', seat: '56' }];
      const { ai, calls } = fakeAi({
        handle: async () => ({ kind: 'draft', draft: { ejected: false, hub: 'West Hub', reasons: ['Intoxicated', 'Abusive'], gender: 'Male', height: 'Tall', clothing: 'green hat' } }),
      });
      bot.ai = ai;
      const [a] = await bot.handle(msg('dave', 'drunk, swearing, tall lad green hat, West', { image: { data: photo, mime: 'image/jpeg' } }));
      expect(a.text).toContain('🎫 Seat from the ticket: *313 YY 56*');
      expect(a.text).toContain('Refused entry, sent away for 30 minutes, or ejected?'); // the words didn't say
      const sent = calls.find((c) => c.fn === 'handle')!;
      expect(sent.args[0]).toContain('drunk, swearing, tall lad green hat, West');
      expect(JSON.stringify(sent.args)).not.toContain('fake-image'); // the photo never goes to the AI
      const [b] = await bot.handle(msg('dave', '1'));
      expect(b.text).toContain('*Check this before I save it:*');
      expect(b.text).toContain('🔴 *REFUSED* · 313 YY 56 · West Hub');
      expect(b.text).toContain('📝 Intoxicated, Abusive');
      expect((await bot.handle(msg('dave', 'yes')))[0].text).toContain('✅ Logged');
    });

    it('keeps ordinary photos private', async () => {
      const { ai, calls } = fakeAi();
      bot.ai = ai;
      expect(await bot.handle(msg('dave', 'lol', { image: { data: photo, mime: 'image/jpeg' } }))).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  describe('voice notes', () => {
    it('turns a voice note in a private chat into a draft', async () => {
      const { ai, calls } = fakeAi({
        handleAudio: async () => ({ kind: 'draft', draft: { decision: 'cool_off', ejected: false, section: '101', row: 'A', seat: '4', hub: 'East Hub', reasons: ['Intoxicated'] } }),
      });
      bot.ai = ai;
      const [a] = await bot.handle(msg('dave', null, { chatId: DM, audio: { data: Buffer.from('ogg'), mime: 'audio/ogg; codecs=opus' } }));
      expect(a.text).toContain('🟠 *SENT AWAY 30 MIN* · 101 A 4 · East Hub');
      expect(calls[0].fn).toBe('handleAudio');
      expect((await bot.handle(msg('dave', 'YES', { chatId: DM })))[0].text).toContain('✅ Logged 🟠');
    });

    it('ignores voice notes in the group', async () => {
      const { ai, calls } = fakeAi();
      bot.ai = ai;
      expect(await bot.handle(msg('dave', null, { audio: { data: Buffer.from('ogg'), mime: 'audio/ogg' } }))).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('says when the AI in use can’t listen', async () => {
      const { ai } = fakeAi();
      delete (ai as Partial<AiHelper>).handleAudio;
      bot.ai = ai;
      const [a] = await bot.handle(msg('dave', null, { chatId: DM, audio: { data: Buffer.from('ogg'), mime: 'audio/ogg' } }));
      expect(a.text).toContain('Voice notes need the Gemini AI');
    });
  });

  describe('policy advice', () => {
    it('needs a policy, set by a group admin', async () => {
      const { ai } = fakeAi();
      bot.ai = ai;
      bot.canSupervise = async (id) => id === 'sarah';
      expect((await bot.handle(msg('dave', 'ADVICE slurring, unsteady, polite')))[0].text).toContain('No refusal policy set yet');
      expect((await bot.handle(msg('dave', 'POLICY refuse if aggressive')))[0].text).toContain('⛔ Only group admins');
      expect((await bot.handle(msg('sarah', 'POLICY Refuse if aggressive, can’t stand, or under 18. 30 minutes if mildly drunk and calm.')))[0].text).toContain('✅ Policy saved');
      expect((await bot.handle(msg('dave', 'POLICY')))[0].text).toContain('30 minutes if mildly drunk and calm');
    });

    it('suggests from the policy, and the steward decides', async () => {
      const { ai, calls } = fakeAi();
      bot.ai = ai;
      bot.canSupervise = async () => true;
      await bot.handle(msg('sarah', 'POLICY 30 minutes if mildly drunk and calm.'));
      const [a] = await bot.handle(msg('dave', 'ADVICE slurring, unsteady, polite'));
      expect(a.text).toContain('Suggestion: 30-minute cool-off.');
      expect(a.text).toContain('You decide');
      expect(calls.find((c) => c.fn === 'advise')!.args.slice(0, 2)).toEqual(['slurring, unsteady, polite', '30 minutes if mildly drunk and calm.']);
      await bot.handle(msg('dave', 'GK advice: shouting at staff'));
      expect(calls.filter((c) => c.fn === 'advise')).toHaveLength(2);
    });

    it('never lets the AI choose refused or sent away when the steward didn’t say', async () => {
      const guess = { kind: 'draft' as const, draft: { decision: 'refused' as const, ejected: false, section: '234', row: 'O', seat: '9', hub: 'West Hub' as const, reasons: ['Intoxicated' as const] } };
      const { ai } = fakeAi({ handle: async () => guess });
      bot.ai = ai;
      const [a] = await bot.handle(msg('dave', 'GK a bit drunk but calm and polite, 234 O 9 West'));
      expect(a.text).toContain('Refused entry, sent away for 30 minutes, or ejected?');
      const [b] = await bot.handle(msg('sarah', 'GK refused a drunk lad at 234 O 9 West'));
      expect(b.text).toContain('*Check this before I save it:*'); // they said it: no question
    });

    it('offers the suggestion when a plain-English log doesn’t say refused or sent away', async () => {
      const { ai } = fakeAi({ handle: async () => ({ kind: 'draft', draft: { ejected: false, section: '313', row: 'YY', seat: '56', hub: 'West Hub', reasons: ['Intoxicated'] } }) });
      bot.ai = ai;
      bot.canSupervise = async () => true;
      await bot.handle(msg('sarah', 'POLICY 30 minutes if mildly drunk and calm.'));
      const [a] = await bot.handle(msg('dave', 'GK lad at 313 YY 56 West, a bit drunk but calm'));
      expect(a.text).toContain('🤖 Policy suggests: Suggestion: 30-minute cool-off.');
      expect(a.text).toContain('Refused entry, sent away for 30 minutes, or ejected?');
    });
  });
});
