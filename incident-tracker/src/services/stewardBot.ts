import { getConfig } from '../config/env';
import { getPool, isConnectivityError } from '../db/pool';
import { listRecords, recordsToCsv, updateRecord, type RecordRow } from './adminRecords';
import { currentStats } from './nightReport';
import { HUBS, type Hub } from '../domain';
import { parseGroupMessage } from './commandParser';
import { formatClock, minutesUntil, sanitize } from './format';
import { appendOfflineIncident } from './offlineBuffer';
import { decodeQrFromImage, ticketCodeFromQr } from './qrImage';
import { formatQuickCheck } from './quickCheck';
import { processScan, scanInputSchema, type ScanOutcome } from './scanService';
import { getTicketProfile, getTicketProfileBySeat } from './ticketLookup';

/**
 * The WhatsApp-only steward flow.
 *
 *  Log:   a photo (Ticketmaster QR or the customer) and/or text such as
 *         "REFUSED 52 YY 14 West 1 3 M 3 2 adult green hat"  or  "30 52 YY 14 ...", or "LOG".
 *         Anything missing is asked for, one question at a time, with numbered options:
 *         refused/sent away, seat, hub, reasons (several allowed; "Other" asks what happened),
 *         then male/female, height, build, minor/adult and clothing.
 *         The time is the message time. The hub is asked every time (last one shown as a hint).
 *  Check: "BB 212 100" -> refused / sent away / not on record, with the photo if there is one.
 *  Also:  LIST (everyone refused or sent away now), BACK (reopen the previous question), UNDO (remove your last new record),
 *         CANCEL (drop a half-finished log), HELP.
 */

export type Decision = 'refused' | 'cool_off';

export interface InboundMessage {
  chatId: string; // group or private chat the message came from
  senderId: string; // who sent it
  senderName: string; // WhatsApp display name
  text?: string | null; // message text or image caption
  image?: { data: Buffer; mime: string } | null;
  at?: Date; // when it was sent
}

export interface OutboundReply {
  text: string;
  image?: { data: Buffer; mime: string };
  document?: { data: Buffer; mime: string; fileName: string };
}

// ---------------------------------------------------------------- parsing

const DECISION_RE = /^\s*(refused|refuse|ref|r|sent\s*away|sent|sa|30\s*min(?:ute)?s?|30|cool\s*-?\s*off|cooling\s*off|cooloff|cool)\b[\s:,-]*/i;
const HUB_RE = /^\s*(east|west|south|hosp(?:itality)?)(?:\s*hub)?\b[\s:,]*/i;
const SEAT_RE =
  /^\s*(?:(?:section|sect|sec|block|blk)\.?\s*)?([a-z0-9]{1,6})\s*[\s/,|]\s*(?:(?:row|rw)\.?\s*)?([a-z0-9]{1,4})\s*[\s/,|]\s*(?:(?:seat|st)\.?\s*)?(\d{1,4})\b[\s:,]*/i;

export function parseDecision(word: string): Decision | null {
  const m = DECISION_RE.exec(word);
  if (!m) return null;
  return /^(refused|refuse|ref|r)$/i.test(m[1].trim()) ? 'refused' : 'cool_off';
}

export function parseHub(word: string): Hub | null {
  const m = HUB_RE.exec(word);
  if (!m) return null;
  const k = m[1].toLowerCase();
  if (k.startsWith('hosp')) return 'Hospitality Hub';
  return HUBS.find((h) => h.toLowerCase().startsWith(k)) ?? null;
}

export const REASONS = ['Intoxicated', 'Abusive', 'Under the influence', 'Intoxicated minor', 'Found in possession', 'Other'] as const;
export type Reason = (typeof REASONS)[number];
export const HEIGHTS = ['Short', 'Average height', 'Tall'] as const;
export const BUILDS = ['Slim', 'Average build', 'Heavy'] as const;
export const AGES = ['Adult', 'Minor (under 18)'] as const;

const SEP = /^[\s,.:;&]*/;
const END = '(?=[\\s,.:;&]|$)';
const REASON_WORDS: Array<[RegExp, Reason]> = [
  [/^\s*intox(?:icated)?\s+minor\b/i, 'Intoxicated minor'],
  [/^\s*(?:intoxicated|intox|drunk)\b/i, 'Intoxicated'],
  [/^\s*(?:abusive|abuse)\b/i, 'Abusive'],
  [/^\s*(?:under\s+the\s+influence|under\s+influence|uti)\b/i, 'Under the influence'],
  [/^\s*(?:found\s+in\s+possession|possession|fip)\b/i, 'Found in possession'],
  [/^\s*other\b/i, 'Other'],
];
const HEIGHT_WORDS: Array<[RegExp, string]> = [
  [/^\s*short\b/i, HEIGHTS[0]],
  [/^\s*(?:average|medium)\s+height\b/i, HEIGHTS[1]],
  [/^\s*tall\b/i, HEIGHTS[2]],
];
const BUILD_WORDS: Array<[RegExp, string]> = [
  [/^\s*(?:slim|thin|skinny)\b/i, BUILDS[0]],
  [/^\s*(?:average|medium)(?:\s+build)?\b/i, BUILDS[1]],
  [/^\s*(?:heavy|large|big|stocky)\b/i, BUILDS[2]],
];

