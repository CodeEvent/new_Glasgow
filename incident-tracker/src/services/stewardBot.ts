import { getConfig } from '../config/env';
import { getPool, isConnectivityError } from '../db/pool';
import { addNote, getNotes, listRecords, recordsToCsv, updateRecord, type RecordRow } from './adminRecords';
import type { AiContext, AiHelper, AiResult } from './aiAgent';
import { getSetting, setSetting } from '../channels/pgAuthState';
import { currentStats } from './nightReport';
import { HUBS, type Hub } from '../domain';
import { parseGroupMessage } from './commandParser';
import { formatClock, minutesUntil, sanitize } from './format';
import { appendOfflineIncident } from './offlineBuffer';
import { decodeQrFromImage, ticketCodeFromQr } from './qrImage';
import { readSeatsFromImage, seatsFromText, type SeatRef } from './ticketOcr';
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
  mentionsBot?: boolean; // the bot was @mentioned (group chats)
  audio?: { data: Buffer; mime: string } | null; // a voice note
}

export interface OutboundReply {
  text: string;
  image?: { data: Buffer; mime: string };
  document?: { data: Buffer; mime: string; fileName: string };
}

// ---------------------------------------------------------------- parsing

const DECISION_RE = /^\s*(ejected|eject|refused|refuse|ref|r|sent\s*away|sent|sa|30\s*min(?:ute)?s?|30|cool\s*-?\s*off|cooling\s*off|cooloff|cool)\b[\s:,-]*/i;
const HUB_RE = /^\s*(east|west|south|hosp(?:itality)?)(?:\s*hub)?\b[\s:,]*/i;
const SEAT_RE =
  /^\s*(?:(?:section|sect|sec|block|blk)\.?\s*)?([a-z0-9]{1,6})\s*[\s/,|]\s*(?:(?:row|rw)\.?\s*)?([a-z0-9]{1,4})\s*[\s/,|]\s*(?:(?:seat|st)\.?\s*)?(\d{1,4})\b[\s:,]*/i;

const PARTY_RE = /(?:^|\s)(?:x(\d{1,2})|(?:party|group)(?:\s+of)?\s+(\d{1,2}))(?=\s|$|[,.])/i;

export function parseDecision(word: string): Decision | null {
  const m = DECISION_RE.exec(word);
  if (!m) return null;
  return /^(refused|refuse|ref|r|ejected|eject)$/i.test(m[1].trim()) ? 'refused' : 'cool_off';
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
  ejected?: boolean; // removed from inside the venue (stored as refused, marked "Ejected")
  party?: number; // people in the group ("x3", "party of 3")
  extraSeats?: string[]; // more seats in the same row: one record each ("300 L 205 206 207")
  groupSeats?: SeatRef[]; // several seats across rows (from a ticket photo): one record each
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
  if (/^eject/i.test(d[1])) out.ejected = true;

  const s = SEAT_RE.exec(rest);
  if (s) {
    out.section = s[1].toUpperCase();
    out.row = s[2].toUpperCase();
    out.seat = s[3];
    rest = rest.slice(s[0].length);
    const more = takeExtraSeats(s[3], rest, false);
    if (more.seats.length) {
      out.extraSeats = more.seats;
      rest = more.rest;
    }
  } else if (short) {
    return null;
  }
  const h = HUB_RE.exec(rest);
  if (h) {
    out.hub = parseHub(h[1])!;
    rest = rest.slice(h[0].length);
  }
  // Party size anywhere after the seat: "x3", "party of 3", "group 3".
  const party = PARTY_RE.exec(rest);
  if (party) {
    out.party = Number(party[1] ?? party[2]);
    rest = (rest.slice(0, party.index) + ' ' + rest.slice(party.index + party[0].length)).replace(/\s+/g, ' ').trim();
  }
  return Object.assign(out, parseDetails(rest));
}

/** A bare seat as an answer to "which seat?": "BB 212 100", "BB/212/100", "Section BB Row 212 Seat 100". */
export function parseSeatAnswer(text: string): Pick<ParsedLog, 'section' | 'row' | 'seat' | 'extraSeats'> | null {
  const s = SEAT_RE.exec(text);
  if (!s) return null;
  const more = takeExtraSeats(s[3], text.slice(s[0].length), true);
  if (more.rest.trim()) return null;
  return { section: s[1].toUpperCase(), row: s[2].toUpperCase(), seat: s[3], ...(more.seats.length ? { extraSeats: more.seats } : {}) };
}

const MAX_GROUP = 20;

/**
 * More seats in the same row after the first: "206 207", ", 206 and 207", "-207" (a range).
 * In a log line (bare=false) a number only counts as a seat if it's within 30 of the first,
 * and 1-6 after a bigger seat number are left alone: they're reasons ("300 L 205 1 2").
 */
export function takeExtraSeats(first: string, text: string, bare: boolean): { seats: string[]; rest: string } {
  const start = Number(first);
  const seats: string[] = [];
  const add = (n: number) => {
    const v = String(n);
    if (v !== first && !seats.includes(v) && seats.length < MAX_GROUP - 1) seats.push(v);
  };
  const near = (n: number) => bare || (Math.abs(n - start) <= 30 && !(n <= 6 && start > 10));
  let rest = text;
  const range = /^\s*[-–]\s*(\d{1,4})(?=[\s,.&+]|$)/.exec(rest); // "205-207"
  if (range && Number(range[1]) > start && Number(range[1]) - start <= 100) {
    for (let n = start + 1; n <= Number(range[1]); n++) add(n);
    rest = rest.slice(range[0].length);
  }
  for (;;) {
    const m = /^[\s,&+]*(?:and\s+)?(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?(?=[\s,.&+]|$)/i.exec(rest);
    if (!m || !near(Number(m[1]))) break;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > 100) break;
    for (let n = a; n <= b; n++) add(n);
    rest = rest.slice(m[0].length);
  }
  return { seats, rest: rest.replace(/^[\s,:]*/, '') };
}

// ---------------------------------------------------------------- conversation state

type Field = 'decision' | 'choose' | 'seat' | 'hub' | 'reasons' | 'other' | 'describe' | 'gender' | 'height' | 'build' | 'age' | 'clothing' | 'confirm';

interface Pending extends ParsedLog {
  editTicketId?: string; // EDIT: re-asking the details of a saved record
  editLabel?: string;
  choices?: SeatRef[]; // seats read from a ticket photo, waiting for the steward to pick
  aiDraft?: boolean; // filled in by the AI helper: the steward must confirm before saving
  confirmed?: boolean;
  seatLookedUp?: string; // seat already checked against existing records (warned once)
  describeFallback?: boolean; // the AI couldn't read the description: ask the numbered questions
  reentry?: boolean; // the seat is already refused or sent away: this is a re-entry attempt
  otherReason?: string; // what happened, when "Other" is one of the reasons ('' = skipped)
  ticketCode?: string;
  photo?: { data: Buffer; mime: string };
  asked?: Field;
  /** Questions asked so far, each with the answers as they were just before it, so BACK can rewind. */
  history?: Array<{ field: Field; before: Answers }>;
  startedAt: number;
}

const ANSWER_KEYS = ['decision', 'section', 'row', 'seat', 'extraSeats', 'groupSeats', 'hub', 'reasons', 'otherReason', 'gender', 'height', 'build', 'age', 'clothing'] as const;
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
  ticketIds: string[]; // a group log creates one record per seat
  createdTicket: boolean;
  at: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const HUB_MEMORY_MS = 12 * 60 * 60_000;
