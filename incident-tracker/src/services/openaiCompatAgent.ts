import { formatClock } from './format';
import {
  AiBudget,
  DESCRIBE_SYSTEM,
  DESCRIBE_TOOL,
  SYSTEM,
  TOOLS,
  adviceSystem,
  contextLine,
  runReadTool,
  toDescription,
  toDraft,
  type AiContext,
  type AiHelper,
  type AiResult,
  type DescriptionFields,
} from './aiAgent';

/**
 * The AI helper on any OpenAI-compatible chat API: Groq by default (free tier, ~1,000 requests a
 * day for the tool-using models, plus free Whisper speech-to-text), or OpenRouter, Mistral, a
 * llama.cpp server on the phone, ... via AI_BASE_URL. Same rules as the other providers:
 * read-only tools, drafts that need YES, no photos / steward names / ticket codes sent.
 */

export const DEFAULT_COMPAT_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_COMPAT_MODEL = 'openai/gpt-oss-20b';
const TRANSCRIBE_MODEL = 'whisper-large-v3-turbo';

const NOT_AVAILABLE = '🤖 The AI helper isn’t available right now. Use the commands (send HELP).';
const BUSY = '🤖 The AI helper is busy or out of free requests for now. Use the commands (send HELP) and try later.';
const BAD_KEY = '🤖 The AI helper isn’t set up correctly. Ask the organiser to check the API key.';
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type FunctionTool = { type: 'function'; function: { name: string; description?: string; parameters: unknown } };
type RunResult = { text: string } | { call: { name: string; input: Record<string, unknown> } } | { error: string };

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const asTools = (tools: typeof TOOLS): FunctionTool[] =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
const LOG_TOOLS = asTools(TOOLS);
const DESCRIBE_TOOLS = asTools([DESCRIBE_TOOL]);

export class OpenAiCompatAgent implements AiHelper {
  private budget: AiBudget;

  constructor(
    private readonly apiKey: string,
    readonly model = DEFAULT_COMPAT_MODEL,
    readonly baseUrl = DEFAULT_COMPAT_BASE_URL,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retryDelayMs = 1500,
  ) {
    this.budget = new AiBudget(now);
  }

  async handle(text: string, senderId: string, ctx?: AiContext): Promise<AiResult> {
    const limited = this.budget.allow(senderId);
    if (limited) return { kind: 'error', text: limited };
    return this.toLogResult(await this.run(SYSTEM, `${contextLine(ctx)}${text.slice(0, 1500)}`, LOG_TOOLS, ['draft_log']));
  }

  /** Voice note: speech-to-text first (Whisper), then the same as a typed message. */
  async handleAudio(audio: Buffer, mime: string, senderId: string): Promise<AiResult> {
    if (audio.length > MAX_AUDIO_BYTES) return { kind: 'error', text: '🤖 That voice note is too long. Keep it under a minute, or type it.' };
    const limited = this.budget.allow(senderId);
    if (limited) return { kind: 'error', text: limited };
    let heard: string;
    try {
      const form = new FormData();
      const type = mime.split(';')[0].trim() || 'audio/ogg';
      form.append('file', new Blob([new Uint8Array(audio)], { type }), 'voice.ogg');
      form.append('model', TRANSCRIBE_MODEL);
      form.append('language', 'en');
      const res = await this.post('/audio/transcriptions', form);
      heard = String((res as { text?: unknown }).text ?? '').trim();
    } catch (err) {
      return { kind: 'error', text: this.explain(err) };
    }
    if (!heard) return { kind: 'error', text: '🎙️ I couldn’t make out any words. Try again, or type it.' };
    const result = this.toLogResult(await this.run(SYSTEM, heard.slice(0, 1500), LOG_TOOLS, ['draft_log']));
    return result.kind === 'error' ? result : { ...result, heard };
  }

  async describe(text: string, senderId: string): Promise<DescriptionFields | null> {
    if (this.budget.allow(senderId)) return null;
    const r = await this.run(DESCRIBE_SYSTEM, text.slice(0, 600), DESCRIBE_TOOLS, ['set_description']);
    return 'call' in r ? toDescription(r.call.input) : null;
  }