type Take<T> = [T, string] | null;
const after = (s: string, used: number) => s.slice(used).replace(SEP, '');

/** "1 3 5", "1,3,5", "135", "drunk & abusive" -> every reason given, in order, without repeats. */
function takeReasons(s: string): Take<Reason[]> {
  const out: Reason[] = [];
  const add = (r: Reason) => !out.includes(r) && out.push(r);
  let rest = s;
  for (;;) {
    const packed = new RegExp(`^\\s*([1-6]{2,6})${END}`).exec(rest); // "135"
    const n = packed ?? new RegExp(`^\\s*([1-6])${END}`).exec(rest);
    if (n) {
      for (const d of n[1]) add(REASONS[Number(d) - 1]);
      rest = after(rest, n[0].length);
      continue;
    }
    const w = REASON_WORDS.find(([re]) => re.test(rest));
    if (w) {
      add(w[1]);
      rest = after(rest, w[0].exec(rest)![0].length);
      continue;
    }
    break;
  }
  return out.length ? [out, rest] : null;
}

function takeGender(s: string): Take<string> {
  const m = /^\s*(male|female|man|woman|m|f)\b/i.exec(s);
  return m ? [/^(f|female|woman)$/i.test(m[1]) ? 'Female' : 'Male', after(s, m[0].length)] : null;
}

/** A numbered option (only where a number can't be mistaken for something else) or one of its words. */
function takeOption(s: string, options: readonly string[], words: Array<[RegExp, string]>, allowDigit: boolean): Take<string> {
  const n = allowDigit ? new RegExp(`^\\s*([1-${options.length}])${END}`).exec(s) : null;
  if (n) return [options[Number(n[1]) - 1], after(s, n[0].length)];
  for (const [re, v] of words) {
    const m = re.exec(s);
    if (m) return [v, after(s, m[0].length)];
  }
  return null;
}

function takeAge(s: string, asked: boolean): Take<string> {
  const words: Array<[RegExp, string]> = [
    [/^\s*(?:adult|over\s*18|18\+)(?=[\s,.:;]|$)/i, AGES[0]],
    [/^\s*(?:minor|child|kid|u18|under\s*18)\b/i, AGES[1]],
  ];
  // A lone "A" is only safe as the answer to the question ("a green hat" is clothing).
  if (asked) words.push([/^\s*a\b/i, AGES[0]]);
  return takeOption(s, AGES, words, asked);
}

const DETAIL_ORDER = ['reasons', 'gender', 'height', 'build', 'age', 'clothing'] as const;
type DetailField = (typeof DETAIL_ORDER)[number];
const DESCRIPTION_FIELDS = ['gender', 'height', 'build', 'age', 'clothing'] as const;

export interface Details {
  reasons?: Reason[];
  gender?: string; // '' = skipped
  height?: string; // '' = skipped
  build?: string; // '' = skipped
  age?: string; // '' = skipped
  clothing?: string; // '' = skipped
}

/**
 * "1 3 M 3 2 adult green hat" -> reasons, gender, height, build, age, clothing, in the
 * order the bot asks them, each optional, starting at `from`. A bare number is only read
 * as a height/build right after the field before it (or as the answer to that question),
 * so "abusive 2 lads" stays clothing. A trailing "-" skips the rest of the description.
 */
export function parseDetails(text: string, from: DetailField = 'reasons'): Details {
  const at = (f: DetailField) => DETAIL_ORDER.indexOf(f) >= DETAIL_ORDER.indexOf(from);
  const out: Details = {};
  let s = text;
  if (at('reasons')) {
    const r = takeReasons(s);
    if (r) [out.reasons, s] = r;
  }
  if (at('gender')) {
    const g = takeGender(s);
    if (g) [out.gender, s] = g;
  }
  if (at('height')) {
    const h = takeOption(s, HEIGHTS, HEIGHT_WORDS, from === 'height' || out.gender !== undefined);
    if (h) [out.height, s] = h;
  }
  if (at('build')) {
    const b = takeOption(s, BUILDS, BUILD_WORDS, from === 'build' || out.height !== undefined);
    if (b) [out.build, s] = b;
  }
  if (at('age')) {
    const a = takeAge(s, from === 'age');
    if (a) [out.age, s] = a;
  }
  const left = s.trim();
  if (/^[-–—]+$/.test(left)) {
    for (const f of DESCRIPTION_FIELDS) if (at(f) && out[f] === undefined) out[f] = '';
  } else if (left) {
    out.clothing = left.replace(/^[-–—:]\s*/, '').slice(0, 300);
  }
  return out;
}

