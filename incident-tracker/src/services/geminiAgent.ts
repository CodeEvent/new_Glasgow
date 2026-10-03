import { ApiError, GoogleGenAI, type Content, type FunctionDeclaration, type Part } from '@google/genai';
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
 * The same AI helper as AiAgent (questions + drafts, read-only tools, YES before saving),
 * on Google Gemini's free tier, plus voice notes. Note: on the free tier Google may use
 * requests to improve its products, so only the steward's words (or voice) and matching
 * record text are ever sent; never ticket or customer photos.
 */

// Flash-Lite: the free tier allows many more requests a day than Flash (which allowed only 20).
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-lite-latest';

const declare = (tools: typeof TOOLS): FunctionDeclaration[] =>
  tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema }));
const LOG_TOOLS = declare(TOOLS);
const DESCRIBE_TOOLS = declare([DESCRIBE_TOOL]);

const NOT_AVAILABLE = '🤖 The AI helper isn’t available right now. Use the commands (send HELP).';
const MAX_AUDIO_BYTES = 3 * 1024 * 1024; // ~3 min of WhatsApp voice

type RunResult = { text: string } | { call: { name: string; input: Record<string, unknown> } } | { error: string };

export class GeminiAgent implements AiHelper {
  private client: Pick<GoogleGenAI, 'models'>;
  private budget: AiBudget;

  constructor(
    apiKey: string,
    readonly model = DEFAULT_GEMINI_MODEL,
    private readonly now: () => number = Date.now,
    client?: Pick<GoogleGenAI, 'models'>,
    private readonly retryDelayMs = 1500,
  ) {
    this.client = client ?? new GoogleGenAI({ apiKey });
    this.budget = new AiBudget(now);
  }

  async handle(text: string, senderId: string, ctx?: AiContext): Promise<AiResult> {
    const limited = this.budget.allow(senderId);
    if (limited) return { kind: 'error', text: limited };
    return this.toLogResult(await this.run(SYSTEM, [{ text: `${contextLine(ctx)}${text.slice(0, 1500)}` }], LOG_TOOLS, ['draft_log']));
  }

  /** A steward's voice note: what they say is treated like their typed message. */
  async handleAudio(audio: Buffer, mime: string, senderId: string): Promise<AiResult> {
    if (audio.length > MAX_AUDIO_BYTES) return { kind: 'error', text: '🤖 That voice note is too long. Keep it under a minute, or type it.' };
    const limited = this.budget.allow(senderId);
    if (limited) return { kind: 'error', text: limited };
    const parts: Part[] = [
      { text: 'This is a voice note from a steward. Treat what they say as their message (a question, or a report to draft).' },
      { inlineData: { mimeType: mime.split(';')[0].trim() || 'audio/ogg', data: audio.toString('base64') } },
    ];
    return this.toLogResult(await this.run(SYSTEM, parts, LOG_TOOLS, ['draft_log']));
  }

  async describe(text: string, senderId: string): Promise<DescriptionFields | null> {
    if (this.budget.allow(senderId)) return null;
    const r = await this.run(DESCRIBE_SYSTEM, [{ text: text.slice(0, 600) }], DESCRIBE_TOOLS, ['set_description']);
    return 'call' in r ? toDescription(r.call.input) : null;
  }

  async advise(situation: string, policy: string, senderId: string): Promise<AiResult> {
    const limited = this.budget.allow(senderId);
    if (limited) return { kind: 'error', text: limited };
    const r = await this.run(adviceSystem(policy), [{ text: situation.slice(0, 1000) }], [], []);
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

  /** Gemini is sometimes briefly overloaded (5xx): try up to 3 times, waiting a little longer each time. */
  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        if (!(err instanceof ApiError) || err.status < 500 || attempt >= 3) throw err;
        console.warn(`[ai] Gemini busy (${err.status}), retrying (${attempt}/2)`);
        await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
      }
    }
  }

  /** The tool loop: read-only tools run here; a tool in `stopOn` ends the exchange. */
  private async run(system: string, parts: Part[], tools: FunctionDeclaration[], stopOn: string[]): Promise<RunResult> {
    const now = new Date(this.now());
    const contents: Content[] = [{ role: 'user', parts: [{ text: `[Time now: ${formatClock(now)}]` }, ...parts] }];
    let inTokens = 0;
    let outTokens = 0;
    try {
      for (let turn = 0; turn < 5; turn++) {
        const res = await this.withRetry(() =>
          this.client.models.generateContent({
            model: this.model,
            contents,
            config: { systemInstruction: system, ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}), maxOutputTokens: 2048 },
          }),
        );
        inTokens += res.usageMetadata?.promptTokenCount ?? 0;
        outTokens += res.usageMetadata?.candidatesTokenCount ?? 0;

        const reply = res.candidates?.[0]?.content;
        if (!reply) return { error: '🤖 I can’t help with that one. Use the commands instead (send HELP).' }; // blocked
        const calls = res.functionCalls ?? [];
        if (!calls.length) return { text: (res.text ?? '').trim() };
        const stop = calls.find((c) => c.name && stopOn.includes(c.name));
        if (stop) return { call: { name: stop.name!, input: stop.args ?? {} } };

        contents.push(reply);
        const responses: Part[] = [];
        for (const c of calls) {
          const { content } = await runReadTool(c.name ?? '', c.args ?? {}, now);
          responses.push({ functionResponse: { id: c.id, name: c.name, response: { result: content } } });
        }
        contents.push({ role: 'user', parts: responses });
      }
      return { error: '🤖 That took too many steps. Try a simpler question, or the commands (send HELP).' };
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429 || err.status >= 500) return { error: '🤖 The AI helper is busy or out of free requests for now. Use the commands (send HELP) and try later.' };
        if (err.status === 400 || err.status === 401 || err.status === 403) {
          console.error(`[ai] Gemini rejected the request (${err.status}): ${err.message}`);
          return { error: '🤖 The AI helper isn’t set up correctly. Ask the organiser to check the API key.' };
        }
        console.error(`[ai] Gemini error ${err.status}: ${err.message}`);
      } else {
        console.error('[ai] Gemini request failed:', (err as Error).message);
      }
      return { error: NOT_AVAILABLE };
    } finally {
      if (inTokens || outTokens) console.log(`[ai] ${this.model}: ${inTokens} input + ${outTokens} output tokens`);
    }
  }
}
