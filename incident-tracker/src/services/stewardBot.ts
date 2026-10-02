import { getPool, isConnectivityError } from '../db/pool';
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
 *         "REFUSED BB 212 100 West green hat, very drunk"  or  "30 BB 212 100 ...".
 *         Anything missing (decision, seat, hub, reason) is asked for, one question at a time.
 *         The time is the message time. Each steward's hub is remembered.
 *  Check: "BB 212 100" -> refused / sent away / not on record, with the photo if there is one.
 *  Also:  UNDO (remove your last new record), CANCEL (drop a half-finished log), HELP.
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
}

// ---------------------------------------------------------------- parsing

const DECISION_RE = /^\s*(refused|refuse|ref|r|sent\s*away|sent|sa|30|30\s*min(?:s|utes)?|cool\s*-?\s*off|cooling\s*off|cooloff|cool)\b[\s:,-]*/i;
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

export interface ParsedLog {
  decision?: Decision;
  section?: string;
  row?: string;
  seat?: string;
  hub?: Hub;
  notes?: string;
}

/** "REFUSED BB 212 100 West green hat, very drunk" -> parts. Returns null if it doesn't start with a decision. */
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
  const notes = rest.trim();
  if (/^[-–—]+$/.test(notes)) out.notes = ''; // "-" means: no reason to add
  else if (notes) out.notes = notes.replace(/^[-–—:]\s*/, '').slice(0, 500);
  return out;
}

/** A bare seat as an answer to "which seat?": "BB 212 100", "BB/212/100", "Section BB Row 212 Seat 100". */
export function parseSeatAnswer(text: string): Pick<ParsedLog, 'section' | 'row' | 'seat'> | null {
  const s = SEAT_RE.exec(text);
  if (!s || text.slice(s[0].length).trim()) return null;
  return { section: s[1].toUpperCase(), row: s[2].toUpperCase(), seat: s[3] };
}

// ---------------------------------------------------------------- conversation state

type Field = 'decision' | 'seat' | 'hub' | 'reason';

interface Pending extends ParsedLog {
  ticketCode?: string;
  photo?: { data: Buffer; mime: string };
  asked?: Field;
  startedAt: number;
}

interface LastLog {
  ticketId: string;
  createdTicket: boolean;
  at: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const HUB_MEMORY_MS = 12 * 60 * 60_000;
const UNDO_WINDOW_MS = 15 * 60_000;

const PROMPTS: Record<Field, string> = {
  decision: 'Refused or sent away for 30 minutes? Reply *REFUSED* or *30*.',
  seat: 'Which seat? Send section, row and seat, e.g. *BB 212 100*.',
  hub: 'Which hub are you at? *East*, *West*, *South* or *Hospitality*.',
  reason: 'Reason? e.g. *green hat, very drunk*. Reply *-* to skip.',
};

export class StewardBot {
  private pending = new Map<string, Pending>();
  private hubs = new Map<string, { hub: Hub; at: number }>();
  private lastLogs = new Map<string, LastLog>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(m: InboundMessage) {
    return `${m.chatId}|${m.senderId}`;
  }

  private rememberedHub(senderId: string): Hub | undefined {
    const h = this.hubs.get(senderId);
    return h && this.now() - h.at < HUB_MEMORY_MS ? h.hub : undefined;
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
    if (/^undo$/i.test(text)) return [{ text: await this.undo(m.senderId) }];
    if (/^(help|\?|menu)$/i.test(text)) return [{ text: STEWARD_HELP }];

    // ---- images: a ticket QR starts (or feeds) a log; another photo is the customer's picture.
    if (m.image) {
      const qr = await decodeQrFromImage(m.image.data);
      const log = parseLogCommand(text);
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

    // ---- an answer to the bot's last question
    if (p) {
      const answered = this.applyAnswer(p, text);
      if (answered) return this.advance(m, p);
      return [{ text: `${PROMPTS[p.asked ?? this.nextMissing(p, m.senderId) ?? 'reason']}\n_(or CANCEL)_` }];
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
      const d = parseDecision(text);
      if (d) return (p.decision = d), true;
    }
    if (asked === 'seat' || !p.seat) {
      const s = parseSeatAnswer(text);
      if (s) return Object.assign(p, s), true;
    }
    if (asked === 'hub' || !p.hub) {
      const h = parseHub(text);
      if (h && text.replace(HUB_RE, '').trim() === '') return (p.hub = h), true;
    }
    if (asked === 'reason') {
      p.notes = text === '-' ? '' : text.slice(0, 500);
      return true;
    }
    return false;
  }

  private nextMissing(p: Pending, senderId: string): Field | null {
    if (!p.decision) return 'decision';
    if (!p.seat) return 'seat';
    if (!p.hub && !this.rememberedHub(senderId)) return 'hub';
    if (p.notes === undefined) return 'reason';
    return null;
  }

  private async advance(m: InboundMessage, p: Pending, intro?: string): Promise<OutboundReply[]> {
    const missing = this.nextMissing(p, m.senderId);
    if (missing) {
      p.asked = missing;
      return [{ text: intro ? `${intro} ${PROMPTS[missing]}` : PROMPTS[missing] }];
    }
    this.pending.delete(this.key(m));
    return [{ text: await this.commit(m, p) }];
  }

  // ---------------------------------------------------------------- saving

  private async commit(m: InboundMessage, p: Pending): Promise<string> {
    const hub = p.hub ?? this.rememberedHub(m.senderId)!;
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
      description: p.notes || undefined,
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
    return confirmation(outcome, hub, p, !p.hub);
  }

  private async undo(senderId: string): Promise<string> {
    const last = this.lastLogs.get(senderId);
    if (!last || this.now() - last.at > UNDO_WINDOW_MS) return 'Nothing to undo. You can undo a new record within 15 minutes.';
    this.lastLogs.delete(senderId);
    const { rowCount } = await getPool().query('DELETE FROM tickets WHERE ticket_id = $1', [last.ticketId]);
    return rowCount ? '↩️ Removed your last record.' : 'That record was already gone.';
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

function confirmation(o: ScanOutcome, hub: Hub, p: Pending, hubWasRemembered: boolean): string {
  const t = o.ticket!;
  const seat = `${t.section ?? p.section} ${t.row_label ?? p.row} ${t.seat_number ?? p.seat}`;
  const when = formatClock(o.evaluatedAt);
  const notes = p.notes ? `\n📝 ${sanitize(p.notes, 200)}` : '';
  const hubNote = hubWasRemembered ? `\n_Hub: ${hub} (remembered). Add EAST/WEST/SOUTH/HOSP to change._` : '';
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
        `\n_Reply UNDO within 15 min if this was a mistake._` +
        hubNote
      );
  }
}

export const STEWARD_HELP =
  '🤖 *GATEKEEPER*\n\n' +
  '*Check a seat:* send it, e.g. *BB 212 100*\n\n' +
  '*Log someone:* send a photo of their ticket QR or of them, with:\n' +
  '• *REFUSED BB 212 100 West green hat, very drunk*\n' +
  '• *30 BB 212 100 West* (sent away for 30 minutes)\n' +
  'Missing details? I’ll ask. Your hub is remembered.\n\n' +
  '*UNDO*: remove your last record · *CANCEL*: stop a log\n' +
  '_Records are deleted automatically after 24 hours._';