export interface ParsedLog extends Details {
  decision?: Decision;
  section?: string;
  row?: string;
  seat?: string;
  hub?: Hub;
}

/** "REFUSED 52 YY 14 West 1 M 2 green hat" -> parts. Returns null if it doesn't start with a decision. */
export function parseLogCommand(text: string | null | undefined): ParsedLog | null {
  if (!text) return null;
  const d = DECISION_RE.exec(text);
  if (!d) return null;
  // "r" and "sa" alone are too easy to type by accident in chat: they need a seat right after.
  const short = /^(r|sa|sent)$/i.test(d[1].trim());
  let rest = text.slice(d[0].length);
  const out: ParsedLog = { decision: parseDecision(d[1])! };

  const s = SEAT_RE.exec(rest);
  if (s) {
    out.section = s[1].toUpperCase();
    out.row = s[2].toUpperCase();
    out.seat = s[3];
    rest = rest.slice(s[0].length);
  } else if (short) {
    return null;
  }
  const h = HUB_RE.exec(rest);
  if (h) {
    out.hub = parseHub(h[1])!;
    rest = rest.slice(h[0].length);
  }
  return Object.assign(out, parseDetails(rest));
}

/** A bare seat as an answer to "which seat?": "BB 212 100", "BB/212/100", "Section BB Row 212 Seat 100". */
export function parseSeatAnswer(text: string): Pick<ParsedLog, 'section' | 'row' | 'seat'> | null {
  const s = SEAT_RE.exec(text);
  if (!s || text.slice(s[0].length).trim()) return null;
  return { section: s[1].toUpperCase(), row: s[2].toUpperCase(), seat: s[3] };
}

// ---------------------------------------------------------------- conversation state

type Field = 'decision' | 'seat' | 'hub' | 'reasons' | 'other' | 'gender' | 'height' | 'build' | 'age' | 'clothing';

interface Pending extends ParsedLog {
  otherReason?: string; // what happened, when "Other" is one of the reasons ('' = skipped)
  ticketCode?: string;
  photo?: { data: Buffer; mime: string };
  asked?: Field;
  /** Questions asked so far, each with the answers as they were just before it, so BACK can rewind. */
  history?: Array<{ field: Field; before: Answers }>;
  startedAt: number;
}

const ANSWER_KEYS = ['decision', 'section', 'row', 'seat', 'hub', 'reasons', 'otherReason', 'gender', 'height', 'build', 'age', 'clothing'] as const;
type Answers = Partial<Pick<Pending, (typeof ANSWER_KEYS)[number]>>;

function snapshot(p: Pending): Answers {
  const out: Answers = {};
  for (const k of ANSWER_KEYS) if (p[k] !== undefined) (out as Record<string, unknown>)[k] = Array.isArray(p[k]) ? [...(p[k] as string[])] : p[k];
  return out;
}

function restore(p: Pending, a: Answers): void {
  for (const k of ANSWER_KEYS) delete p[k];
  Object.assign(p, a);
}

interface LastLog {
  ticketId: string;
  createdTicket: boolean;
  at: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const HUB_MEMORY_MS = 12 * 60 * 60_000;
const UNDO_WINDOW_MS = 15 * 60_000;

const numbered = (opts: readonly string[]) => opts.map((o, i) => `*${i + 1}* ${o}`).join('\n');
const SKIP = '\n_(*-* to skip)_';

const PROMPTS: Record<Field, string> = {
  decision: 'Refused entry, or sent away for 30 minutes? Reply with a number:\n*1* Refused entry\n*2* Sent away 30 min',
  seat: 'Which seat? Send section, row and seat, e.g. *52 YY 14*.',
  hub: `Which hub are you at? Reply with a number:\n${numbered(HUBS.map((h) => h.replace(' Hub', '')))}`,
  reasons: `Reason? Reply with a number:\n${numbered(REASONS)}\n_More than one? Send all the numbers, e.g. *1 3 5*_`,
  other: 'You picked *Other*. What happened? Describe it in your own words.',
  gender: `Male or female? Reply *M* or *F*.${SKIP}`,
  height: `Height? Reply with a number:\n${numbered(HEIGHTS)}${SKIP}`,
  build: `Build? Reply with a number:\n${numbered(BUILDS)}${SKIP}`,
  age: `Minor or adult? Reply with a number:\n*1* Adult\n*2* Minor (under 18)${SKIP}`,
  clothing: 'What are they wearing? e.g. *green hat, black jacket*. Reply *-* to skip.',
};

export class StewardBot {
  private pending = new Map<string, Pending>();
  private hubs = new Map<string, { hub: Hub; at: number }>();
  private lastLogs = new Map<string, LastLog>();

