import { z } from 'zod';
import { getConfig } from '../config/env';
import { HUBS, type Hub } from '../domain';
import { getPool, isConnectivityError } from '../db/pool';
import { listRecords, type RecordRow } from './adminRecords';
import type { AiHelper, DescriptionFields } from './aiAgent';
import { normReason } from './aiAgent';
import { createAiAgent } from './aiProvider';
import { emitAppEvent } from './appFeed';
import { addCustomOption, cleanTerm, refreshCustomOptions } from './customOptions';
import { appendOfflineIncident } from './offlineBuffer';
import { can, type AppUser } from './permissions';
import { decodeQrFromImage, ticketCodeFromQr } from './qrImage';
import { addReentryReason } from './reentry';
import { processScan, scanInputSchema, type ScanOutcome } from './scanService';
import { AGES, BUILDS, HEIGHTS, REASONS } from './stewardBot';
import { getTicketProfileBySeat } from './ticketLookup';
import { readSeatsFromImage, type SeatRef } from './ticketOcr';

/**
 * Logging from the app: the same records as the WhatsApp bot (one ticket per seat, re-entries
 * flagged and their reason added), with the logged-in person's name and id on each log.
 */

export class LogError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// ---------------------------------------------------------------- AI and ticket reading (swappable in tests)

let ai: Pick<AiHelper, 'describe'> | undefined | null = null; // null = not created yet
export function setAppAi(helper: Pick<AiHelper, 'describe'> | undefined): void {
  ai = helper;
}
function appAi() {
  if (ai === null) ai = createAiAgent();
  return ai;
}

type TicketReader = (image: Buffer) => Promise<{ seats: SeatRef[]; code: string | null }>;
let readTicket: TicketReader = async (image) => {
  const raw = await decodeQrFromImage(image).catch(() => null);
  const code = raw ? await ticketCodeFromQr(raw).catch(() => null) : null;
  const seats = getConfig().OCR_ENABLED ? await readSeatsFromImage(image).catch(() => []) : [];
  return { seats, code };
};
export function setTicketReader(fn: TicketReader): void {
  readTicket = fn;
}

// ---------------------------------------------------------------- options

export function logOptions() {
  return {
    reasons: [...REASONS],
    heights: [...HEIGHTS],
    builds: [...BUILDS],
    ages: [...AGES],
    hubs: [...HUBS],
    cool_off_minutes: getConfig().COOL_OFF_MINUTES,
    ai: !!appAi()?.describe,
    ocr: getConfig().OCR_ENABLED,
  };
}

// ---------------------------------------------------------------- logging

const seatPart = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `Add the ${what}.`)
    .max(max, `The ${what} is too long.`)
    .regex(/^[A-Za-z0-9]+$/, `The ${what}: letters and numbers only.`)
    .transform((v) => v.toUpperCase());

const text = (max: number) => z.string().trim().max(max).optional();

const logSchema = z.object({
  client_id: z.uuid('Missing log id (update the app).'),
  author_id: z.uuid().optional(), // who wrote it on the phone (a log saved offline is only sent by them)
  decision: z.enum(['refused', 'cool_off', 'ejected'], 'Pick refused, 30 minutes or ejected.'),
  seats: z
    .array(z.object({ section: seatPart(16, 'section'), row: seatPart(8, 'row'), seat: seatPart(8, 'seat number') }))
    .min(1, 'Add the seat.')
    .max(20, 'At most 20 seats in one log.'),
  hub: z.enum(HUBS).optional(),
  reasons: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  other_reason: text(300),
  gender: text(30),
  height: text(30),
  build: text(30),
  age: text(30),
  clothing: text(300),
  party: z.coerce.number().int().min(1).max(50).optional(),
  ticket_code: text(64),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
});
export type LogRequest = z.input<typeof logSchema>;

export interface LogResult {
  seat: string;
  ticket_id: string;
  status: 'refused' | 'sent_away' | 'ejected' | 'admitted';
  block: boolean; // do not admit
  reentry: boolean; // already on record before this log
  first_hub: string | null;
  first_at: string | null;
  back_at: string | null; // sent away: allowed back after
  offline?: boolean; // the database was down: kept on the server, synced later
}

const statusOf = (t: { current_status: string; reasoning: string }): LogResult['status'] =>
  t.current_status === 'cooling_off' ? 'sent_away' : t.current_status === 'admitted' ? 'admitted' : /^Ejected/.test(t.reasoning) ? 'ejected' : 'refused';

