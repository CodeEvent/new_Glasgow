import { ApiError, GoogleGenAI, type Content, type FunctionDeclaration } from '@google/genai';
import { formatClock } from './format';
import { AiBudget, SYSTEM, TOOLS, searchRecords, toDraft, type AiResult } from './aiAgent';
import { currentStats } from './nightReport';

/**
 * The same AI helper as AiAgent (questions + drafts, read-only tools, YES before saving),
 * on Google Gemini's free tier. Note: on the free tier Google may use requests to improve
 * its products, so only the steward's message and matching record text are ever sent.
 */

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

const DECLARATIONS: FunctionDeclaration[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parametersJsonSchema: t.input_schema,
}));

export class GeminiAgent {
  private client: Pick<GoogleGenAI, 'models'>;
  private budget: AiBudget;

  constructor(
    apiKey: string,
    readonly model = DEFAULT_GEMINI_MODEL,
    private readonly now: () => number = Date.now,
    client?: Pick<GoogleGenAI, 'models'>,
  ) {
    this.client = client ?? new GoogleGenAI({ apiKey });
    this.budget = new AiBudget(now);
  }

  async handle(text: string, senderId: string): Promise<AiResult> {
    const limited = this.budget.allow(senderId);
    if (limited) return { kind: 'error', text: limited };

    const now = new Date(this.now());
    const contents: Content[] = [{ role: 'user', parts: [{ text: `[Time now: ${formatClock(now)}]\n${text.slice(0, 1500)}` }] }];
    let inTokens = 0;
    let outTokens = 0;
    try {
      for (let turn = 0; turn < 5; turn++) {
        const res = await this.client.models.generateContent({
          model: this.model,
          contents,
          config: { systemInstruction: SYSTEM, tools: [{ functionDeclarations: DECLARATIONS }], maxOutputTokens: 2048 },
        });
        inTokens += res.usageMetadata?.promptTokenCount ?? 0;
        outTokens += res.usageMetadata?.candidatesTokenCount ?? 0;

        const reply = res.candidates?.[0]?.content;
        if (!reply) return { kind: 'error', text: '🤖 I can’t help with that one. Use the commands instead (send HELP).' }; // blocked
        const calls = res.functionCalls ?? [];
        if (!calls.length) {
          const answer = (res.text ?? '').trim();
          return { kind: 'answer', text: answer || '🤖 Sorry, I couldn’t work that out. Try the commands (send HELP).' };
        }

        const draftCall = calls.find((c) => c.name === 'draft_log');
        if (draftCall) {
          const draft = toDraft(draftCall.args ?? {});
          if (draft) return { kind: 'draft', draft };
        }

        contents.push(reply);
        const parts = [];
        for (const c of calls) {
          let result: string;
          try {
            if (c.name === 'search_records') result = await searchRecords(c.args ?? {}, now);
            else if (c.name === 'get_stats') result = await currentStats(now);
            else if (c.name === 'draft_log') result = 'Invalid draft: decision must be refused, sent_away or ejected.';
            else result = `Unknown tool ${c.name}`;
          } catch (err) {
            result = `Lookup failed: ${(err as Error).message}`;
          }
          parts.push({ functionResponse: { id: c.id, name: c.name, response: { result } } });
        }
        contents.push({ role: 'user', parts });
      }
      return { kind: 'answer', text: '🤖 That took too many steps. Try a simpler question, or the commands (send HELP).' };
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) return { kind: 'error', text: '🤖 The AI helper is busy or out of free requests for now. Use the commands (send HELP) and try later.' };
        if (err.status === 400 || err.status === 401 || err.status === 403) {
          console.error(`[ai] Gemini rejected the request (${err.status}): ${err.message}`);
          return { kind: 'error', text: '🤖 The AI helper isn’t set up correctly. Ask the organiser to check the API key.' };
        }
        console.error(`[ai] Gemini error ${err.status}: ${err.message}`);
      } else {
        console.error('[ai] Gemini request failed:', (err as Error).message);
      }
      return { kind: 'error', text: '🤖 The AI helper isn’t available right now. Use the commands (send HELP).' };
    } finally {
      if (inTokens || outTokens) console.log(`[ai] ${this.model}: ${inTokens} input + ${outTokens} output tokens`);
    }
  }
}