  async advise(situation: string, policy: string, senderId: string): Promise<AiResult> {
    const limited = this.budget.allow(senderId);
    if (limited) return { kind: 'error', text: limited };
    const r = await this.run(adviceSystem(policy), situation.slice(0, 1000), [], []);
    if ('error' in r) return { kind: 'error', text: r.error };
    if ('text' in r && r.text) return { kind: 'answer', text: r.text };
    return { kind: 'error', text: NOT_AVAILABLE };
  }

  private toLogResult(r: RunResult): AiResult {
    if ('error' in r) return { kind: 'error', text: r.error };
    if ('call' in r) {
      const draft = toDraft(r.call.input);
      return draft ? { kind: 'draft', draft } : { kind: 'error', text: '🤖 Sorry, I couldn’t work that out. Try the commands (send HELP).' };
    }
    return { kind: 'answer', text: r.text || '🤖 Sorry, I couldn’t work that out. Try the commands (send HELP).' };
  }

  /** POST with a retry on brief outages (5xx). */
  private async post(path: string, body: unknown): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const isForm = body instanceof FormData;
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, ...(isForm ? {} : { 'content-type': 'application/json' }) },
        body: isForm ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (res.ok) return json;
      if (res.status >= 500 && attempt < 3) {
        console.warn(`[ai] ${this.model} busy (${res.status}), retrying (${attempt}/2)`);
        await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
        continue;
      }
      throw new HttpError(res.status, json.error?.message ?? `HTTP ${res.status}`);
    }
  }

  private explain(err: unknown): string {
    if (err instanceof HttpError) {
      if (err.status === 429 || err.status >= 500) return BUSY;
      if (err.status === 401 || err.status === 403) {
        console.error(`[ai] the AI service rejected the key (${err.status}): ${err.message}`);
        return BAD_KEY;
      }
      console.error(`[ai] AI request failed (${err.status}): ${err.message}`);
    } else {
      console.error('[ai] AI request failed:', (err as Error).message);
    }
    return NOT_AVAILABLE;
  }

  /** The tool loop: read-only tools run here; a tool in `stopOn` ends the exchange. */
  private async run(system: string, text: string, tools: FunctionTool[], stopOn: string[]): Promise<RunResult> {
    const now = new Date(this.now());
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: `[Time now: ${formatClock(now)}]\n${text}` },
    ];
    let inTokens = 0;
    let outTokens = 0;
    try {
      for (let turn = 0; turn < 5; turn++) {
        const res = (await this.post('/chat/completions', {
          model: this.model,
          messages,
          ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
          max_tokens: 2048,
          temperature: 0.2,
        })) as {
          choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        inTokens += res.usage?.prompt_tokens ?? 0;
        outTokens += res.usage?.completion_tokens ?? 0;
        const msg = res.choices?.[0]?.message;
        if (!msg) return { error: NOT_AVAILABLE };
        const calls = msg.tool_calls ?? [];
        if (!calls.length) return { text: (msg.content ?? '').trim() };

        const parsed = calls.map((c) => {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(c.function.arguments || '{}');
          } catch {
            /* treated as empty: the tool reports what's missing */
          }
          return { id: c.id, name: c.function.name, input };
        });
        const stop = parsed.find((c) => stopOn.includes(c.name));
        if (stop) return { call: { name: stop.name, input: stop.input } };

        messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
        for (const c of parsed) {
          const { content } = await runReadTool(c.name, c.input, now);
          messages.push({ role: 'tool', tool_call_id: c.id, content });
        }
      }
      return { error: '🤖 That took too many steps. Try a simpler question, or the commands (send HELP).' };
    } catch (err) {
      return { error: this.explain(err) };
    } finally {
      if (inTokens || outTokens) console.log(`[ai] ${this.model}: ${inTokens} input + ${outTokens} output tokens`);
    }
  }
}