/** Fixed reasons as they are; others mapped ("drunk" -> Intoxicated) or learnt quietly. */
async function resolveReasons(input: string[], other?: string): Promise<string[]> {
  await refreshCustomOptions();
  const out: string[] = [];
  for (const raw of input) {
    const fixed = REASONS.find((r) => r.toLowerCase() === raw.trim().toLowerCase());
    let reason: string | undefined = fixed ?? normReason(raw);
    if (!reason) {
      const term = cleanTerm(raw);
      if (!term) throw new LogError(`“${raw.slice(0, 40)}” isn’t a reason: use a few words.`);
      reason = (await addCustomOption('reasons', term, REASONS)).term;
    }
    if (!out.includes(reason)) out.push(reason);
  }
  if (!out.length) throw new LogError('Pick at least one reason.');
  if (out.includes('Other') && !other) throw new LogError('You picked Other: say what happened.');
  return out.map((r) => (r === 'Other' ? `Other: ${other}` : r));
}

export async function logIncident(user: AppUser, body: unknown): Promise<{ results: LogResult[]; duplicate: boolean }> {
  const parsed = logSchema.safeParse(body);
  if (!parsed.success) throw new LogError(parsed.error.issues[0]?.message ?? 'That log isn’t complete.');
  const v = parsed.data;

  if (v.author_id && v.author_id !== user.id) throw new LogError('That log was written by someone else on this phone: they need to log in to send it.', 409);
  const hub = (v.hub ?? (user.role === 'area' ? user.hub : undefined)) as Hub | undefined;
  if (!hub) throw new LogError('Pick the area (hub) you’re at.');
  if (!can(user, 'log', { hub })) throw new LogError(`You can only log in your own area (${user.hub?.replace(' Hub', '')}).`, 403);

  // Sent again by a phone that lost signal: return what was saved the first time.
  const seen = await getPool().query<{ results: LogResult[]; user_id: string | null }>('SELECT results, user_id FROM app_log_requests WHERE client_id = $1', [v.client_id]);
  if (seen.rows[0]) {
    if (seen.rows[0].user_id !== user.id) throw new LogError('That log id was already used.', 409);
    return { results: seen.rows[0].results, duplicate: true };
  }

  const reasons = await resolveReasons(v.reasons, v.other_reason);
  const reasonText = v.decision === 'ejected' ? `Ejected: ${reasons.join(', ')}` : reasons.join(', ');
  const description = [v.gender, v.height, v.build, v.age, v.clothing].map((x) => x?.trim()).filter(Boolean).join(' · ') || undefined;
  const party = Math.max(v.party ?? 1, v.seats.length);

  const results: LogResult[] = [];
  for (const [i, s] of v.seats.entries()) {
    const label = `${s.section} ${s.row} ${s.seat}`;
    const input = scanInputSchema.safeParse({
      ticket_id: i === 0 ? v.ticket_code : undefined,
      section: s.section,
      row: s.row,
      seat: s.seat,
      hub_location: hub,
      steward_name: user.name,
      action_logged: v.decision === 'cool_off' ? 'cool_off' : 'refused',
      party_size: party > 1 ? party : undefined,
      description,
      reasoning: reasonText,
      occurred_at: v.occurred_at,
    });
    if (!input.success) throw new LogError(`${label}: ${input.error.issues[0]?.message ?? 'not valid'}`);

    let o: ScanOutcome;
    try {
      o = await processScan(input.data);
    } catch (err) {
      if (!isConnectivityError(err)) throw err;
      appendOfflineIncident(input.data, (err as Error).message);
      results.push({ seat: label, ticket_id: input.data.ticket_id, status: v.decision === 'cool_off' ? 'sent_away' : v.decision === 'ejected' ? 'ejected' : 'refused', block: true, reentry: false, first_hub: hub, first_at: null, back_at: null, offline: true });
      continue;
    }
    const t = o.ticket!;
    if (o.event) await getPool().query('UPDATE scan_events SET user_id = $2 WHERE id = $1', [o.event.id, user.id]);
    const reentry = !!o.previousStatus && o.previousStatus !== 'admitted';
    if (reentry) t.reasoning = await addReentryReason(t.ticket_id, t.reasoning, o.previousStatus!, reasonText);
    const status = statusOf(t);
    results.push({
      seat: `${t.section ?? s.section} ${t.row_label ?? s.row} ${t.seat_number ?? s.seat}`,
      ticket_id: t.ticket_id,
      status,
      block: o.blockEntry || status !== 'admitted',
      reentry,
      first_hub: o.originEvent?.hub_location ?? hub,
      first_at: (o.originEvent?.timestamp ?? o.evaluatedAt).toISOString?.() ?? null,
      back_at: t.current_status === 'cooling_off' && t.cool_down_until ? new Date(t.cool_down_until).toISOString() : null,
    });
  }

  for (const r of results) {
    emitAppEvent({ kind: 'log', seat: r.seat, status: r.status, hub, by: user.name, reentry: r.reentry, first_hub: r.first_hub, at: new Date().toISOString() });
  }
  await getPool()
    .query('INSERT INTO app_log_requests (client_id, user_id, results) VALUES ($1, $2, $3) ON CONFLICT (client_id) DO NOTHING', [v.client_id, user.id, JSON.stringify(results)])
    .catch(() => undefined);
  return { results, duplicate: false };
}

