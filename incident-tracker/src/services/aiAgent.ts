import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config/env';
import { HUBS, type Hub } from '../domain';
import { listRecords, type RecordRow } from './adminRecords';
import { formatClock } from './format';
import { currentStats } from './nightReport';

/**
 * Optional AI helper for the WhatsApp bot (on only when ANTHROPIC_API_KEY is set).
 *  - Questions in plain English ("anyone in a red coat sent away?"), answered from tonight's
 *    records through read-only tools.
 *  - Plain-English logs ("refused drunk lad, green hat, 313 YY 56 West"), turned into a DRAFT
 *    that the steward must confirm before anything is saved.
 * Never sent: photos, steward names, ticket/QR codes.
 */

const REASONS = ['Intoxicated', 'Abusive', 'Under the influence', 'Intoxicated minor', 'Found in possession', 'Other'] as const;
const HEIGHTS = ['Short', 'Average height', 'Tall'] as const;
const BUILDS = ['Slim', 'Average build', 'Heavy'] as const;
const AGES = ['Adult', 'Minor (under 18)'] as const;

export interface AiDraft {
  decision?: 'refused' | 'cool_off'; // missing when the steward didn't say (the bot asks)
  ejected: boolean;
  section?: string;
  row?: string;
  seat?: string;
  hub?: Hub;
  reasons?: (typeof REASONS)[number][];
  otherReason?: string;
  gender?: string;
  height?: string;
  build?: string;
  age?: string;
  clothing?: string;
  party?: number;
}

/** `heard`: what a voice note was transcribed as, shown to the steward so they can check it. */
export type AiResult =
  | { kind: 'answer'; text: string; heard?: string }
  | { kind: 'draft'; draft: AiDraft; heard?: string }
  | { kind: 'error'; text: string };

export interface DescriptionFields {
  gender?: string;
  height?: string;
  build?: string;
  age?: string;
  clothing?: string;
}

/** Seats the bot already read itself (ticket photo), so the AI must not ask for or change them. */
export interface AiContext {
  seats?: Array<{ section: string; row: string; seat: string }>;
}

/** What the WhatsApp bot needs from an AI provider. */
export interface AiHelper {
  handle(text: string, senderId: string, ctx?: AiContext): Promise<AiResult>;
  /** "tall heavy lad about 20, green hat" -> the description fields; null if it can't. */
  describe?(text: string, senderId: string): Promise<DescriptionFields | null>;
  /** A suggestion from the venue's policy; the steward decides. */
  advise?(situation: string, policy: string, senderId: string): Promise<AiResult>;
  /** A voice note (Gemini only). */
  handleAudio?(audio: Buffer, mime: string, senderId: string): Promise<AiResult>;
}

