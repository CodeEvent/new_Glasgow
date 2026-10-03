import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { createAiAgent } from '../src/services/aiProvider';
import { OpenAiCompatAgent } from '../src/services/openaiCompatAgent';
import { StewardBot, type InboundMessage } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

type Reply = { status?: number; body?: unknown };
/** A scripted stand-in for an OpenAI-compatible API (Groq): replies in order, records requests. */
function fakeFetch(script: Reply[]) {
  const requests: Array<{ url: string; body: unknown; auth: string | null }> = [];
  const impl = async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body;
    if (typeof body === 'string') body = JSON.parse(body);
    else if (body instanceof FormData) body = Object.fromEntries([...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${(v as File).name} ${(v as File).size}B>`]));
    requests.push({ url: String(url), body, auth: headers.get('authorization') });
    const r = script.shift();
    if (!r) throw new Error('script exhausted');
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { impl: impl as typeof fetch, requests };
}
const say = (text: string) => ({ body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 100, completion_tokens: 10 } } });
const call = (name: string, args: unknown, id = 'call_1') => ({
  body: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
});

describe('choosing the AI: Groq', () => {
  const keys = ['AI_PROVIDER', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'AI_MODEL', 'AI_BASE_URL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    resetConfigCache();
  });
  const pick = (env: Record<string, string>) => {
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    resetConfigCache();
    return createAiAgent();
  };
  it('uses Groq when its key is set, ahead of Gemini', () => {
    const ai = pick({ GROQ_API_KEY: 'gsk', GEMINI_API_KEY: 'g' });
    expect(ai).toBeInstanceOf(OpenAiCompatAgent);
    expect((ai as OpenAiCompatAgent).model).toBe('openai/gpt-oss-20b');
    expect((ai as OpenAiCompatAgent).baseUrl).toBe('https://api.groq.com/openai/v1');
  });
  it('can point at another compatible service', () => {
    const ai = pick({ GROQ_API_KEY: 'k', AI_BASE_URL: 'https://openrouter.ai/api/v1', AI_MODEL: 'some/model:free' }) as OpenAiCompatAgent;
    expect(ai.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(ai.model).toBe('some/model:free');
  });
  it('AI_PROVIDER can still pick Gemini', () => {
    expect(pick({ GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g', AI_PROVIDER: 'gemini' })).not.toBeInstanceOf(OpenAiCompatAgent);
  });
});

describe.skipIf(!HAS_DB)('Groq helper (PostgreSQL)', () => {
  let bot: StewardBot;
  const msg = (senderId: string, text: string | null, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    chatId: 'g@g.us', senderId, senderName: senderId === 'dave' ? 'Dave' : 'Sarah', text, at: new Date(), ...extra,
  });
  const agent = (script: Reply[]) => {
    const f = fakeFetch(script);
    return { ai: new OpenAiCompatAgent('gsk_test', 'openai/gpt-oss-20b', 'https://api.groq.com/openai/v1', Date.now, f.impl, 1), requests: f.requests };
  };
  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    bot = new StewardBot();
  });
  afterAll(async () => {
    await closePool();
  });

  it('answers questions using the read-only tools, without steward names', async () => {
    await bot.handle(msg('dave', '30 234 O 9 East 2 F 1 1 adult red coat'));
    const { ai, requests } = agent([call('search_records', { text: 'red coat' }), say('Yes: *234 O 9*, red coat, sent away.')]);
    bot.ai = ai;
    expect((await bot.handle(msg('sarah', 'GK anyone in a red coat?')))[0].text).toBe('🤖 Yes: *234 O 9*, red coat, sent away.');
    expect(requests[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(requests[0].auth).toBe('Bearer gsk_test');
    const first = requests[0].body as { model: string; tools: Array<{ function: { name: string } }> };
    expect(first.model).toBe('openai/gpt-oss-20b');
    expect(first.tools.map((t) => t.function.name)).toEqual(['search_records', 'get_stats', 'draft_log']);
    const second = JSON.stringify(requests[1].body);
    expect(second).toContain('"role":"tool"');
    expect(second).toContain('234 O 9 · SENT AWAY');
    expect(second).not.toContain('Dave');
  });

  it('drafts a log that needs YES', async () => {
    const { ai } = agent([call('draft_log', { decision: 'refused', section: '313', row: 'YY', seat: '56', hub: 'West Hub', reasons: ['Intoxicated'] })]);
    bot.ai = ai;
    expect((await bot.handle(msg('dave', 'GK refused a drunk lad 313 YY 56 West')))[0].text).toContain('🔴 *REFUSED* · 313 YY 56 · West Hub');
    expect((await getPool().query('SELECT count(*)::int AS n FROM tickets')).rows[0].n).toBe(0);
    expect((await bot.handle(msg('dave', 'yes')))[0].text).toContain('✅ Logged');
  });

  it('accepts the AI’s own wording for fixed options (no strict lists the service could reject)', async () => {
    const { ai, requests } = agent([
      call('draft_log', { decision: 'sent away', section: '313', row: 'yy', seat: '56', hub: 'west', reasons: ['drunk', 'Abusive', 'swearing'], gender: 'man', height: 'average', build: 'medium', age: 'about 25', clothing: 'green hat' }),
    ]);
    const res = await ai.handle('sent away a drunk lad 313 YY 56 West', 'dave');
    expect(res).toMatchObject({
      kind: 'draft',
      draft: { decision: 'cool_off', hub: 'West Hub', reasons: ['Intoxicated', 'Abusive'], gender: 'Male', height: 'Average height', build: 'Average build', age: 'Adult', clothing: 'green hat' },
    });
    // The tool schema sent to the service has no strict lists for these fields.
    const draftTool = (requests[0].body as { tools: Array<{ function: { name: string; parameters: { properties: Record<string, { enum?: unknown }> } } }> }).tools.find((t) => t.function.name === 'draft_log')!;
    for (const f of ['decision', 'hub', 'gender', 'height', 'build', 'age']) expect(draftTool.function.parameters.properties[f].enum).toBeUndefined();
  });

  it('reads descriptions and gives policy advice', async () => {
    const { ai } = agent([call('set_description', { gender: 'Male', height: 'Tall', build: 'Heavy', age: 'Adult', clothing: 'green hat' }), say('Suggestion: 30-minute cool-off.')]);
    expect(await ai.describe('tall heavy lad, green hat', 'dave')).toEqual({ gender: 'Male', height: 'Tall', build: 'Heavy', age: 'Adult', clothing: 'green hat' });
    expect(await ai.advise('calm, a bit drunk', '30 minutes if calm', 'dave')).toEqual({ kind: 'answer', text: 'Suggestion: 30-minute cool-off.' });
  });

  it('turns a voice note into text first (Whisper), then reads it', async () => {
    const { ai, requests } = agent([{ body: { text: 'Refused, 101 A 4, very drunk, South hub.' } }, call('draft_log', { decision: 'refused', section: '101', row: 'A', seat: '4', hub: 'South Hub', reasons: ['Intoxicated'] })]);
    bot.ai = ai;
    const [a] = await bot.handle(msg('dave', null, { chatId: '447700900111@s.whatsapp.net', audio: { data: Buffer.from('OggS'), mime: 'audio/ogg; codecs=opus' } }));
    expect(a.text).toContain('🎙️ I heard: “Refused, 101 A 4, very drunk, South hub.”');
    expect(a.text).toContain('🔴 *REFUSED* · 101 A 4 · South Hub');
    expect(requests[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(requests[0].body).toMatchObject({ model: 'whisper-large-v3-turbo', file: '<file voice.ogg 4B>' });
  });

  it('explains limits and bad keys, and retries brief outages', async () => {
    const { ai } = agent([{ status: 503 }, say('back')]);
    bot.ai = ai;
    expect((await bot.handle(msg('sarah', 'GK one')))[0].text).toBe('🤖 back');
    const busy = agent([{ status: 429, body: { error: { message: 'Rate limit reached' } } }]);
    bot.ai = busy.ai;
    expect((await bot.handle(msg('sarah', 'GK two')))[0].text).toContain('busy or out of free requests');
    const bad = agent([{ status: 401, body: { error: { message: 'Invalid API Key' } } }]);
    bot.ai = bad.ai;
    expect((await bot.handle(msg('sarah', 'GK three')))[0].text).toContain('check the API key');
  });
});
