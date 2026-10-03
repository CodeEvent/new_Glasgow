import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { AiAgent } from '../src/services/aiAgent';
import { StewardBot, type InboundMessage } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

type Reply = { content: unknown[]; stop_reason: string };
/** A scripted stand-in for the API: returns the replies in order and records the requests. */
function fakeClient(script: Reply[]) {
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        create: async (req: Record<string, unknown>) => {
          requests.push(JSON.parse(JSON.stringify(req)));
          const r = script.shift();
          if (!r) throw new Error('script exhausted');
          return { ...r, usage: { input_tokens: 100, output_tokens: 20 } };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}
const text = (t: string): Reply => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
const tool = (name: string, input: unknown, id = 'tu_1'): Reply => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });

describe('AI helper: when it is used', () => {
  const msg = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({ chatId: 'g@g.us', senderId: 'dave', senderName: 'Dave', text, ...extra });

  it('is only asked when addressed in a group, or in a private chat', async () => {
    const asked: string[] = [];
    const bot = new StewardBot();
    bot.ai = { handle: async (t: string) => (asked.push(t), { kind: 'answer', text: 'ok' }) };
    expect(await bot.handle(msg('anyone want a coffee?'))).toEqual([]); // ordinary group chat: never sent anywhere
    expect((await bot.handle(msg('GK how many refused?')))[0].text).toBe('🤖 ok');
    await bot.handle(msg('who is sent away?', { mentionsBot: true }));
    await bot.handle(msg('anyone in a red coat?', { chatId: '447700900111@s.whatsapp.net' }));
    expect(asked).toEqual(['how many refused?', 'who is sent away?', 'anyone in a red coat?']);
    expect((await bot.handle(msg('help')))[0].text).toContain('Ask in plain English');
  });

  it('stays off without a key', async () => {
    const bot = new StewardBot();
    expect(await bot.handle(msg('GK how many refused?'))).toEqual([]);
    expect((await bot.handle(msg('help')))[0].text).not.toContain('plain English');
  });
});

describe.skipIf(!HAS_DB)('AI helper (PostgreSQL)', () => {
  let bot: StewardBot;
  const msg = (senderId: string, text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    chatId: 'g@g.us', senderId, senderName: senderId === 'dave' ? 'Dave' : 'Sarah', text, at: new Date(), ...extra,
  });
  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    bot = new StewardBot();
  });
  afterEach(() => {
    delete process.env.AI_DAILY_LIMIT;
    resetConfigCache();
  });
  afterAll(async () => {
    await closePool();
  });

  it('answers questions from the records, without steward names or ticket codes', async () => {
    await bot.handle(msg('dave', '30 234 O 9 East 2 F 1 1 adult red coat'));
    await bot.handle(msg('dave', 'NOTE 234 O 9 shouting at the gate'));
    const { client, requests } = fakeClient([
      tool('search_records', { text: 'red coat', status: 'sent_away' }),
      text('Yes: *234 O 9*, female, red coat, sent away. Send the seat for full details.'),
    ]);
    bot.ai = new AiAgent('test-key', 'claude-opus-5-5', Date.now, client);
    const [r] = await bot.handle(msg('sarah', 'GK anyone in a red coat sent away?'));
    expect(r.text).toBe('🤖 Yes: *234 O 9*, female, red coat, sent away. Send the seat for full details.');

    expect(requests[0]).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'], output_config: { effort: 'low' } });
    const toolResult = JSON.stringify((requests[1].messages as unknown[]).at(-1));
    expect(toolResult).toContain('234 O 9 · SENT AWAY');
    expect(toolResult).toContain('red coat');
    expect(toolResult).toContain('shouting at the gate');
    expect(toolResult).not.toContain('Dave'); // no steward names
    expect(toolResult).not.toContain('SEAT-234'); // no ticket codes
  });

  it('turns a plain-English log into a draft that is saved only after YES', async () => {
    const { client } = fakeClient([
      tool('draft_log', { decision: 'refused', section: '313', row: 'yy', seat: '56', reasons: ['Intoxicated', 'Abusive'], gender: 'Male', clothing: 'green hat' }),
    ]);
    bot.ai = new AiAgent('test-key', 'claude-opus-5-5', Date.now, client);
    const [a] = await bot.handle(msg('dave', 'refused a drunk lad in a green hat, swearing at staff, 313 YY 56'));
    expect(a.text).toContain('🤖 Got it.');
    expect(a.text).toContain('Which hub'); // missing: asked
    const [b] = await bot.handle(msg('dave', '2'));
    expect(b.text).toContain('*Check this before I save it:*');
    expect(b.text).toContain('🔴 *REFUSED* · 313 YY 56 · West Hub');
    expect(b.text).toContain('📝 Intoxicated, Abusive');
    expect(b.text).toContain('👤 Male · green hat');
    expect((await getPool().query('SELECT count(*)::int AS n FROM tickets')).rows[0].n).toBe(0); // nothing saved yet
    expect((await bot.handle(msg('dave', 'maybe')))[0].text).toContain('Reply *YES*');
    const [c] = await bot.handle(msg('dave', 'yes'));
    expect(c.text).toContain('✅ Logged 🔴 *REFUSED* · 313 YY 56');
    expect((await getPool().query('SELECT count(*)::int AS n FROM tickets')).rows[0].n).toBe(1);
  });

  it('respects the daily limit', async () => {
    process.env.AI_DAILY_LIMIT = '1';
    resetConfigCache();
    const { client } = fakeClient([text('Nothing on record.')]);
    bot.ai = new AiAgent('test-key', 'claude-opus-5-5', Date.now, client);
    expect((await bot.handle(msg('sarah', 'GK anyone?')))[0].text).toBe('🤖 Nothing on record.');
    expect((await bot.handle(msg('sarah', 'GK anyone else?')))[0].text).toContain('today’s limit');
  });

  it('handles a refusal from the model', async () => {
    const { client } = fakeClient([{ content: [], stop_reason: 'refusal' }]);
    bot.ai = new AiAgent('test-key', 'claude-opus-5-5', Date.now, client);
    expect((await bot.handle(msg('sarah', 'GK something odd')))[0].text).toContain('can’t help with that');
  });
});