// ---------------------------------------------------------------- checking

export interface SeatRecord {
  seat: string;
  ticket_id: string;
  status: LogResult['status'];
  reasoning: string;
  description: string;
  first_hub: string | null;
  first_at: string | null;
  by: string | null;
  back_at: string | null;
  reentries: number;
  party: number;
}

function toSeatRecord(r: RecordRow): SeatRecord {
  return {
    seat: r.section ? `${r.section} ${r.row_label} ${r.seat_number}` : r.ticket_id,
    ticket_id: r.ticket_id,
    status: statusOf(r),
    reasoning: r.reasoning === 'Not provided' ? '' : r.reasoning,
    description: r.description === 'Not provided' ? '' : r.description,
    first_hub: r.origin_hub,
    first_at: r.origin_at ? new Date(r.origin_at).toISOString() : null,
    by: r.origin_steward,
    back_at: r.current_status === 'cooling_off' && r.cool_down_until ? new Date(r.cool_down_until).toISOString() : null,
    reentries: r.breaches,
    party: r.party_size,
  };
}

export async function checkSeat(q: { section?: unknown; row?: unknown; seat?: unknown }): Promise<SeatRecord | null> {
  const [section, row, seat] = [q.section, q.row, q.seat].map((x) => String(x ?? '').trim().toUpperCase());
  if (![section, row, seat].every((x) => /^[A-Z0-9]{1,16}$/.test(x))) throw new LogError('Give the section, row and seat.');
  const profile = await getTicketProfileBySeat(section, row, seat);
  if (!profile) return null;
  const [r] = await listRecords({ section, row, q: profile.ticket_id }, 1);
  return r ? toSeatRecord(r) : null;
}

/** "313", "313 L", "313 L 5" or any words (description, reason). */
export async function searchRecords(qIn: unknown): Promise<SeatRecord[]> {
  const q = String(qIn ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!q) return [];
  const parts = q.toUpperCase().split(' ');
  let rows: RecordRow[];
  if (parts.length <= 3 && /^[A-Z]{0,3}\d{1,4}[A-Z]{0,2}$/.test(parts[0]) && parts.slice(1).every((p) => /^[A-Z0-9]{1,8}$/.test(p))) {
    rows = await listRecords({ section: parts[0], row: parts[1] }, 200);
    if (parts[2]) rows = rows.filter((r) => r.seat_number?.toUpperCase() === parts[2]);
  } else {
    rows = await listRecords({ q }, 200);
  }
  return rows.map(toSeatRecord);
}

// ---------------------------------------------------------------- AI and ticket photos

export async function describeWithAi(textIn: unknown, user: AppUser): Promise<DescriptionFields> {
  const helper = appAi();
  if (!helper?.describe) throw new LogError('The AI helper is off. Use the buttons.', 503);
  const t = String(textIn ?? '').trim().slice(0, 600);
  if (t.length < 3) throw new LogError('Type a few words first.');
  const d = await helper.describe(t, `app:${user.id}`).catch(() => null);
  if (!d) throw new LogError('The AI couldn’t read that. Use the buttons, or try again.', 502);
  const fields: DescriptionFields = {};
  for (const k of ['gender', 'height', 'build', 'age', 'clothing'] as const) if (d[k]) fields[k] = String(d[k]).slice(0, 300);
  return fields;
}

export async function scanTicket(image: Buffer): Promise<{ seats: SeatRef[]; code: string | null }> {
  const r = await readTicket(image);
  return { seats: r.seats.slice(0, 20), code: r.code };
}