  /** Posts to the selected groups except `exceptChatId` (set by the WhatsApp channel). */
  announce?: (text: string, exceptChatId?: string) => void;
  /** Whether this sender may use supervisor commands (CLEAR, REPORT). Unset = everyone (tests, demo). */
  canSupervise?: (senderId: string) => Promise<boolean>;

  private async supervisorOnly(m: InboundMessage, what: string): Promise<string | null> {
    if (!this.canSupervise || (await this.canSupervise(m.senderId).catch(() => false))) return null;
    console.log(`[steward-bot] ${what} refused: sender is not a group admin`);
    return `⛔ Only group admins (supervisors) can ${what}. Ask a supervisor, or a group admin can make you one.`;
  }

  constructor(private readonly now: () => number = Date.now) {}

  private key(m: InboundMessage) {
    return `${m.chatId}|${m.senderId}`;
  }

  private rememberedHub(senderId: string): Hub | undefined {
    const h = this.hubs.get(senderId);
    return h && this.now() - h.at < HUB_MEMORY_MS ? h.hub : undefined;
  }

  /** The question, with the steward's last hub as a hint and how to go back or stop. */
  private prompt(field: Field, p: Pending, senderId: string): string {
    let text = PROMPTS[field];
    const last = field === 'hub' ? this.rememberedHub(senderId) : undefined;
    if (last) text += `\n_Last time: *${last.replace(' Hub', '')}* (reply *${HUBS.indexOf(last) + 1}*)_`;
    const canGoBack = (p.history?.length ?? 0) > 1 || (p.history?.length === 1 && p.history[0].field !== field);
    return `${text}\n_${canGoBack ? '*BACK* to change your last answer · ' : ''}*CANCEL* to stop_`;
  }

  /** BACK: reopen the previous question, forgetting that answer and anything after it. */
  private back(p: Pending, senderId: string): string {
    const h = p.history ?? [];
    if (h.length && h[h.length - 1].field === p.asked) h.pop(); // the question on screen now
    const prev = h[h.length - 1];
    if (!prev) {
      if (p.asked) h.push({ field: p.asked, before: snapshot(p) });
      return `Nothing to go back to.\n${this.prompt(p.asked ?? 'decision', p, senderId)}`;
    }
    restore(p, prev.before);
    p.asked = prev.field;
    return `↩️ ${this.prompt(prev.field, p, senderId)}`;
  }

  /** Handle one incoming message. Returns the replies to post (empty = stay quiet). */
  async handle(m: InboundMessage): Promise<OutboundReply[]> {
    const text = (m.text ?? '').trim();
    const k = this.key(m);
    let p = this.pending.get(k);
    if (p && this.now() - p.startedAt > PENDING_TTL_MS) {
      this.pending.delete(k);
      p = undefined;
    }

    if (/^(cancel|stop)$/i.test(text)) {
      if (!p) return [];
      this.pending.delete(k);
      return [{ text: 'Cancelled. Nothing was saved.' }];
    }
    if (/^(back|prev|previous)$/i.test(text)) return p ? [{ text: this.back(p, m.senderId) }] : [];
    if (/^undo$/i.test(text)) return [{ text: await this.undo(m.senderId) }];
    if (/^(help|\?|menu)$/i.test(text)) return [{ text: STEWARD_HELP }];
    if (/^list$/i.test(text)) return [{ text: await this.list() }];
    if (/^stats$/i.test(text)) return [{ text: await this.stats() }];
    if (/^report$/i.test(text)) return [await this.report(m)];
    const clear = /^clear\s+(.+)$/i.exec(text);
    if (clear && !m.image) return [{ text: await this.clear(clear[1], m) }];
    const photoCmd = /^photo\s+(.+)$/i.exec(text);
    if (photoCmd) {
      if (!m.image) return [{ text: `Send the customer's photo with the caption *PHOTO ${sanitize(photoCmd[1], 30)}*.` }];
      return [{ text: await this.addPhoto(photoCmd[1], m.image) }];
    }

    // ---- images: a ticket QR starts (or feeds) a log; another photo is the customer's picture.
    if (m.image) {
      const qr = await decodeQrFromImage(m.image.data);
      const log = parseLogCommand(text) ?? (parseSeatAnswer(text) || (/^(log|new)$/i.test(text) ? {} : null));
      if (!qr && !log && !p) return []; // an ordinary photo in the group: not for us
      p = p ?? { startedAt: this.now() };
      if (qr) p.ticketCode = await ticketCodeFromQr(qr);
      else p.photo = m.image;
      if (log) Object.assign(p, defined(log));
      this.pending.set(k, p);
      const intro = qr ? '🎟️ Ticket QR read.' : '📷 Photo saved.';
      return this.advance(m, p, intro);
    }

    // ---- text that starts a log: "REFUSED BB 212 100 West very drunk"
    const log = parseLogCommand(text);
    if (log) {
      p = { ...(p ?? {}), ...defined(log), startedAt: p?.startedAt ?? this.now() };
      this.pending.set(k, p);
      return this.advance(m, p);
    }

    // ---- "LOG" starts a log from scratch: every question is asked
    if (/^(log|new)$/i.test(text)) {
      p = { startedAt: this.now() };
      this.pending.set(k, p);
      return this.advance(m, p);
    }

    // ---- an answer to the bot's last question
    if (p) {
      const answered = this.applyAnswer(p, text);
      if (answered) return this.advance(m, p);
      return [{ text: this.prompt(p.asked ?? this.nextMissing(p) ?? 'reasons', p, m.senderId) }];
    }

    // ---- a check: "BB 212 100" or "Check TM-…"
    const cmd = parseGroupMessage(text);
    if (!cmd) return [];
    if (cmd.kind === 'help') return [{ text: STEWARD_HELP }];
    if (cmd.kind === 'invalid_check') return [];
    return [await this.check(cmd)];
  }