export const SYSTEM = `You are Gatekeeper's assistant inside a WhatsApp group of stadium stewards. Stewards refuse entry to people (usually for intoxication), send them away for 30 minutes to cool off, or eject them from inside. Records are kept by seat: section, row, seat (e.g. "313 YY 56").

You do one of two things per message:

1. ANSWER A QUESTION about tonight's records. Always look the facts up with search_records or get_stats; never answer from memory or guess. If the tools return nothing relevant, say so. Keep answers short for a phone screen: a line or two, or a short list of seats with status. WhatsApp formatting only (*bold*, _italic_), no tables or headings. Status words: REFUSED, EJECTED, SENT AWAY (with minutes left), COOL-OFF ENDED, CLEARED. End with "Send the seat for full details." when you mention specific seats.

2. TURN A PLAIN-ENGLISH LOG INTO A DRAFT. If the steward is reporting a person they refused, sent away or ejected, call draft_log with only what they actually said. Do not invent a seat, hub or reason. Map their words to the fixed options (e.g. "drunk", "steaming" -> Intoxicated; "aggressive", "swearing at staff" -> Abusive; "drugs", "high" -> Under the influence; "had a knife/drugs on them" -> Found in possession; anything else -> Other with other_reason). "Sent away", "cool off", "come back later" -> sent_away. "Thrown out", "removed from inside" -> ejected. The bot will show the draft to the steward for confirmation and ask for anything missing, so leave out what you don't know. If they don't say whether the person was refused, sent away or ejected, leave decision out. If the message says the seats were already read from the ticket, don't include a seat.

Rules:
- Never describe or speculate about anyone's ethnicity, religion, health or other sensitive traits, and never try to identify who a person is. Describe only what stewards recorded.
- Never claim you saved, changed or deleted anything: you can't. Saving happens only after the steward confirms the draft.
- If the message is neither a question about the records nor a log, reply briefly that you can answer questions about tonight's refusals or log someone, and suggest HELP.`;

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'search_records',
    description:
      "Search tonight's records (everyone currently on record; records are deleted after 24 hours). All filters are optional and combine with AND. Returns at most 30 records, newest first, with seat, status, reasons, description, first hub and time, minutes left for sent-away people, group size, hub-hop attempts and notes.",
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Words to find in the description, reasons or notes, e.g. "red coat".' },
        section: { type: 'string', description: 'Exact section, e.g. "313".' },
        row: { type: 'string', description: 'Exact row within the section, e.g. "YY".' },
        status: { type: 'string', enum: ['refused', 'ejected', 'sent_away', 'cooloff_ended', 'cleared', 'any'] },
        hub: { type: 'string', enum: [...HUBS] },
        since_minutes: { type: 'integer', description: 'Only records first logged within this many minutes.' },
        tried_another_hub: { type: 'boolean', description: 'Only people who tried a second hub.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_stats',
    description: "Tonight's totals: refused, ejected, sent away now, cleared, hub-hops, counts by reason and by hub, minors, people in groups.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'draft_log',
    description:
      'Prepare a new record from a steward’s plain-English report, for them to confirm. Include only what they said. Calling this ends your turn: the bot takes over.',
    input_schema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['refused', 'sent_away', 'ejected'] },
        section: { type: 'string' },
        row: { type: 'string' },
        seat: { type: 'string', description: 'Seat number.' },
        hub: { type: 'string', enum: [...HUBS] },
        reasons: { type: 'array', items: { type: 'string', enum: [...REASONS] } },
        other_reason: { type: 'string', description: 'What happened, when "Other" is one of the reasons.' },
        gender: { type: 'string', enum: ['Male', 'Female'] },
        height: { type: 'string', enum: [...HEIGHTS] },
        build: { type: 'string', enum: [...BUILDS] },
        age: { type: 'string', enum: [...AGES] },
        clothing: { type: 'string', description: 'What they are wearing, in the steward’s words.' },
        party_size: { type: 'integer', minimum: 1, maximum: 99 },
      },
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------- describe & advise

export const DESCRIBE_SYSTEM = `A stadium steward is describing a person they refused entry to. Turn their words into the fixed fields by calling set_description once. Use only what they said; leave out anything they didn't mention. Height: "short", "average height" or "tall". Build: "slim", "average" or "heavy" (e.g. "big lad" -> Heavy). Age: "Adult" for adults or rough adult ages ("about 20", "30s"); "Minor (under 18)" only if they say under 18, a kid, a teenager or a minor. Clothing: what they wear, in the steward's words, short. Never add ethnicity, religion, health or other sensitive traits even if mentioned.`;

export const DESCRIBE_TOOL: Anthropic.Beta.BetaTool = {
  name: 'set_description',
  description: 'The person’s description as fixed fields.',
  input_schema: {
    type: 'object',
    properties: {
      gender: { type: 'string', enum: ['Male', 'Female'] },
      height: { type: 'string', enum: [...HEIGHTS] },
      build: { type: 'string', enum: [...BUILDS] },
      age: { type: 'string', enum: [...AGES] },
      clothing: { type: 'string' },
    },
    additionalProperties: false,
  },
};