const UNDO_WINDOW_MS = 15 * 60_000;

const numbered = (opts: readonly string[]) => opts.map((o, i) => `*${i + 1}* ${o}`).join('\n');
const SKIP = '\n_(*-* to skip)_';

const PROMPTS: Record<Field, string> = {
  decision: 'Refused entry, sent away for 30 minutes, or ejected? Reply with a number:\n*1* Refused entry\n*2* Sent away 30 min\n*3* Ejected (removed from inside)',
  seat: 'Which seat? Send section, row and seat, e.g. *52 YY 14*.',
  hub: `Which hub are you at? Reply with a number:\n${numbered(HUBS.map((h) => h.replace(' Hub', '')))}`,
  reasons: `Reason? Reply with a number:\n${numbered(REASONS)}\n_More than one? Send all the numbers, e.g. *1 3 5*_`,
  other: 'You picked *Other*. What happened? Describe it in your own words.',
  gender: `Male or female? Reply *M* or *F*.${SKIP}`,
  height: `Height? Reply with a number:\n${numbered(HEIGHTS)}${SKIP}`,
  build: `Build? Reply with a number:\n${numbered(BUILDS)}${SKIP}`,
  age: `Minor or adult? Reply with a number:\n*1* Adult\n*2* Minor (under 18)${SKIP}`,
  clothing: 'What are they wearing? e.g. *green hat, black jacket*. Reply *-* to skip.',
  confirm: 'Reply *YES* to save it, or *CANCEL*.', // the summary is added in prompt()
  choose: 'Which seats? Reply with the numbers, e.g. *1 3*, or *ALL*:', // the list is added in prompt()
  describe:
    'Describe them in your own words: male/female, height, build, age, clothing.\ne.g. *tall heavy lad about 20, green hat, black jacket*\n_(*-* to skip)_',
};

export class StewardBot {
  private pending = new Map<string, Pending>();
  private hubs = new Map<string, { hub: Hub; at: number }>();
  private lastLogs = new Map<string, LastLog>();
  /** A sender's last uncaptioned photo, so "PHOTO 52 YY 14" sent right after it still works. */
  private loosePhotos = new Map<string, { image: { data: Buffer; mime: string }; at: number }>();
  /** Seats from a SCAN photo, used by a decision ("REFUSED West 1") sent within 5 minutes. */
  private lastScans = new Map<string, { seats: SeatRef[]; at: number }>();
  /** Reads seats from a ticket image; defaults to on-device OCR (OCR_ENABLED). */
  ocr?: (image: Buffer) => Promise<SeatRef[]>;

  private async seatsFromPhoto(image: Buffer, qr: string | null): Promise<SeatRef[]> {
    const fromQr = qr ? seatsFromText(qr) : [];
    if (fromQr.length) return fromQr;
    const ocr = this.ocr ?? (getConfig().OCR_ENABLED ? readSeatsFromImage : undefined);
    return ocr ? ocr(image) : [];
  }

  /** Optional AI helper (plain-English questions and logs); set when ANTHROPIC_API_KEY is configured. */
  ai?: AiHelper;
  /** Hub for the whole shift ("HUB WEST"), per steward, for 12 hours. */
  private shiftHubs = new Map<string, { hub: Hub; at: number }>();

  private shiftHub(senderId: string): Hub | undefined {
    const h = this.shiftHubs.get(senderId);
    return h && this.now() - h.at < HUB_MEMORY_MS ? h.hub : undefined;
  }

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
    if (field === 'choose') {
      const list = (p.choices ?? []).map((c, i) => `*${i + 1}* ${c.section} ${c.row} ${c.seat}`).join('\n');
      return `${PROMPTS.choose}\n${list}\n_*CANCEL* to stop_`;
    }
    if (field === 'confirm') return `${draftSummary(p)}\n${PROMPTS.confirm}\n_After saving you can still change it with *EDIT ${p.section} ${p.row} ${p.seat}*._`;
    let text = PROMPTS[field];
    if (field === 'hub' && p.reentry) text = text.replace('Which hub are you at?', '🚨 Which hub are they trying to get in at?');
    const shift = field === 'hub' ? this.shiftHub(senderId) : undefined;
    const last = field === 'hub' && !shift ? this.rememberedHub(senderId) : undefined;
    if (shift) text += `\n_Your shift hub: *${shift.replace(' Hub', '')}* (reply *${HUBS.indexOf(shift) + 1}*)_`;
    else if (last) text += `\n_Last time: *${last.replace(' Hub', '')}* (reply *${HUBS.indexOf(last) + 1}*)_`;
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
    if (/^(help|\?|menu)$/i.test(text)) return [{ text: helpText(!!this.ai, getConfig().WA_PRIVATE_CHATS) }];
    // ---- voice notes: private chats only (in a group they could be anyone's chat)
    if (m.audio) {
      if (m.chatId.endsWith('@g.us')) return [];
      if (!this.ai?.handleAudio) return [{ text: '🎙️ Voice notes need the Gemini AI helper. Type it instead, or ask the organiser to set it up.' }];
      return this.fromAi(m, k, await this.ai.handleAudio(m.audio.data, m.audio.mime, m.senderId));
    }
    const hubCmd = /^hub(?:\s+(.+))?$/i.exec(text);
    if (hubCmd) return this.hubCommand(m, k, hubCmd[1]?.trim());
    const policyCmd = /^policy(?:\s+([\s\S]+))?$/i.exec(text);
    if (policyCmd) return [{ text: await this.policyCommand(m, policyCmd[1]?.trim()) }];
    const adviceCmd = /^(?:(?:gk|gatekeeper|ai)\b[\s,:;-]*)?advice\b[\s,:;-]*([\s\S]*)$/i.exec(text);
    if (adviceCmd) return [{ text: await this.advice(m, adviceCmd[1].trim()) }];
    if (/^list$/i.test(text)) return [{ text: await this.list() }];
    if (/^stats$/i.test(text)) return [{ text: await this.stats() }];
    if (/^report$/i.test(text)) return [await this.report(m)];
    const find = /^(?:find|search)\s+(.+)$/i.exec(text);
    if (find && !m.image) return [{ text: await this.find(find[1]) }];
    const note = /^note\s+(.+)$/i.exec(text);
    if (note && !m.image) return [{ text: await this.note(note[1], m) }];
    const party = /^party\s+(.+)$/i.exec(text);
    if (party && !m.image) return [{ text: await this.setParty(party[1]) }];
    const edit = /^edit\s+(.+)$/i.exec(text);
    if (edit && !m.image) return this.startEdit(edit[1], m, k);
    const clear = /^clear\s+(.+)$/i.exec(text);
    if (clear && !m.image) return [{ text: await this.clear(clear[1], m) }];
    const photoCmd = /^photo\s+(.+)$/i.exec(text);
    if (photoCmd) {
      const loose = this.loosePhotos.get(k);
      const image = m.image ?? (loose && this.now() - loose.at < 5 * 60_000 ? loose.image : null);
      if (!image) return [{ text: `Send the customer's photo with the caption *PHOTO ${sanitize(photoCmd[1], 30)}* (or send the photo, then this message).` }];
      const reply = await this.addPhoto(photoCmd[1], image);
      if (!m.image && reply.startsWith('📷')) this.loosePhotos.delete(k);
      return [{ text: reply }];
    }