  private applyAnswer(p: Pending, text: string): boolean {
    const asked = p.asked;
    if (!text) return false;
    if (asked === 'decision' || (!asked && !p.decision)) {
      const d = /^1$/.test(text) ? 'refused' : /^2$/.test(text) ? 'cool_off' : parseDecision(text);
      if (d) return (p.decision = d), true;
    }
    if (asked === 'seat' || !p.seat) {
      const s = parseSeatAnswer(text);
      if (s) return Object.assign(p, s), true;
    }
    if (asked === 'hub' || !p.hub) {
      const n = asked === 'hub' ? /^([1-4])$/.exec(text) : null;
      if (n) return (p.hub = HUBS[Number(n[1]) - 1]), true;
      const h = parseHub(text);
      if (h && text.replace(HUB_RE, '').trim() === '') return (p.hub = h), true;
    }
    if (asked === 'other') {
      if (/^[-–—]+$/.test(text)) return false; // "Other" needs a few words
      p.otherReason = text.slice(0, 300);
      return true;
    }
    const descField = DESCRIPTION_FIELDS.find((f) => f === asked);
    if (descField && /^[-–—]+$/.test(text)) {
      p[descField] = ''; // skip just this question
      return true;
    }
    if (asked === 'reasons' || asked === 'gender' || asked === 'height' || asked === 'build' || asked === 'age' || asked === 'clothing') {
      const d = asked === 'clothing' ? { clothing: text.slice(0, 300) } : parseDetails(text, asked);
      if (d[asked] === undefined) return false;
      Object.assign(p, defined(d));
      return true;
    }
    return false;
  }

  private nextMissing(p: Pending): Field | null {
    if (!p.decision) return 'decision';
    if (!p.seat) return 'seat';
    if (!p.hub) return 'hub';
    if (!p.reasons?.length) return 'reasons';
    if (p.reasons.includes('Other') && p.otherReason === undefined) return 'other';
    for (const f of DESCRIPTION_FIELDS) if (p[f] === undefined) return f;
    return null;
  }

  private async advance(m: InboundMessage, p: Pending, intro?: string): Promise<OutboundReply[]> {
    const missing = this.nextMissing(p);
    if (missing) {
      p.asked = missing;
      p.history ??= [];
      if (p.history[p.history.length - 1]?.field !== missing) p.history.push({ field: missing, before: snapshot(p) });
      const q = this.prompt(missing, p, m.senderId);
      return [{ text: intro ? `${intro} ${q}` : q }];
    }
    this.pending.delete(this.key(m));
    return [{ text: await this.commit(m, p) }];
  }

  // ---------------------------------------------------------------- saving

