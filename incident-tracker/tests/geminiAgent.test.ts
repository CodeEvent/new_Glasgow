import { ApiError, type GoogleGenAI } from '@google/genai';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { createAiAgent } from '../src/services/aiProvider';
import { AiAgent } from '../src/services/aiAgent';
import { GeminiAgent } from '../src/services/geminiAgent';
import { StewardBot, type InboundMessage } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

type Call = { name: string; args: Record<string, unknown>; id?: string };
type Reply = { calls?: Call[]; text?: string; blocked?: boolean } | Error;
/** A scripted stand-in for Gemini: replies in order and records each request. */
function fakeGemini(script: Reply[]) {
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    models: {
      generateContent: async (req: Record<string, unknown>) => {
        requests.push(JSON.parse(JSON.stringify(req)));
        const r = script.shift();
        if (!r) throw new Error('script exhausted');
        if (r instanceof Error) throw r;
        if (r.blocked) return { candidates: [], promptFeedback: { blockReason: 'SAFETY' }, functionCalls: undefined, text: undefined };
        const parts = r.calls ? r.calls.map((c) => ({ functionCall: c })) : [{ text: r.text }];
        return {
          candidates: [{ content: { role: 'model', parts } }],
          functionCalls: r.calls,
          text: r.text,
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
        };
      },
    },
  } as unknown as GoogleGenAI;
  return { client, requests };
}

describe('choosing the AI', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['AI_PROVIDER', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'AI_MODEL']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigCache();
  });
  const pick = (env: Record<string, string>) => {
    for (const k of ['AI_PROVIDER', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'AI_MODEL']) delete process.env[k];
    Object.assign(process.env, env);
    resetConfigCache();
    return createAiAgent();
  };

  it('is off without a key', () => {
    expect(pick({})).toBeUndefined();
  });
  it('uses Gemini when its key is set, Claude when only Claude’s is', () => {
    expect(pick({ GEMINI_API_KEY: 'g' })).toBeInstanceOf(GeminiAgent);
    expect(pick({ ANTHROPIC_API_KEY: 'a' })).toBeInstanceOf(AiAgent);
    expect(pick({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' })).toBeInstanceOf(GeminiAgent); // the free one wins
  });
  it('follows AI_PROVIDER when set', () => {
    expect(pick({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', AI_PROVIDER: 'claude' })).toBeInstanceOf(AiAgent);
    expect(pick({ ANTHROPIC_API_KEY: 'a', AI_PROVIDER: 'gemini' })).toBeUndefined(); // asked for Gemini, no key
  });
  it('uses the model for the chosen provider', () => {
    expect((pick({ GEMINI_API_KEY: 'g' }) as GeminiAgent).model).toBe('gemini-flash-lite-latest'); // the free tier allows far more requests than Flash
    expect((pick({ GEMINI_API_KEY: 'g', AI_MODEL: 'gemini-2.5-flash' }) as GeminiAgent).model).toBe('gemini-2.5-flash');
  });
});

describe.skipIf(!HAS_DB)('Gemini helper (PostgreSQL)', () => {
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

  it('answers questions from the records, without steward names or ticket codes', async () => {
    await bot.handle(msg('dave', '30 234 O 9 East 2 F 1 1 adult red coat'));
    const { client, requests } = fakeGemini([
      { calls: [{ name: 'search_records', args: { text: 'red coat' }, id: 'c1' }] },
      { text: 'Yes: *234 O 9*, red coat, sent away. Send the seat for full details.' },
    ]);
    bot.ai = new GeminiAgent('k', 'gemini-flash-latest', Date.now, client);
    const [r] = await bot.handle(msg('sarah', 'GK anyone in a red coat?'));
    expect(r.text).toBe('🤖 Yes: *234 O 9*, red coat, sent away. Send the seat for full details.');

    const config = requests[0].config as { systemInstruction: string; tools: Array<{ functionDeclarations: Array<{ name: string }> }> };
    expect(config.systemInstruction).toContain('Gatekeeper');
    expect(config.tools[0].functionDeclarations.map((f) => f.name)).toEqual(['search_records', 'get_stats', 'draft_log']);
    const sent = JSON.stringify(requests[1].contents);
    expect(sent).toContain('functionResponse');
    expect(sent).toContain('234 O 9 · SENT AWAY');
    expect(sent).not.toContain('Dave');
    expect(sent).not.toContain('SEAT-234');
  });

  it('turns a plain-English log into a draft saved only after YES', async () => {
    const { client } = fakeGemini([
      { calls: [{ name: 'draft_log', args: { decision: 'refused', section: '313', row: 'yy', seat: '56', hub: 'West Hub', reasons: ['Intoxicated'] } }] },
    ]);
    bot.ai = new GeminiAgent('k', 'gemini-flash-latest', Date.now, client);
    const [a] = await bot.handle(msg('dave', 'GK refused a drunk lad 313 YY 56 at West'));
    expect(a.text).toContain('*Check this before I save it:*');
    expect(a.text).toContain('🔴 *REFUSED* · 313 YY 56 · West Hub');
    expect((await getPool().query('SELECT count(*)::int AS n FROM tickets')).rows[0].n).toBe(0);
    expect((await bot.handle(msg('dave', 'YES')))[0].text).toContain('✅ Logged 🔴 *REFUSED* · 313 YY 56');
  });

  it('retries when Gemini is briefly overloaded', async () => {
    const overloaded = () => new ApiError({ message: 'high demand', status: 503 });
    const { client, requests } = fakeGemini([overloaded(), overloaded(), { text: 'All quiet tonight.' }]);
    bot.ai = new GeminiAgent('k', 'gemini-flash-latest', Date.now, client, 1);
    expect((await bot.handle(msg('sarah', 'GK anything?')))[0].text).toBe('🤖 All quiet tonight.');
    expect(requests).toHaveLength(3);
    const { client: c2 } = fakeGemini([overloaded(), overloaded(), overloaded()]);
    bot.ai = new GeminiAgent('k', 'gemini-flash-latest', Date.now, c2, 1);
    expect((await bot.handle(msg('sarah', 'GK anything?')))[0].text).toContain('busy');
  });

  it('explains errors in plain words', async () => {
    const busy = new ApiError({ message: 'quota', status: 429 });
    const badKey = new ApiError({ message: 'API key not valid', status: 400 });
    const { client } = fakeGemini([busy, badKey, { blocked: true }]);
    bot.ai = new GeminiAgent('k', 'gemini-flash-latest', Date.now, client);
    expect((await bot.handle(msg('sarah', 'GK one')))[0].text).toContain('busy or out of free requests');
    expect((await bot.handle(msg('sarah', 'GK two')))[0].text).toContain('check the API key');
    expect((await bot.handle(msg('sarah', 'GK three')))[0].text).toContain('can’t help with that');
  });
});