    // ---- images: a ticket QR starts (or feeds) a log; another photo is the customer's picture.
    if (m.image) {
      const qr = await decodeQrFromImage(m.image.data);
      // SCAN: read the seats on a ticket and check them.
      if (/^(scan|ticket)$/i.test(text)) {
        const seats = await this.seatsFromPhoto(m.image.data, qr);
        if (!seats.length) return [{ text: '🎫 I couldn’t read a seat on that ticket. Send it as text instead, e.g. *52 YY 14*.' }];
        this.lastScans.set(k, { seats, at: this.now() });
        return [{ text: `${await this.checkSeats(seats)}\n_To log these, send *REFUSED*, *30* or *EJECTED* (with the hub) in the next 5 minutes._` }];
      }
      const log = parseLogCommand(text) ?? (parseSeatAnswer(text) || (/^(log|new)$/i.test(text) ? {} : null));
      // A ticket photo with a few words ("drunk, swearing, green hat, West"): the seat is read on the
      // phone, only the words go to the AI. In a group, only when the photo really shows a seat.
      const words = text.split(/\s+/).filter(Boolean).length;
      const plainEnglish = !log || (!log.section && ((log as ParsedLog).clothing ?? '').split(/\s+/).length >= 3);
      if (this.ai && !p && words >= 3 && plainEnglish) {
        const seats = await this.seatsFromPhoto(m.image.data, qr);
        if (seats.length || !m.chatId.endsWith('@g.us')) {
          return this.fromAi(m, k, await this.ai.handle(text, m.senderId, { seats }), seats, text);
        }
      }
      if (!qr && !log && !p) {
        // An ordinary photo: stay quiet, but keep it a few minutes in case "PHOTO <seat>" follows.
        for (const [key, v] of this.loosePhotos) if (this.now() - v.at > 5 * 60_000) this.loosePhotos.delete(key);
        this.loosePhotos.set(k, { image: m.image, at: this.now() });
        return [];
      }
      p = p ?? { startedAt: this.now() };
      if (qr) p.ticketCode = await ticketCodeFromQr(qr);
      if (log) Object.assign(p, defined(log));
      let intro = qr ? '🎟️ Ticket QR read.' : '';
      // No seat yet: it's probably a photo of the ticket, so read the seat from it.
      const seats = !p.seat && !p.choices && !p.editTicketId ? await this.seatsFromPhoto(m.image.data, qr) : [];
      if (seats.length) {
        setSeats(p, seats);
        intro = [intro, seats.length === 1 ? `🎫 Seat from the ticket: *${seats[0].section} ${seats[0].row} ${seats[0].seat}*.` : '🎫 The ticket shows several seats.'].filter(Boolean).join(' ');
      } else if (!qr) {
        p.photo = m.image; // the customer's picture
        intro = '📷 Photo saved.';
      }
      this.pending.set(k, p);
      return this.advance(m, p, intro);
    }

    // ---- text that starts a log: "REFUSED BB 212 100 West very drunk"
    const log = parseLogCommand(text);
    // "refused drunk lad in a green hat at West, seat 313 YY 56": plain English, let the AI read it.
    if (log && this.ai && !log.section && (log.clothing ?? '').split(/\s+/).length >= 3) return this.askAi(m, text, k);
    if (log) {
      const scan = this.lastScans.get(k);
      if (!log.section && scan && this.now() - scan.at < 5 * 60_000) {
        this.lastScans.delete(k);
        setSeats(log, scan.seats, true);
      }
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
      // A bare seat while the log already has its seat: they want to check it, not answer.
      // Only for a seat that is on record (or this log's own): "3 4 5" or "1 M 3" are answers.
      const seat = p.asked !== 'seat' && p.asked !== 'other' && p.seat ? parseSeatAnswer(text) : null;
      if (seat) {
        const own = `${seat.section} ${seat.row} ${seat.seat}` === `${p.section} ${p.row} ${p.seat}`;
        const known = own || (await getTicketProfileBySeat(seat.section!, seat.row!, seat.seat!).catch(() => null));
        if (known) {
          const check = await this.check({ kind: 'check_seat', section: seat.section!, row: seat.row!, seat: seat.seat! });
          const still = `_You’re still logging ${p.section} ${p.row} ${p.seat}. Answer the question below, or send CANCEL._\n${this.prompt(p.asked ?? this.nextMissing(p) ?? 'reasons', p, m.senderId)}`;
          return [check, { text: still }];
        }
      }
      if (p.asked === 'describe') {
        await this.answerDescribe(p, text, m.senderId);
        return this.advance(m, p);
      }
      const answered = this.applyAnswer(p, text);
      if (answered) return this.advance(m, p);
      return [{ text: this.prompt(p.asked ?? this.nextMissing(p) ?? 'reasons', p, m.senderId) }];
    }

    // ---- the AI helper, when addressed: "GK how many refused at West?" or an @mention
    const addressed = /^(?:gk|gatekeeper|ai)\b[\s,:;-]*/i.exec(text);
    if (this.ai && (addressed || m.mentionsBot)) {
      const question = addressed ? text.slice(addressed[0].length) : text;
      if (question.trim()) return this.askAi(m, question, k);
    }

    // ---- several seats at once: "300 L 205 206 207"
    const many = parseSeatAnswer(text);
    if (many?.extraSeats) return [{ text: await this.checkSeats([many.seat!, ...many.extraSeats].map((seat) => ({ section: many.section!, row: many.row!, seat }))) }];

    // ---- part of a seat: "313 L" (section and row), "313" or "SECTION 313"
    const partial = parsePartialSeat(text);
    if (partial) {
      const reply = await this.searchSeats(partial.section, partial.row, partial.explicit);
      return reply ? [{ text: reply }] : [];
    }