export function toDescription(input: Record<string, unknown>): DescriptionFields | null {
  const pick = <T extends string>(v: unknown, options: readonly T[]): T | undefined => options.find((o) => o === v);
  const d: DescriptionFields = {
    gender: pick(input.gender, ['Male', 'Female'] as const),
    height: pick(input.height, HEIGHTS),
    build: pick(input.build, BUILDS),
    age: pick(input.age, AGES),
    clothing: str(input.clothing, 300),
  };
  return Object.values(d).some(Boolean) ? d : null;
}

export function adviceSystem(policy: string): string {
  return `You help stadium stewards apply their venue's refusal policy. A steward describes a person at the gate. Based ONLY on the policy below, say in one or two short sentences what the policy points to: refuse entry, send away for 30 minutes to sober up, or allow in, and which part of the policy applies. Start with "Suggestion:". If the policy doesn't cover the situation, say so and suggest asking a supervisor. Never invent rules that aren't in the policy. Never mention ethnicity, religion, health or other sensitive traits. WhatsApp formatting only.

VENUE POLICY:
${policy.slice(0, 4000)}`;
}

/** "[Seats already read from the ticket: 313 YY 56, 313 YY 57.]" */
export function contextLine(ctx?: AiContext): string {
  if (!ctx?.seats?.length) return '';
  return `[Seats already read from the ticket: ${ctx.seats.map((s) => `${s.section} ${s.row} ${s.seat}`).join(', ')}. Don't include a seat in the draft.]\n`;
}

// ---------------------------------------------------------------- tool implementations

function statusWord(r: RecordRow, now: Date): string {
  if (r.current_status === 'admitted') return 'CLEARED';
  if (r.current_status === 'completely_refused') return /^Ejected/.test(r.reasoning) ? 'EJECTED' : 'REFUSED';
  if (r.cool_down_until && new Date(r.cool_down_until) > now) {
    return `SENT AWAY (${Math.ceil((new Date(r.cool_down_until).getTime() - now.getTime()) / 60_000)} min left, back ${formatClock(r.cool_down_until)})`;
  }
  return 'COOL-OFF ENDED';
}