  private async commit(m: InboundMessage, p: Pending): Promise<string> {
    const hub = p.hub!;
    this.hubs.set(m.senderId, { hub, at: this.now() });
    const at = m.at ?? new Date(this.now());
    const parsed = scanInputSchema.safeParse({
      ticket_id: p.ticketCode,
      section: p.section,
      row: p.row,
      seat: p.seat,
      hub_location: hub,
      steward_name: (m.senderName || 'Steward').slice(0, 100),
      action_logged: p.decision,
      description: describe(p) || undefined,
      reasoning: reasonText(p),
      occurred_at: at.toISOString(),
    });
    if (!parsed.success) {
      return `⚠️ Couldn't save that: ${parsed.error.issues.map((i) => i.message).join('; ')}. Please send it again.`;
    }

    let outcome: ScanOutcome;
    try {
      outcome = await processScan(parsed.data);
    } catch (err) {
      if (isConnectivityError(err)) {
        appendOfflineIncident(parsed.data, (err as Error).message);
        return `⚠️ Database offline. Saved on the server and will sync automatically. Treat *${p.section} ${p.row} ${p.seat}* as ${p.decision === 'refused' ? 'REFUSED' : 'SENT AWAY'} for now.`;
      }
      console.error('[steward-bot] save failed:', err);
      return '⚠️ Something went wrong saving that. Please try again, or radio a supervisor.';
    }

    const ticket = outcome.ticket!;
    if (p.photo) {
      await getPool()
        .query('INSERT INTO ticket_photos (ticket_id, mime_type, data) VALUES ($1, $2, $3)', [ticket.ticket_id, p.photo.mime, p.photo.data])
        .catch((err) => console.error('[steward-bot] photo not saved:', (err as Error).message));
    }
    if (outcome.scenario === 'NEW_INCIDENT' && !outcome.previousStatus) {
      this.lastLogs.set(m.senderId, { ticketId: ticket.ticket_id, createdTicket: true, at: this.now() });
    }
    const reply = confirmation(outcome, hub, p);
    if (outcome.scenario === 'HUB_HOP_BYPASS' && getConfig().WA_HUBHOP_ALERTS) {
      // The steward who logged it sees the reply; everyone else in the other chats gets the alert.
      this.announce?.(`${reply}\n_Logged by ${sanitize(m.senderName || 'a steward', 60)}._`, m.chatId);
    }
    return reply;
  }

  private async undo(senderId: string): Promise<string> {
    const last = this.lastLogs.get(senderId);
    if (!last || this.now() - last.at > UNDO_WINDOW_MS) return 'Nothing to undo. You can undo a new record within 15 minutes.';
    this.lastLogs.delete(senderId);
    const { rowCount } = await getPool().query('DELETE FROM tickets WHERE ticket_id = $1', [last.ticketId]);
    return rowCount ? '↩️ Removed your last record.' : 'That record was already gone.';
  }

  // ---------------------------------------------------------------- STATS, REPORT, CLEAR, PHOTO

  private async stats(): Promise<string> {
    try {
      return await currentStats(new Date(this.now()));
    } catch (err) {
      console.error('[steward-bot] stats failed:', (err as Error).message);
      return '⚠️ Gatekeeper can’t reach its database right now. Try again in a minute.';
    }
  }