    // ---- a check: "BB 212 100" or "Check TM-…"
    const cmd = parseGroupMessage(text);
    if (!cmd) {
      // In a private chat, anything else goes to the AI helper (if it's on).
      if (this.ai && !m.chatId.endsWith('@g.us') && text.length > 2) return this.askAi(m, text, k);
      return [];
    }
    if (cmd.kind === 'help') return [{ text: STEWARD_HELP }];
    if (cmd.kind === 'invalid_check') return [];
    return [await this.check(cmd)];
  }

  private applyAnswer(p: Pending, text: string): boolean {
    const asked = p.asked;
    if (!text) return false;
    if (asked === 'choose') {
      const choices = p.choices ?? [];
      let picked: SeatRef[] = [];
      if (/^(all|every|\*)$/i.test(text)) picked = choices;
      else {
        const nums = text.split(/[\s,&]+|\band\b/i).filter(Boolean);
        if (!nums.length || !nums.every((n) => /^\d+$/.test(n) && Number(n) >= 1 && Number(n) <= choices.length)) return false;
        picked = [...new Set(nums.map(Number))].map((n) => choices[n - 1]);
      }
      if (!picked.length) return false;
      setSeats(p, picked, true);
      return true;
    }
    if (asked === 'decision' || (!asked && !p.decision)) {
      if (/^3$/.test(text) || /^eject(ed)?$/i.test(text)) return (p.decision = 'refused'), (p.ejected = true), true;
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
    if (asked === 'confirm') {
      if (!/^(yes|y|yep|ok|okay|save|confirm|correct)[.!]*$/i.test(text)) return false;
      p.confirmed = true;
      return true;
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
    if (p.editTicketId) {
      if (!p.reasons?.length) return 'reasons';
      if (p.reasons.includes('Other') && p.otherReason === undefined) return 'other';
      for (const f of DESCRIPTION_FIELDS) if (p[f] === undefined) return f;
      return null;
    }
    if (!p.decision) return 'decision';
    if (!p.seat && p.choices?.length) return 'choose';
    if (!p.seat) return 'seat';
    if (!p.hub) return 'hub';
    if (!p.reasons?.length) return 'reasons';
    if (p.reasons.includes('Other') && p.otherReason === undefined) return 'other';
    // With the AI on, one free-text question replaces the five numbered ones.
    if (this.ai?.describe && !p.describeFallback && DESCRIPTION_FIELDS.every((f) => p[f] === undefined)) return 'describe';
    for (const f of DESCRIPTION_FIELDS) if (p[f] === undefined) return f;
    if (p.aiDraft && !p.confirmed) return 'confirm';
    return null;
  }

  private async advance(m: InboundMessage, p: Pending, intro?: string): Promise<OutboundReply[]> {
    // Look the seat up first: someone already refused or sent away is trying to get back in.
    const warning = await this.alreadyOnRecord(p);
    // "HUB WEST" for the shift, but for a re-entry ask where they're trying now.
    if (!p.hub && !p.editTicketId && !p.reentry) p.hub = this.shiftHub(m.senderId);
    const missing = this.nextMissing(p);
    if (missing) {
      p.asked = missing;
      p.history ??= [];
      if (p.history[p.history.length - 1]?.field !== missing) p.history.push({ field: missing, before: snapshot(p) });
      const q = this.prompt(missing, p, m.senderId);
      const ask = intro ? `${intro} ${q}` : q;
      return [{ text: warning ? `${warning}\n${ask}` : ask }];
    }
    this.pending.delete(this.key(m));
    return [{ text: p.editTicketId ? await this.commitEdit(p) : await this.commit(m, p) }];
  }

  /** Once per log, as soon as the seat is known: warn if that seat is already refused or sent away. */
  private async alreadyOnRecord(p: Pending): Promise<string | null> {
    if (p.editTicketId || !p.seat) return null;
    const seats = seatList(p);
    const label = seatsLabel(seats);
    if (p.seatLookedUp === label) return null;
    p.seatLookedUp = label;
    try {
      const found: string[] = [];
      for (const s of seats) {
        const prof = await getTicketProfileBySeat(s.section, s.row, s.seat);
        if (prof && prof.current_status !== 'admitted') {
          p.reentry = true;
          found.push(formatQuickCheck(prof, s).split('\n').slice(0, seats.length > 1 ? 1 : 2).join('\n'));
        }
      }
      if (!found.length) return null;
      return `⚠️ *Already on record:*\n${found.join('\n')}\n_Only wanted to check? Send *CANCEL*. Carrying on logs a new attempt._\n`;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- saving

  private async commitEdit(p: Pending): Promise<string> {
    const reason = reasonText(p) ?? 'Not provided';
    const desc = describe(p) || 'Not provided';
    try {
      const ok = await updateRecord(p.editTicketId!, { reasoning: reason, description: desc });
      if (!ok) return `That record is gone (deleted or expired). Log *${p.editLabel}* again if needed.`;
      if (p.photo) {
        await getPool().query('INSERT INTO ticket_photos (ticket_id, mime_type, data) VALUES ($1, $2, $3)', [p.editTicketId, p.photo.mime, p.photo.data]);
      }
      return `✏️ *Updated* · ${p.editLabel}\n📝 ${sanitize(reason, 200)}\n👤 ${sanitize(desc, 200)}`;
    } catch (err) {
      console.error('[steward-bot] edit failed:', (err as Error).message);
      return '⚠️ Couldn’t save that change. Try again, or use the records page.';
    }
  }

  private async commit(m: InboundMessage, p: Pending): Promise<string> {
    if (p.extraSeats?.length || (p.groupSeats?.length ?? 0) > 1) return this.commitGroup(m, p);
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
      party_size: p.party,
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
      this.lastLogs.set(m.senderId, { ticketIds: [ticket.ticket_id], createdTicket: true, at: this.now() });
    }
    if (outcome.previousStatus && outcome.previousStatus !== 'admitted') {
      ticket.reasoning = await addReentryReason(ticket.ticket_id, ticket.reasoning, outcome.previousStatus, reasonText(p));
    }
    const reply = confirmation(outcome, hub, p);
    if (outcome.scenario === 'HUB_HOP_BYPASS' && getConfig().WA_HUBHOP_ALERTS) {
      // The steward who logged it sees the reply; everyone else in the other chats gets the alert.
      this.announce?.(`${reply}\n_Logged by ${sanitize(m.senderName || 'a steward', 60)}._`, m.chatId);
    }
    return reply;
  }

  /** "300 L 205 206 207": one record per seat with the same answers, marked as a group. */
  private async commitGroup(m: InboundMessage, p: Pending): Promise<string> {
    const hub = p.hub!;
    this.hubs.set(m.senderId, { hub, at: this.now() });
    const at = (m.at ?? new Date(this.now())).toISOString();
    const seats = seatList(p);
    const party = Math.max(p.party ?? 1, seats.length);
    const created: string[] = [];
    const hops: string[] = [];
    const failed: string[] = [];
    let offline = false;
    for (const [i, s] of seats.entries()) {
      const seat = s.seat;
      const parsed = scanInputSchema.safeParse({
        ticket_id: i === 0 ? p.ticketCode : undefined, // a scanned QR belongs to the first seat
        section: s.section,
        row: s.row,
        seat,
        hub_location: hub,
        steward_name: (m.senderName || 'Steward').slice(0, 100),
        action_logged: p.decision,
        party_size: party,
        description: describe(p) || undefined,
        reasoning: reasonText(p),
        occurred_at: at,
      });
      if (!parsed.success) {
        failed.push(`${s.section} ${s.row} ${seat}`);
        continue;
      }
      try {
        const o = await processScan(parsed.data);
        const t = o.ticket!;
        if (o.previousStatus && o.previousStatus !== 'admitted') {
          t.reasoning = await addReentryReason(t.ticket_id, t.reasoning, o.previousStatus, reasonText(p));
        }
        if (o.scenario === 'NEW_INCIDENT' && !o.previousStatus) created.push(t.ticket_id);
        if (p.photo) {
          await getPool()
            .query('INSERT INTO ticket_photos (ticket_id, mime_type, data) VALUES ($1, $2, $3)', [t.ticket_id, p.photo.mime, p.photo.data])
            .catch((err) => console.error('[steward-bot] photo not saved:', (err as Error).message));
        }
        if (o.scenario === 'HUB_HOP_BYPASS') {
          const origin = o.originEvent;
          hops.push(
            `🚨 *${s.section} ${s.row} ${seat}* was already ${t.current_status === 'cooling_off' ? 'SENT AWAY' : 'REFUSED'}` +
              ` at ${origin?.hub_location ?? 'another hub'}${origin ? ` ${formatClock(origin.timestamp)}` : ''}. ⛔ Do not admit.`,
          );
        }
      } catch (err) {
        if (isConnectivityError(err)) {
          appendOfflineIncident(parsed.data, (err as Error).message);
          offline = true;
        } else {
          console.error('[steward-bot] save failed:', err);
          failed.push(`${s.section} ${s.row} ${seat}`);
        }
      }
    }
    if (created.length) this.lastLogs.set(m.senderId, { ticketIds: created, createdTicket: true, at: this.now() });

    const label = seatsLabel(seats);
    const when = formatClock(new Date(this.now()));
    const head =
      p.decision === 'cool_off'
        ? `✅ Logged 🟠 *SENT AWAY 30 MIN* · ${label}\n${hub} ${when} · back after ${formatClock(new Date(this.now() + getConfig().COOL_OFF_MINUTES * 60_000))}`
        : `✅ Logged ${p.ejected ? '⛔ *EJECTED*' : '🔴 *REFUSED*'} · ${label}\n${hub} ${when}`;
    const reason = reasonText(p);
    const desc = describe(p);
    const lines = [head];
    if (reason) lines.push(`📝 ${sanitize(reason, 200)}`);
    if (desc) lines.push(`👤 ${sanitize(desc, 200)}`);
    lines.push(`👥 Group of ${party}`);
    lines.push(...hops);
    if (offline) lines.push('⚠️ Database offline: saved on the server and will sync automatically.');
    if (failed.length) lines.push(`⚠️ Couldn't save seat${failed.length > 1 ? 's' : ''} ${failed.join(', ')}. Send ${failed.length > 1 ? 'them' : 'it'} again.`);
    lines.push('_Reply UNDO within 15 min if this was a mistake (removes the whole group)._');
    const reply = lines.join('\n');
    if (hops.length && getConfig().WA_HUBHOP_ALERTS) {
      this.announce?.(`${hops.join('\n')}\n_Logged by ${sanitize(m.senderName || 'a steward', 60)} at ${hub}._`, m.chatId);
    }
    return reply;
  }

  private async undo(senderId: string): Promise<string> {
    const last = this.lastLogs.get(senderId);
    if (!last || this.now() - last.at > UNDO_WINDOW_MS) return 'Nothing to undo. You can undo a new record within 15 minutes.';
    this.lastLogs.delete(senderId);
    const { rowCount } = await getPool().query('DELETE FROM tickets WHERE ticket_id = ANY($1::text[])', [last.ticketIds]);
    if (!rowCount) return 'That record was already gone.';
    return rowCount > 1 ? `↩️ Removed your last record (${rowCount} seats).` : '↩️ Removed your last record.';
  }

  // ---------------------------------------------------------------- AI helper

  private async askAi(m: InboundMessage, text: string, k: string): Promise<OutboundReply[]> {
    return this.fromAi(m, k, await this.ai!.handle(text, m.senderId), undefined, text);
  }

  /**
   * Turns an AI result into a reply; a draft becomes a log to confirm. `seats` read from a
   * ticket photo win over anything the AI says about seats. `said` is the steward's own words,
   * used for a policy suggestion when they didn't say refused or sent away.
   */
  private async fromAi(m: InboundMessage, k: string, res: AiResult, seats?: AiContext['seats'], said?: string): Promise<OutboundReply[]> {
    // Voice notes: show what was heard, so the steward can spot a mishearing.
    const heardLine = res.kind !== 'error' && res.heard ? `🎙️ I heard: “${sanitize(res.heard, 400)}”\n` : '';
    if (res.kind !== 'draft') return [{ text: res.kind === 'answer' ? `${heardLine}🤖 ${res.text}` : res.text }];
    if (res.heard && said === undefined) said = res.heard; // the decision rule applies to what they said
    const d = res.draft;
    const p: Pending = {
      startedAt: this.now(),
      aiDraft: true,
      decision: d.decision,
      ejected: d.ejected || undefined,
      section: d.section,
      row: d.row,
      seat: d.seat,
      hub: d.hub,
      reasons: d.reasons,
      otherReason: d.otherReason,
      party: d.party,
      // Description details the steward didn't mention are left blank, not asked.
      gender: d.gender ?? '',
      height: d.height ?? '',
      build: d.build ?? '',
      age: d.age ?? '',
      clothing: d.clothing ?? '',
    };
    // The decision is the steward's: keep the AI's only if their own words say it.
    if (said && !DECISION_WORDS.test(said)) {
      delete p.decision;
      delete p.ejected;
    }
    const intro: string[] = [];
    if (seats?.length) {
      setSeats(p, seats);
      intro.push(seats.length === 1 ? `🎫 Seat from the ticket: *${seats[0].section} ${seats[0].row} ${seats[0].seat}*.` : '🎫 The ticket shows several seats.');
    }
    if (heardLine) intro.push(heardLine.trim());
    intro.push('🤖 Got it.');
    if (!p.decision && said && this.ai?.advise) {
      const policy = await this.policy();
      if (policy) {
        const adv = await this.ai.advise(said, policy.text, m.senderId);
        if (adv.kind === 'answer') intro.push(`\n🤖 Policy suggests: ${adv.text}\n_You decide._\n`);
      }
    }
    this.pending.set(k, p);
    return this.advance(m, p, intro.join(' '));
  }

  // ---------------------------------------------------------------- HUB, describe, POLICY, ADVICE

  private async hubCommand(m: InboundMessage, k: string, arg?: string): Promise<OutboundReply[]> {
    if (!arg) {
      const h = this.shiftHub(m.senderId);
      return [{ text: h ? `🏟️ Your hub this shift: *${h}*. *HUB OFF* to stop.` : 'No hub set for your shift. Send e.g. *HUB WEST* and I won’t ask again for 12 hours.' }];
    }
    if (/^(off|clear|none|stop)$/i.test(arg)) {
      this.shiftHubs.delete(m.senderId);
      return [{ text: '🏟️ Shift hub cleared. I’ll ask which hub each time.' }];
    }
    const n = /^([1-4])$/.exec(arg);
    const hub = n ? HUBS[Number(n[1]) - 1] : parseHub(arg);
    if (!hub || (!n && arg.replace(HUB_RE, '').trim())) return [{ text: 'Send *HUB* and one of East, West, South or Hospitality, e.g. *HUB WEST*.' }];
    this.shiftHubs.set(m.senderId, { hub, at: this.now() });
    this.hubs.set(m.senderId, { hub, at: this.now() });
    const text = `🏟️ Your hub is *${hub}* for this shift (12 hours). I won’t ask again. *HUB OFF* to stop.`;
    // If a log is waiting for its hub, carry on with it.
    const p = this.pending.get(k);
    if (p && p.asked === 'hub') {
      p.hub = hub;
      const [next] = await this.advance(m, p);
      return [{ text: `${text}\n\n${next.text}` }];
    }
    return [{ text }];
  }

  /** "Describe them": short codes are read here; plain words go to the AI; numbered questions if it can't. */
  private async answerDescribe(p: Pending, text: string, senderId: string): Promise<void> {
    if (/^[-–—]+$/.test(text)) {
      for (const f of DESCRIPTION_FIELDS) p[f] = '';
      return;
    }
    const local = parseDetails(text, 'gender');
    if (local.gender !== undefined) {
      for (const f of DESCRIPTION_FIELDS) p[f] = local[f] ?? '';
      return;
    }
    const d = this.ai?.describe ? await this.ai.describe(text, senderId).catch(() => null) : null;
    if (!d) {
      p.describeFallback = true;
      return;
    }
    for (const f of DESCRIPTION_FIELDS) p[f] = d[f] ?? '';
  }

  private policy() {
    return getSetting<{ text: string; by: string; at: string } | null>('refusal_policy', null);
  }

  private async policyCommand(m: InboundMessage, arg?: string): Promise<string> {
    if (!arg) {
      const pol = await this.policy();
      return pol ? `📋 *Refusal policy* (set by ${sanitize(pol.by, 60)}):\n${sanitize(pol.text, 3000)}` : 'No refusal policy set yet. A group admin can set it with *POLICY* followed by your rules.';
    }
    const denied = await this.supervisorOnly(m, 'set the policy');
    if (denied) return denied;
    if (/^(off|clear|none)$/i.test(arg)) {
      await setSetting('refusal_policy', null);
      return '📋 Policy cleared.';
    }
    await setSetting('refusal_policy', { text: arg.slice(0, 4000), by: (m.senderName || 'an admin').slice(0, 60), at: new Date(this.now()).toISOString() });
    return '✅ Policy saved. Stewards can now ask *ADVICE* and what they see, e.g. *ADVICE slurring, unsteady, polite*.';
  }

  private async advice(m: InboundMessage, situation: string): Promise<string> {
    if (!this.ai?.advise) return '🤖 Advice needs the AI helper. Ask the organiser to set it up.';
    if (!situation) return 'Describe what you see after *ADVICE*, e.g. *ADVICE slurring, unsteady, polite*.';
    const pol = await this.policy();
    if (!pol) return 'No refusal policy set yet. A group admin can set it with *POLICY* followed by your rules.';
    const res = await this.ai.advise(situation, pol.text, m.senderId);
    if (res.kind === 'draft') return '🤖 Sorry, I couldn’t work that out. Ask a supervisor.';
    if (res.kind === 'error') return res.text;
    return `🤖 ${res.text}\n_You decide: this is only a suggestion from the venue policy. If unsure, ask a supervisor._`;
  }

  // ---------------------------------------------------------------- FIND, NOTE, PARTY, EDIT

  /** FIND green hat: search tonight's records by description, reason, notes or seat. */
  private async find(query: string): Promise<string> {
    const q = query.trim().replace(/\s+/g, ' ');
    if (q.length < 2) return 'Send a few words to search for, e.g. *FIND green hat*.';
    try {
      const rows = await listRecords({ q: q.slice(0, 100) }, 50);
      if (!rows.length) return `🔎 Nothing on record matches “${sanitize(q, 60)}”.`;
      const now = new Date(this.now());
      const shown = rows.slice(0, 10).map((r) => recordLine(r, statusIcon(r, now)));
      return (
        `🔎 ${rows.length} match${rows.length === 1 ? '' : 'es'} for “${sanitize(q, 60)}”:\n` +
        shown.join('\n') +
        (rows.length > 10 ? `\n_…and ${rows.length - 10} more. Add more words to narrow it down._` : '') +
        `\n_Send the seat for full details and the photo._`
      );
    } catch (err) {
      console.error('[steward-bot] find failed:', (err as Error).message);
      return '⚠️ Gatekeeper can’t reach its database right now. Try again in a minute.';
    }
  }

  /**
   * Everyone on record in a section, or a section and row. Returns null (stay quiet) for a
   * bare number with no matches, since "10" in a group chat is usually not a search.
   */
  private async searchSeats(section: string, row: string | undefined, explicit: boolean): Promise<string | null> {
    const where = `section ${section}${row ? `, row ${row}` : ''}`;
    try {
      const rows = await listRecords({ section, row }, 200);
      if (!rows.length) return explicit ? `✅ Nothing on record in ${where}.` : null;
      const now = new Date(this.now());
      const sorted = [...rows].sort((a, b) => `${a.row_label}`.localeCompare(`${b.row_label}`, 'en', { numeric: true }) || `${a.seat_number}`.localeCompare(`${b.seat_number}`, 'en', { numeric: true }));
      const MAX = 20;
      return (
        `🔎 *${where[0].toUpperCase()}${where.slice(1)}*: ${rows.length} on record\n` +
        sorted.slice(0, MAX).map((r) => recordLine(r, statusIcon(r, now))).join('\n') +
        (rows.length > MAX ? `\n_…and ${rows.length - MAX} more. Add the row to narrow it down._` : '') +
        `\n_Send the full seat for details and the photo._`
      );
    } catch (err) {
      console.error('[steward-bot] seat search failed:', (err as Error).message);
      return '⚠️ Gatekeeper can’t reach its database right now. Try again in a minute.';
    }
  }

  private async checkSeats(seats: SeatRef[]): Promise<string> {
    try {
      const now = new Date(this.now());
      const lines = await Promise.all(
        seats.map(async ({ section, row, seat }) => {
          const prof = await getTicketProfileBySeat(section, row, seat);
          const label = `*${section} ${row} ${seat}*`;
          if (!prof) return `✅ ${label} · not refused`;
          const ejected = /^Ejected/.test(prof.reasoning);
          const status =
            prof.current_status === 'admitted'
              ? '🟢 ' + label + ' · cleared'
              : prof.current_status === 'completely_refused'
                ? `${ejected ? '⛔' : '🔴'} ${label} · ${ejected ? 'EJECTED' : 'REFUSED'}`
                : prof.cool_down_until && new Date(prof.cool_down_until) > now
                  ? `🟠 ${label} · SENT AWAY, back ${formatClock(prof.cool_down_until)} (${minutesUntil(prof.cool_down_until, now)} min)`
                  : `🟡 ${label} · cool-off ended`;
          const reason = prof.reasoning && prof.reasoning !== 'Not provided' ? ` · ${sanitize(prof.reasoning, 60)}` : '';
          return prof.current_status === 'admitted' ? status : status + reason;
        }),
      );
      return `🔎 ${seatsLabel(seats)}:\n${lines.join('\n')}\n_Send one seat for full details and the photo._`;
    } catch (err) {
      console.error('[steward-bot] lookup failed:', (err as Error).message);
      return '⚠️ Gatekeeper can’t reach its database right now. Treat these seats as *unchecked* and ask a supervisor.';
    }
  }

  /** "52 YY 14 rest of text" -> the seat and what follows it. */
  private splitSeat(arg: string): { seat: Pick<ParsedLog, 'section' | 'row' | 'seat'>; rest: string } | null {
    const s = SEAT_RE.exec(arg);
    if (!s) return null;
    return { seat: { section: s[1].toUpperCase(), row: s[2].toUpperCase(), seat: s[3] }, rest: arg.slice(s[0].length).trim() };
  }

  /** NOTE 52 YY 14 came back calm. */
  private async note(arg: string, m: InboundMessage): Promise<string> {
    const sp = this.splitSeat(arg);
    if (!sp) return 'Send *NOTE*, the seat, then the note, e.g. *NOTE 52 YY 14 came back calm*.';
    if (!sp.rest) return `Add the note after the seat, e.g. *NOTE ${sp.seat.section} ${sp.seat.row} ${sp.seat.seat} came back calm*.`;
    try {
      const f = await this.findBySeat(`${sp.seat.section} ${sp.seat.row} ${sp.seat.seat}`);
      if (!f.profile) return f.error!;
      await addNote(f.profile.ticket_id, (m.senderName || 'Steward').slice(0, 100), sp.rest);
      return `🗒️ Note added to *${f.label}*.`;
    } catch (err) {
      console.error('[steward-bot] note failed:', (err as Error).message);
      return '⚠️ Couldn’t save that note. Try again.';
    }
  }

  /** PARTY 52 YY 14 3: how many people are in the group. */
  private async setParty(arg: string): Promise<string> {
    const sp = this.splitSeat(arg);
    const n = sp ? Number(/^(?:x\s*)?(\d{1,2})$/i.exec(sp.rest)?.[1]) : NaN;
    if (!sp || !(n >= 1)) return 'Send *PARTY*, the seat, then the number of people, e.g. *PARTY 52 YY 14 3*.';
    try {
      const f = await this.findBySeat(`${sp.seat.section} ${sp.seat.row} ${sp.seat.seat}`);
      if (!f.profile) return f.error!;
      await getPool().query('UPDATE tickets SET party_size = $2 WHERE ticket_id = $1', [f.profile.ticket_id, n]);
      return `👥 *${f.label}* is now a party of ${n}.`;
    } catch (err) {
      console.error('[steward-bot] party failed:', (err as Error).message);
      return '⚠️ Couldn’t save that. Try again.';
    }
  }

  /** EDIT 52 YY 14: re-ask the reasons and description. Your own last log, or any record for group admins. */
  private async startEdit(arg: string, m: InboundMessage, k: string): Promise<OutboundReply[]> {
    try {
      const f = await this.findBySeat(arg);
      if (!f.profile) return [{ text: f.error! }];
      const own = this.lastLogs.get(m.senderId)?.ticketIds.includes(f.profile.ticket_id) ?? false;
      if (!own) {
        const denied = await this.supervisorOnly(m, 'edit someone else’s record');
        if (denied) return [{ text: denied }];
      }
      const p: Pending = {
        startedAt: this.now(),
        editTicketId: f.profile.ticket_id,
        editLabel: f.label,
        ejected: /^Ejected/.test(f.profile.reasoning),
      };
      this.pending.set(k, p);
      return this.advance(m, p, `✏️ Editing *${f.label}*. Answer again; *CANCEL* keeps it as it was.\n`);
    } catch (err) {
      console.error('[steward-bot] edit failed:', (err as Error).message);
      return [{ text: '⚠️ Gatekeeper can’t reach its database right now. Try again in a minute.' }];
    }
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
    if (m.chatId.endsWith('@g.us')) {
      return getConfig().WA_PRIVATE_CHATS
        ? { text: 'Send *REPORT* to me in a private chat and I’ll send you the spreadsheet.' }
        : { text: '📎 For the spreadsheet, use *Export CSV* on the records page (admins also get it privately every night).' };
    }
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
    const entry = (r: RecordRow, extra?: string) => recordLine(r, '•', extra);
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
      let text = formatQuickCheck(profile, cmd.kind === 'check' ? { ticketId: cmd.ticketId } : cmd);
      if (!profile) return { text };
      const notes = await getNotes(profile.ticket_id);
      if (notes.length) {
        text += '\n' + notes.slice(-3).map((n) => `🗒️ ${formatClock(n.created_at)} ${sanitize(n.author, 40)}: ${sanitize(n.body, 160)}`).join('\n');
      }
      const photo = await latestPhoto(profile.ticket_id);
      return photo ? { text, image: photo } : { text };
    } catch (err) {
      console.error('[steward-bot] lookup failed:', (err as Error).message);
      return { text: '⚠️ Gatekeeper can’t reach its database right now. Treat this seat as *unchecked* and ask a supervisor.' };
    }
  }
}

/**
 * Part of a seat, for a search: "313 L" / "234 O" (section with a digit, then a lettered row),
 * "SECTION 313 ROW 12", "SECTION 313", or a bare "313" (explicit=false: reply only on matches).
 */
export function parsePartialSeat(text: string): { section: string; row?: string; explicit: boolean } | null {
  const t = text.trim();
  let m = /^(?:sec(?:tion)?|block|blk)\.?\s*([a-z0-9]{1,6})(?:\s*[\s/,|]\s*(?:row|rw)\.?\s*([a-z0-9]{1,4}))?$/i.exec(t);
  if (m) return { section: m[1].toUpperCase(), row: m[2]?.toUpperCase(), explicit: true };
  m = /^([a-z]{0,3}\d{1,4}[a-z]{0,2})\s*[\s/,|]\s*(?:(row|rw)\.?\s*)?([a-z]{1,3})$/i.exec(t);
  if (m) {
    // "5 min", "10 pm", "2 ok" are chat: only answer those if something matches.
    const chatty = !m[2] && (m[3].length > 2 || /^(ok|am|pm|hr|hrs|min|ya|no|so|go|ye|yh|x)$/i.test(m[3]));
    return { section: m[1].toUpperCase(), row: m[3].toUpperCase(), explicit: !chatty };
  }
  m = /^(\d{1,4}[a-z]?)$/i.exec(t);
  if (m) return { section: m[1].toUpperCase(), explicit: false };
  return null;
}

/** Words that mean the steward has already decided: refused, sent away (30 min) or ejected. */
const DECISION_WORDS =
  /\b(refus\w*|turned (him|her|them) away|turned away|not let (him|her|them) in|denied|sent (him|her|them) away|sent away|send (him|her|them) away|30 ?min\w*|thirty minutes|cool(ing)?[- ]?off|come back later|eject\w*|thrown out|threw (him|her|them) out|kicked out|removed)\b/i;

/** "Intoxicated, Already refused, tried re-entry" -> its reasons (the re-entry one has a lower-case "tried"). */
function splitReasons(reasoning: string | null | undefined): string[] {
  if (!reasoning || reasoning === 'Not provided') return [];
  return reasoning.split(/,\s*(?=[A-Z])/).map((r) => r.trim()).filter(Boolean);
}

/**
 * A re-entry attempt: add "Already refused, tried re-entry" (or "sent away") and any new reasons
 * to the existing record, without repeats. Returns the new reasoning.
 */
async function addReentryReason(ticketId: string, current: string, previousStatus: string, newReasons?: string): Promise<string> {
  const label = previousStatus === 'cooling_off' ? 'Already sent away, tried re-entry' : 'Already refused, tried re-entry';
  const merged = splitReasons(current);
  for (const r of [label, ...splitReasons(newReasons)]) if (!merged.includes(r)) merged.push(r);
  const text = merged.join(', ').slice(0, 2000);
  if (text !== current) await getPool().query('UPDATE tickets SET reasoning = $2 WHERE ticket_id = $1', [ticketId, text]);
  return text;
}

/** All seats of a log: one, a row list ("205 206 207"), or seats across rows from a ticket. */
function seatList(p: Pending): SeatRef[] {
  if (p.groupSeats?.length) return p.groupSeats;
  return [p.seat!, ...(p.extraSeats ?? [])].map((seat) => ({ section: p.section!, row: p.row!, seat }));
}

/** "313 YY 56, 57 · 313 ZZ 10". */
function seatsLabel(seats: SeatRef[]): string {
  const groups = new Map<string, string[]>();
  for (const s of seats) groups.set(`${s.section} ${s.row}`, [...(groups.get(`${s.section} ${s.row}`) ?? []), s.seat]);
  return [...groups.entries()].map(([sr, list]) => `${sr} ${list.join(', ')}`).join(' · ');
}

/** Puts chosen seats on a log; several seats become a group (or a choice to make first). */
function setSeats(p: ParsedLog & { choices?: SeatRef[]; groupSeats?: SeatRef[] }, seats: SeatRef[], chosen = false): void {
  if (seats.length > 1 && !chosen) {
    p.choices = seats;
    return;
  }
  const [first] = seats;
  Object.assign(p, { section: first.section, row: first.row, seat: first.seat });
  delete p.extraSeats;
  delete p.groupSeats;
  if (seats.length > 1) {
    const sameRow = seats.every((s) => s.section === first.section && s.row === first.row);
    if (sameRow) p.extraSeats = seats.slice(1).map((s) => s.seat);
    else p.groupSeats = seats;
  }
}

/** What an AI draft will save, for the steward to confirm. */
function draftSummary(p: Pending): string {
  const head = p.decision === 'cool_off' ? '🟠 *SENT AWAY 30 MIN*' : p.ejected ? '⛔ *EJECTED*' : '🔴 *REFUSED*';
  const lines = [`*Check this before I save it:*`, `${head} · ${seatsLabel(seatList(p))} · ${p.hub ?? '?'}`];
  const reason = reasonText(p);
  if (reason) lines.push(`📝 ${sanitize(reason, 200)}`);
  const desc = describe(p);
  if (desc) lines.push(`👤 ${sanitize(desc, 200)}`);
  if (p.party && p.party > 1) lines.push(`👥 Party of ${p.party}`);
  return lines.join('\n');
}

function statusIcon(r: RecordRow, now: Date): string {
  if (r.current_status === 'admitted') return '🟢';
  if (r.current_status === 'completely_refused') return /^Ejected/.test(r.reasoning) ? '⛔' : '🔴';
  return r.cool_down_until && new Date(r.cool_down_until) > now ? '🟠' : '🟡';
}

/** One record in LIST / FIND: "• *52 YY 14* · Intoxicated · West 21:40 · 👥3 · 📷" plus the description. */
function recordLine(r: RecordRow, bullet: string, extra?: string): string {
  const seat = r.section ? `${r.section} ${r.row_label} ${r.seat_number}` : r.ticket_id;
  const head = [`${bullet} *${sanitize(seat, 40)}*`];
  if (r.reasoning && r.reasoning !== 'Not provided') head.push(sanitize(r.reasoning, 80));
  if (r.origin_hub) head.push(`${r.origin_hub.replace(' Hub', '')}${r.origin_at ? ` ${formatClock(r.origin_at)}` : ''}`);
  if (extra) head.push(extra);
  if (r.party_size > 1) head.push(`👥${r.party_size}`);
  if (r.breaches) head.push(`🚨 tried again ×${r.breaches}`);
  if (r.photos) head.push('📷');
  const desc = r.description && r.description !== 'Not provided' ? `\n   👤 ${sanitize(r.description, 90)}` : '';
  return head.join(' · ') + desc;
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
  if (!p.reasons?.length) return p.ejected ? 'Ejected' : undefined;
  const list = p.reasons.map((r) => (r === 'Other' && p.otherReason ? `Other: ${p.otherReason}` : r)).join(', ');
  return p.ejected ? `Ejected: ${list}` : list;
}

function confirmation(o: ScanOutcome, hub: Hub, p: Pending): string {
  const t = o.ticket!;
  const seat = `${t.section ?? p.section} ${t.row_label ?? p.row} ${t.seat_number ?? p.seat}`;
  const when = formatClock(o.evaluatedAt);
  const reason = reasonText(p);
  const desc = describe(p);
  const party = p.party && p.party > 1 ? `\n👥 Party of ${p.party}` : '';
  const notes = (reason ? `\n📝 ${sanitize(reason, 200)}` : '') + (desc ? `\n👤 ${sanitize(desc, 200)}` : '') + party;
  const origin = o.originEvent;

  switch (o.scenario) {
    case 'HUB_HOP_BYPASS': {
      const left = t.current_status === 'cooling_off' && t.cool_down_until ? ` (${minutesUntil(t.cool_down_until, o.evaluatedAt)} min left)` : '';
      return (
        `🚨 *ALREADY ${t.current_status === 'cooling_off' ? 'SENT AWAY' : 'REFUSED'}* · ${seat}\n` +
        `First at *${origin?.hub_location ?? 'another hub'}* ${origin ? formatClock(origin.timestamp) : ''} by ${sanitize(origin?.steward_name ?? '?', 100)}${left}.\n` +
        `Logged as a second attempt at ${hub} ${when}. ⛔ Do not admit.` +
        (t.reasoning && t.reasoning !== 'Not provided' ? `\n📝 ${sanitize(t.reasoning, 300)}` : '')
      );
    }
    case 'REASSESSMENT':
      return `🔁 *Updated* · ${seat} is now ${t.current_status === 'cooling_off' ? `🟠 SENT AWAY until ${t.cool_down_until ? formatClock(t.cool_down_until) : '?'}` : '🔴 REFUSED'} (${hub} ${when}).${notes}`;
    default:
      return (
        (t.current_status === 'cooling_off'
          ? `✅ Logged 🟠 *SENT AWAY 30 MIN* · ${seat}\n${hub} ${when} · back after ${t.cool_down_until ? formatClock(t.cool_down_until) : '?'}`
          : `✅ Logged ${p.ejected ? '⛔ *EJECTED*' : '🔴 *REFUSED*'} · ${seat}\n${hub} ${when}`) +
        notes +
        `\n_Reply UNDO within 15 min if this was a mistake._`
      );
  }
}

export const STEWARD_HELP =
  '🤖 *GATEKEEPER*\n\n' +
  '*Log someone:* *REFUSED 52 YY 14 West*, *30 52 YY 14 West* (sent away 30 min) or *EJECTED 52 YY 14 West*; ' +
  'or a photo of them or their ticket QR with the seat as the caption; or just *LOG*. Add *x3* for a group of 3.\n' +
  '*Several seats:* *REFUSED 300 L 205 206 207 West* (or *205-207*): one record each, same answers. *300 L 205 206 207* checks them all.\n' +
  '*Ticket photo:* send it captioned *REFUSED* / *30* / *EJECTED* and I read the seat (several seats: pick with *1 3* or *ALL*). Caption *SCAN* just checks them.\n' +
  'I’ll then ask: hub, reasons, male/female, height, build, minor or adult, and what they’re wearing.\n' +
  '*BACK*: change your last answer · *CANCEL*: stop · *UNDO*: remove your last saved record (15 min)\n' +
  '*HUB WEST*: set your hub for the shift (*HUB OFF* to stop)\n' +
  `*Reasons* (one or more, e.g. *1 3 5*): ${REASONS.map((r, i) => `${i + 1} ${r}`).join(' · ')}\n\n` +
  '*Check:* send the seat, e.g. *52 YY 14* · *313 L*: everyone in section 313 row L · *313*: the whole section\n' +
  '*FIND green hat*: search descriptions\n' +
  '*LIST*: who is refused or sent away now · *STATS*: tonight’s numbers\n\n' +
  '*Add to a saved record:* *NOTE 52 YY 14 came back calm* · *PARTY 52 YY 14 3* · ' +
  'a photo captioned *PHOTO 52 YY 14* · *EDIT 52 YY 14* (your own log; admins: any)\n' +
  '_Group admins only:_ *CLEAR 52 YY 14* (may enter now) · *REPORT* in a private chat (the spreadsheet)\n\n' +
  '_Records are deleted automatically after 24 hours._';

/** HELP, matching what's switched on (the AI helper, private chats). */
export function helpText(ai: boolean, privateChats: boolean): string {
  let help = STEWARD_HELP + (ai ? AI_HELP : '');
  if (!privateChats) {
    help = help
      .replace(' · *REPORT* in a private chat (the spreadsheet)', '')
      .replace(' In a private chat, just type.', '')
      .replace(/\n🎙️ \*Voice note\*[^\n]*/, '');
  }
  return help;
}

/** Added to HELP when the AI helper is on. */
export const AI_HELP =
  '\n\n🤖 *Ask in plain English:* start with *GK* (or @mention me), e.g. *GK anyone in a red coat sent away?* ' +
  'or *GK refused a drunk lad in a green hat, 313 YY 56, West*. In a private chat, just type. ' +
  'I show you what I understood before saving anything.\n' +
  '📸 *Ticket photo + a few words*, e.g. *drunk, swearing, tall lad green hat, West*: one message logs it.\n' +
  '🎙️ *Voice note* in a private chat with me: say the report, then reply YES.\n' +
  '⚖️ *ADVICE what you see*: a suggestion from the venue policy (admins set it with *POLICY …*).';