/** One record as the model sees it: no steward names, ticket codes or photos. */
function recordForModel(r: RecordRow, now: Date): string {
  const parts = [
    `${r.section ?? '?'} ${r.row_label ?? '?'} ${r.seat_number ?? '?'}`,
    statusWord(r, now),
    r.reasoning && r.reasoning !== 'Not provided' ? `reasons: ${r.reasoning}` : '',
    r.description && r.description !== 'Not provided' ? `description: ${r.description}` : '',
    r.origin_hub ? `first at ${r.origin_hub}${r.origin_at ? ` ${formatClock(r.origin_at)}` : ''}` : '',
    r.party_size > 1 ? `group of ${r.party_size}` : '',
    r.breaches ? `tried another hub ${r.breaches}x` : '',
    // Notes are stored as "Author: text | Author: text"; keep the text only.
    r.notes ? `notes: ${r.notes.split(' | ').map((n) => n.replace(/^[^:]{1,100}:\s*/, '')).join('; ')}` : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

const str = (v: unknown, max = 100) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export async function searchRecords(input: Record<string, unknown>, now: Date): Promise<string> {
  const hub = HUBS.find((h) => h === input.hub);
  let rows = await listRecords({ q: str(input.text), section: str(input.section, 16), row: str(input.row, 8), hub, breaches: input.tried_another_hub === true }, 500);
  const status = str(input.status);
  if (status && status !== 'any') rows = rows.filter((r) => statusWord(r, now).toLowerCase().replace(/[\s-]/g, '_').startsWith(status.replace('cooloff', 'cool_off')));
  const since = Number(input.since_minutes);
  if (since > 0) rows = rows.filter((r) => r.origin_at && now.getTime() - new Date(r.origin_at).getTime() <= since * 60_000);
  if (!rows.length) return 'No matching records.';
  return `${rows.length} matching record(s)${rows.length > 30 ? ', newest 30 shown' : ''}:\n` + rows.slice(0, 30).map((r) => recordForModel(r, now)).join('\n');
}

export function toDraft(input: Record<string, unknown>): AiDraft | null {
  const decision = input.decision === 'sent_away' ? 'cool_off' : input.decision === 'refused' || input.decision === 'ejected' ? 'refused' : undefined;
  const pick = <T extends string>(v: unknown, options: readonly T[]): T | undefined => options.find((o) => o === v);
  const reasons = Array.isArray(input.reasons) ? [...new Set(input.reasons.map((r) => pick(r, REASONS)).filter((r): r is (typeof REASONS)[number] => !!r))] : [];
  const party = Number(input.party_size);
  const section = str(input.section, 6)?.toUpperCase();
  const row = str(input.row, 4)?.toUpperCase();
  const seat = str(input.seat, 4);
  const fullSeat = section && row && seat && /^\d{1,4}$/.test(seat);
  return {
    decision,
    ejected: input.decision === 'ejected',
    ...(fullSeat ? { section, row, seat } : {}),
    hub: pick(input.hub, HUBS),
    reasons: reasons.length ? reasons : undefined,
    otherReason: str(input.other_reason, 300),
    gender: pick(input.gender, ['Male', 'Female'] as const),
    height: pick(input.height, HEIGHTS),
    build: pick(input.build, BUILDS),
    age: pick(input.age, AGES),
    clothing: str(input.clothing, 300),
    party: Number.isInteger(party) && party > 1 && party < 100 ? party : undefined,
  };
}

// ---------------------------------------------------------------- the agent

/** Budget guard shared by every AI provider: per-sender hourly limit and a daily cap for everyone. */
export class AiBudget {
  private used = new Map<string, number[]>(); // sender -> timestamps (last hour)
  private day = '';
  private dayCount = 0;

  constructor(private readonly now: () => number) {}

  /** null = go ahead; otherwise the message to send instead. */
  allow(senderId: string): string | null {
    const now = this.now();
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayCount = 0;
    }
    if (this.dayCount >= getConfig().AI_DAILY_LIMIT) return '🤖 The AI helper has reached today’s limit. Use the commands (send HELP) until tomorrow.';
    const recent = (this.used.get(senderId) ?? []).filter((t) => now - t < 60 * 60_000);
    if (recent.length >= 30) return '🤖 You’ve asked a lot this hour. Use the commands (send HELP), or try again later.';
    recent.push(now);
    this.used.set(senderId, recent);
    this.dayCount++;
    return null;
  }
}

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

const NOT_AVAILABLE = '🤖 The AI helper isn’t available right now. Use the commands (send HELP).';

/** What one AI exchange ended with: a final answer, a "stop" tool call, or an error message. */
type RunResult = { text: string } | { call: { name: string; input: Record<string, unknown> } } | { error: string };

export class AiAgent implements AiHelper {
  private client: Anthropic;
  private budget: AiBudget;

  constructor(
    apiKey: string,
    readonly model = getConfig().AI_MODEL ?? DEFAULT_CLAUDE_MODEL,
    private readonly now: () => number = Date.now,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
    this.budget = new AiBudget(now);
  }

  async handle(text: string, senderId: string, ctx?: AiContext): Promise<AiResult> {
    const limited = this.budget.allow(senderId);
    if (limited) return { kind: 'error', text: limited };
    const r = await this.run(SYSTEM, `${contextLine(ctx)}${text}`, TOOLS, ['draft_log']);
    if ('error' in r) return { kind: 'error', text: r.error };
    if ('call' in r) {
      const draft = toDraft(r.call.input);
      return draft ? { kind: 'draft', draft } : { kind: 'error', text: '🤖 Sorry, I couldn’t work that out. Try the commands (send HELP).' };
    }
    return { kind: 'answer', text: r.text || '🤖 Sorry, I couldn’t work that out. Try the commands (send HELP).' };
  }

  async describe(text: string, senderId: string): Promise<DescriptionFields | null> {
    if (this.budget.allow(senderId)) return null;
    const r = await this.run(DESCRIBE_SYSTEM, text, [DESCRIBE_TOOL], ['set_description']);
    return 'call' in r ? toDescription(r.call.input) : null;
  }

  async advise(situation: string, policy: string, senderId: string): Promise<AiResult> {
    const limited = this.budget.allow(senderId);
    if (limited) return { kind: 'error', text: limited };
    const r = await this.run(adviceSystem(policy), situation, [], []);
    if ('error' in r) return { kind: 'error', text: r.error };
    if ('text' in r && r.text) return { kind: 'answer', text: r.text };
    return { kind: 'error', text: NOT_AVAILABLE };
  }

  /** The tool loop: read-only tools run here; a tool in `stopOn` ends the exchange. */
  private async run(system: string, text: string, tools: Anthropic.Beta.BetaTool[], stopOn: string[]): Promise<RunResult> {
    const now = new Date(this.now());
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: `[Time now: ${formatClock(now)}]\n${text.slice(0, 1500)}` }];
    let inTokens = 0;
    let outTokens = 0;
    try {
      for (let turn = 0; turn < 5; turn++) {
        const res = await this.client.beta.messages.create({
          model: this.model,
          max_tokens: 4096,
          system,
          ...(tools.length ? { tools } : {}),
          messages,
          output_config: { effort: 'low' },
          cache_control: { type: 'ephemeral' },
          // On a safety decline, re-run on Anthropic's recommended fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
        inTokens += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
        outTokens += res.usage.output_tokens;

        if (res.stop_reason === 'refusal') return { error: '🤖 I can’t help with that one. Use the commands instead (send HELP).' };
        const toolUses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        if (res.stop_reason !== 'tool_use' || !toolUses.length) {
          return {
            text: res.content
              .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
              .trim(),
          };
        }
        const stop = toolUses.find((t) => stopOn.includes(t.name));
        if (stop) return { call: { name: stop.name, input: stop.input as Record<string, unknown> } };

        messages.push({ role: 'assistant', content: res.content });
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const t of toolUses) {
          const { content, isError } = await runReadTool(t.name, t.input as Record<string, unknown>, now);
          results.push({ type: 'tool_result', tool_use_id: t.id, content, is_error: isError });
        }
        messages.push({ role: 'user', content: results });
      }
      return { error: '🤖 That took too many steps. Try a simpler question, or the commands (send HELP).' };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        console.error('[ai] the API key was rejected: check ANTHROPIC_API_KEY');
        return { error: '🤖 The AI helper isn’t set up correctly. Ask the organiser to check the API key.' };
      }
      if (err instanceof Anthropic.RateLimitError) return { error: '🤖 The AI helper is busy. Try again in a minute, or use the commands.' };
      console.error('[ai] request failed:', err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : (err as Error).message);
      return { error: NOT_AVAILABLE };
    } finally {
      if (inTokens || outTokens) console.log(`[ai] ${this.model}: ${inTokens} input + ${outTokens} output tokens`);
    }
  }
}

/** The read-only tools both providers can run: search and stats. */
export async function runReadTool(name: string, input: Record<string, unknown>, now: Date): Promise<{ content: string; isError: boolean }> {
  try {
    if (name === 'search_records') return { content: await searchRecords(input, now), isError: false };
    if (name === 'get_stats') return { content: await currentStats(now), isError: false };
    return { content: `Unknown tool ${name}`, isError: true };
  } catch (err) {
    return { content: `Lookup failed: ${(err as Error).message}`, isError: true };
  }
}