  /** The spreadsheet, only in a private chat (it holds descriptions of everyone logged). */
  private async report(m: InboundMessage): Promise<OutboundReply> {
    if (m.chatId.endsWith('@g.us')) return { text: 'Send *REPORT* to me in a private chat and I’ll send you the spreadsheet.' };
    const denied = await this.supervisorOnly(m, 'get the report');
    if (denied) return { text: denied };
    try {
      const rows = await listRecords({}, 10_000);
      if (!rows.length) return { text: 'Nothing is on record right now, so there’s no report.' };
      const stamp = new Date(this.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-');
      return {
        text: `📎 ${rows.length} record${rows.length === 1 ? '' : 's'}. Records are deleted automatically after ${getConfig().RETENTION_HOURS} hours; save this file if you need it.`,
        document: { data: Buffer.from('\ufeff' + recordsToCsv(rows), 'utf8'), mime: 'text/csv', fileName: `gatekeeper-${stamp}.csv` },
      };
    } catch (err) {
      console.error('[steward-bot] report failed:', (err as Error).message);
      return { text: '⚠️ Gatekeeper can’t reach its database right now. Try again in a minute.' };
    }
  }

  private async findBySeat(seatText: string) {
    const s = parseSeatAnswer(seatText.trim());
    if (!s) return { error: `Send the seat as section, row, seat, e.g. *52 YY 14*.` };
    const profile = await getTicketProfileBySeat(s.section!, s.row!, s.seat!);
    const label = `${s.section} ${s.row} ${s.seat}`;
    if (!profile) return { error: `Nothing on record for *${label}*.` };
    return { profile, label };
  }

  /** CLEAR 52 YY 14: a supervisor says this person may enter now. */
  private async clear(seatText: string, m: InboundMessage): Promise<string> {
    const denied = await this.supervisorOnly(m, 'clear someone');
    if (denied) return denied;
    try {
      const f = await this.findBySeat(seatText);
      if (!f.profile) return f.error!;
      if (f.profile.current_status === 'admitted') return `🟢 *${f.label}* is already cleared.`;
      const who = sanitize(m.senderName || 'a steward', 60);
      const when = formatClock(new Date(this.now()));
      const desc = f.profile.description && f.profile.description !== 'Not provided' ? `${f.profile.description} · ` : '';
      await updateRecord(f.profile.ticket_id, { status: 'admitted', description: `${desc}Cleared by ${who} ${when}`.slice(0, 2000) });
      return `🟢 *${f.label}* cleared by ${who} at ${when}: may enter if fit.\n_Send ${f.label} to check it, or log them again if needed._`;
    } catch (err) {
      console.error('[steward-bot] clear failed:', (err as Error).message);
      return '⚠️ Couldn’t clear that right now. Try again, or use the records page.';
    }
  }

  /** Photo captioned PHOTO 52 YY 14: add it to that record. */
  private async addPhoto(seatText: string, image: { data: Buffer; mime: string }): Promise<string> {
    try {
      const f = await this.findBySeat(seatText);
      if (!f.profile) return f.error!;
      await getPool().query('INSERT INTO ticket_photos (ticket_id, mime_type, data) VALUES ($1, $2, $3)', [f.profile.ticket_id, image.mime, image.data]);
      return `📷 Photo added to *${f.label}*. Anyone checking ${f.label} now gets it.`;
    } catch (err) {
      console.error('[steward-bot] photo failed:', (err as Error).message);
      return '⚠️ Couldn’t save that photo. Try again (photos up to 5 MB).';
    }
  }

  // ---------------------------------------------------------------- LIST

  /** Everyone currently refused or sent away, newest first, short enough for one WhatsApp message. */
  private async list(): Promise<string> {
    let rows: RecordRow[];
    try {
      rows = await listRecords({}, 500);
    } catch (err) {
      console.error('[steward-bot] list failed:', (err as Error).message);
      return '⚠️ Gatekeeper can’t reach its database right now. Try again in a minute.';
    }
    const now = new Date(this.now());
    const refused = rows.filter((r) => r.current_status === 'completely_refused');
    const away = rows.filter((r) => r.current_status === 'cooling_off' && r.cool_down_until && new Date(r.cool_down_until) > now);
    if (!refused.length && !away.length) return '✅ Nobody is refused or sent away right now.';

    const MAX = 30;
    const entry = (r: RecordRow, extra?: string) => {
      const seat = r.section ? `${r.section} ${r.row_label} ${r.seat_number}` : r.ticket_id;
      const head = [`• *${sanitize(seat, 40)}*`];
      if (r.reasoning && r.reasoning !== 'Not provided') head.push(sanitize(r.reasoning, 80));
      if (r.origin_hub) head.push(`${r.origin_hub.replace(' Hub', '')}${r.origin_at ? ` ${formatClock(r.origin_at)}` : ''}`);
      if (extra) head.push(extra);
      if (r.breaches) head.push(`🚨 tried again ×${r.breaches}`);
      if (r.photos) head.push('📷');
      const desc = r.description && r.description !== 'Not provided' ? `\n   👤 ${sanitize(r.description, 90)}` : '';
      return head.join(' · ') + desc;
    };
    const section = (title: string, list: RecordRow[], extra?: (r: RecordRow) => string) =>
      `${title} (${list.length})\n` +
      list.slice(0, MAX).map((r) => entry(r, extra?.(r))).join('\n') +
      (list.length > MAX ? `\n_…and ${list.length - MAX} more on the records page_` : '');

    const parts: string[] = [];
    if (refused.length) parts.push(section('🔴 *REFUSED*', refused));
    if (away.length) {
      parts.push(
        section('🟠 *SENT AWAY*', away, (r) => `back ${formatClock(r.cool_down_until!)} (${minutesUntil(r.cool_down_until!, now)} min)`),
      );
    }
    return `${parts.join('\n\n')}\n\n_Send a seat (e.g. *52 YY 14*) for details and the photo._`;
  }

  // ---------------------------------------------------------------- checking

  private async check(cmd: { kind: 'check'; ticketId: string } | { kind: 'check_seat'; section: string; row: string; seat: string; fallbackTicketId?: string }): Promise<OutboundReply> {
    try {
      let profile;
      if (cmd.kind === 'check') {
        profile = await getTicketProfile(cmd.ticketId);
      } else {
        profile = await getTicketProfileBySeat(cmd.section, cmd.row, cmd.seat);
        if (!profile && cmd.fallbackTicketId) profile = await getTicketProfile(cmd.fallbackTicketId);
      }
      const text = formatQuickCheck(profile, cmd.kind === 'check' ? { ticketId: cmd.ticketId } : cmd);
      if (!profile) return { text };
      const photo = await latestPhoto(profile.ticket_id);
      return photo ? { text, image: photo } : { text };
    } catch (err) {
      console.error('[steward-bot] lookup failed:', (err as Error).message);
      return { text: '⚠️ Gatekeeper can’t reach its database right now. Treat this seat as *unchecked* and ask a supervisor.' };
    }
  }
}

async function latestPhoto(ticketId: string): Promise<{ data: Buffer; mime: string } | null> {
  const { rows } = await getPool().query<{ data: Buffer; mime_type: string }>(
    'SELECT data, mime_type FROM ticket_photos WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 1',
    [ticketId],
  );
  return rows[0] ? { data: Buffer.from(rows[0].data), mime: rows[0].mime_type } : null;
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** "Male · Tall · Heavy · Adult · green hat" from whatever the steward gave. */
function describe(p: Pending): string {
  return [p.gender, p.height, p.build, p.age, p.clothing].filter(Boolean).join(' · ');
}

/** "Intoxicated, Abusive, Other: threw a bottle". */
function reasonText(p: Pending): string | undefined {
  if (!p.reasons?.length) return undefined;
  return p.reasons.map((r) => (r === 'Other' && p.otherReason ? `Other: ${p.otherReason}` : r)).join(', ');
}

function confirmation(o: ScanOutcome, hub: Hub, p: Pending): string {
  const t = o.ticket!;
  const seat = `${t.section ?? p.section} ${t.row_label ?? p.row} ${t.seat_number ?? p.seat}`;
  const when = formatClock(o.evaluatedAt);
  const reason = reasonText(p);
  const desc = describe(p);
  const notes = (reason ? `\n📝 ${sanitize(reason, 200)}` : '') + (desc ? `\n👤 ${sanitize(desc, 200)}` : '');
  const origin = o.originEvent;

  switch (o.scenario) {
    case 'HUB_HOP_BYPASS': {
      const left = t.current_status === 'cooling_off' && t.cool_down_until ? ` (${minutesUntil(t.cool_down_until, o.evaluatedAt)} min left)` : '';
      return (
        `🚨 *ALREADY ${t.current_status === 'cooling_off' ? 'SENT AWAY' : 'REFUSED'}* · ${seat}\n` +
        `First at *${origin?.hub_location ?? 'another hub'}* ${origin ? formatClock(origin.timestamp) : ''} by ${sanitize(origin?.steward_name ?? '?', 100)}${left}.\n` +
        `Logged as a second attempt at ${hub} ${when}. ⛔ Do not admit.`
      );
    }
    case 'REASSESSMENT':
      return `🔁 *Updated* · ${seat} is now ${t.current_status === 'cooling_off' ? `🟠 SENT AWAY until ${t.cool_down_until ? formatClock(t.cool_down_until) : '?'}` : '🔴 REFUSED'} (${hub} ${when}).${notes}`;
    default:
      return (
        (t.current_status === 'cooling_off'
          ? `✅ Logged 🟠 *SENT AWAY 30 MIN* · ${seat}\n${hub} ${when} · back after ${t.cool_down_until ? formatClock(t.cool_down_until) : '?'}`
          : `✅ Logged 🔴 *REFUSED* · ${seat}\n${hub} ${when}`) +
        notes +
        `\n_Reply UNDO within 15 min if this was a mistake._`
      );
  }
}

export const STEWARD_HELP =
  '🤖 *GATEKEEPER*\n\n' +
  '*Check a seat:* send section, row, seat, e.g. *52 YY 14*\n' +
  '*LIST*: everyone refused or sent away right now · *STATS*: tonight’s numbers\n' +
  'Photo captioned *PHOTO 52 YY 14*: add a photo to a saved record\n' +
  '_Group admins only:_ *CLEAR 52 YY 14* (may enter now) · *REPORT* in a private chat (the spreadsheet)\n\n' +
  '*Log someone:* send *REFUSED 52 YY 14 West* or *30 52 YY 14 West* (sent away 30 min), ' +
  'or a photo of them or their ticket QR with the seat as the caption, or just *LOG*.\n' +
  'I’ll then ask: hub, reasons, male/female, height, build, minor or adult, and what they’re wearing.\n' +
  '*BACK*: change your last answer · *CANCEL*: stop a log\n\n' +
  `*Reasons* (send one or more, e.g. *1 3 5*): ${REASONS.map((r, i) => `${i + 1} ${r}`).join(' · ')}\n\n` +
  '*UNDO*: remove your last saved record (within 15 min)\n' +
  '_Records are deleted automatically after 24 hours._';
