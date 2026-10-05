import { EventEmitter } from 'events';
import { getConfig } from '../config/env';
import { getPool, isConnectivityError } from '../db/pool';
import { audit } from './accounts';
import { cooloffsEndedBetween } from './nightReport';
import { can, type AppUser } from './permissions';

/**
 * The live feed (every log, all areas), the alerts pushed to logged-in phones (a re-entry, someone
 * who may now be readmitted, a record changed), and editing records according to role.
 */

export type AppEvent =
  | { kind: 'log'; seat: string; status: string; hub: string; by: string; reentry: boolean; first_hub: string | null; at: string }
  | { kind: 'readmit'; seat: string; hub: string | null; at: string }
  | { kind: 'change'; seat: string; what: 'edited' | 'deleted'; by: string };

export const appEvents = new EventEmitter();
appEvents.setMaxListeners(200); // one per open phone
export const emitAppEvent = (e: AppEvent) => appEvents.emit('event', e);

export class FeedError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// ---------------------------------------------------------------- the feed

export interface FeedItem {
  id: string;
  at: string;
  ticket_id: string;
  seat: string;
  status: 'refused' | 'sent_away' | 'ejected' | 'admitted';
  hub: string;
  by: string;
  reentry: boolean;
  reasoning: string;
  description: string;
  party: number;
  back_at: string | null;
  can_edit: boolean;
  can_delete: boolean;
}

interface FeedRow {
  id: string;
  timestamp: Date;
  ticket_id: string;
  hub_location: string;
  steward_name: string;
  is_breach_event: boolean;
  previous_logs: number;
  current_status: string;
  reasoning: string;
  description: string;
  party_size: number;
  cool_down_until: Date | null;
  section: string | null;
  row_label: string | null;
  seat_number: string | null;
  only_mine: boolean;
}

const statusOf = (r: { current_status: string; reasoning: string }): FeedItem['status'] =>
  r.current_status === 'cooling_off' ? 'sent_away' : r.current_status === 'admitted' ? 'admitted' : /^Ejected/.test(r.reasoning) ? 'ejected' : 'refused';
const seatOf = (r: { section: string | null; row_label: string | null; seat_number: string | null; ticket_id: string }) =>
  r.section ? `${r.section} ${r.row_label} ${r.seat_number}` : r.ticket_id;
const clean = (s: string) => (s === 'Not provided' ? '' : s);

/** The latest logs (each steward action is one item), newest first. */
export async function listFeed(user: AppUser, limit = 150): Promise<FeedItem[]> {
  const { rows } = await getPool().query<FeedRow>(
    `SELECT e.id, e.timestamp, e.ticket_id, e.hub_location, e.steward_name, e.is_breach_event,
            (SELECT count(*)::int FROM scan_events p WHERE p.ticket_id = e.ticket_id AND p.timestamp < e.timestamp) AS previous_logs,
            t.current_status, t.reasoning, t.description, t.party_size, t.cool_down_until, t.section, t.row_label, t.seat_number,
            (SELECT bool_and(o.user_id IS NOT DISTINCT FROM $2::uuid) FROM scan_events o WHERE o.ticket_id = t.ticket_id) AS only_mine
       FROM scan_events e JOIN tickets t ON t.ticket_id = e.ticket_id
      ORDER BY e.timestamp DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500), user.id],
  );
  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.timestamp).toISOString(),
    ticket_id: r.ticket_id,
    seat: seatOf(r),
    status: statusOf(r),
    hub: r.hub_location,
    by: r.steward_name,
    reentry: r.is_breach_event || r.previous_logs > 0,
    reasoning: clean(r.reasoning),
    description: clean(r.description),
    party: r.party_size,
    back_at: r.current_status === 'cooling_off' && r.cool_down_until ? new Date(r.cool_down_until).toISOString() : null,
    can_edit: can(user, 'edit', { ownerId: r.only_mine ? user.id : null }),
    can_delete: can(user, 'delete'),
  }));
}

// ---------------------------------------------------------------- editing

const EDIT_STATUSES = ['refused', 'sent_away', 'ejected', 'admitted'] as const;
type EditStatus = (typeof EDIT_STATUSES)[number];

/** A record, and whether every log on it was made by `userId` (only then may an area supervisor change it). */
async function recordFor(ticketId: string, userId: string) {
  const { rows } = await getPool().query<{ ticket_id: string; current_status: string; reasoning: string; section: string | null; row_label: string | null; seat_number: string | null; only_mine: boolean }>(
    `SELECT t.ticket_id, t.current_status, t.reasoning, t.section, t.row_label, t.seat_number,
            (SELECT bool_and(o.user_id IS NOT DISTINCT FROM $2::uuid) FROM scan_events o WHERE o.ticket_id = t.ticket_id) AS only_mine
       FROM tickets t WHERE t.ticket_id = $1`,
    [ticketId.slice(0, 64), userId],
  );
  if (!rows[0]) throw new FeedError('That record isn’t there any more.', 404);
  return rows[0];
}

/** Area supervisors: their own logs (not clearing). Seniors and the superadmin: anything. */
export async function editRecord(
  user: AppUser,
  ticketId: string,
  body: { status?: unknown; reasoning?: unknown; description?: unknown; party?: unknown },
): Promise<void> {
  const rec = await recordFor(ticketId, user.id);
  if (!can(user, 'edit', { ownerId: rec.only_mine ? user.id : null })) {
    throw new FeedError('You can only change records that only you have logged. Ask a senior supervisor.', 403);
  }

  const status = body.status === undefined ? undefined : (String(body.status) as EditStatus);
  if (status !== undefined && !EDIT_STATUSES.includes(status)) throw new FeedError('Status: refused, sent_away, ejected or admitted.');
  if (status === 'admitted' && !can(user, 'delete')) throw new FeedError('Only senior supervisors can clear someone to come in.', 403);
  // Area supervisors may make a record more serious, never less (that would be a way round clearing).
  const RANK: Record<string, number> = { admitted: 0, sent_away: 1, refused: 2, ejected: 3 };
  if (status !== undefined && !can(user, 'delete') && RANK[status] < RANK[statusOf(rec)]) {
    throw new FeedError('Only senior supervisors can make a record less serious.', 403);
  }
  const text = (v: unknown, name: string) => {
    if (v === undefined) return undefined;
    const s = String(v).trim();
    if (s.length > 2000) throw new FeedError(`${name} is too long.`);
    return s || 'Not provided';
  };
  let reasoning = text(body.reasoning, 'The reason');
  const description = text(body.description, 'The description');
  let party: number | undefined;
  if (body.party !== undefined) {
    party = Number(body.party);
    if (!Number.isInteger(party) || party < 1 || party > 500) throw new FeedError('Group size: 1 to 500.');
  }
  if (status === undefined && reasoning === undefined && description === undefined && party === undefined) throw new FeedError('Nothing to change.');

  // Ejected is stored as refused with "Ejected: " in front of the reasons. Editing only the reason
  // keeps that mark: the status changes only when a status is chosen.
  if (status === undefined && reasoning !== undefined && statusOf(rec) === 'ejected') {
    reasoning = `Ejected: ${reasoning.replace(/^Ejected:?\s*/, '')}`.replace(/: $/, '');
  }
  if (status === 'ejected' || status === 'refused') {
    const base = (reasoning ?? rec.reasoning).replace(/^Ejected:?\s*/, '');
    reasoning = status === 'ejected' ? `Ejected: ${base}`.replace(/: $/, '') : base || 'Not provided';
  }
  const dbStatus = status === undefined ? null : status === 'sent_away' ? 'cooling_off' : status === 'admitted' ? 'admitted' : 'completely_refused';
  await getPool().query(
    `UPDATE tickets SET
        current_status  = COALESCE($2::incident_status, current_status),
        cool_down_until = CASE WHEN $2::text IS NULL THEN cool_down_until
                               WHEN $2::text = 'cooling_off' THEN COALESCE(CASE WHEN current_status = 'cooling_off' THEN cool_down_until END,
                                                                            NOW() + make_interval(mins => $6::int))
                               ELSE NULL END,
        reasoning       = COALESCE($3::text, reasoning),
        description     = COALESCE($4::text, description),
        party_size      = COALESCE($5::int, party_size)
      WHERE ticket_id = $1`,
    [rec.ticket_id, dbStatus, reasoning ?? null, description ?? null, party ?? null, getConfig().COOL_OFF_MINUTES],
  );
  const seat = seatOf(rec);
  const changes = [status && `status → ${status}`, reasoning !== undefined && 'reason', description !== undefined && 'description', party !== undefined && `group → ${party}`].filter(Boolean);
  await audit(user, 'record_edited', `${seat}: ${changes.join(', ')}`);
  emitAppEvent({ kind: 'change', seat, what: 'edited', by: user.name });
}

export async function removeRecord(user: AppUser, ticketId: string): Promise<void> {
  const rec = await recordFor(ticketId, user.id);
  if (!can(user, 'delete')) throw new FeedError('Only senior supervisors can delete records.', 403);
  await getPool().query('DELETE FROM tickets WHERE ticket_id = $1', [rec.ticket_id]);
  const seat = seatOf(rec);
  await audit(user, 'record_deleted', seat);
  emitAppEvent({ kind: 'change', seat, what: 'deleted', by: user.name });
}

// ---------------------------------------------------------------- "may now be readmitted"

/** Announces everyone whose cool-off ended in (from, to]. */
export async function checkReadmits(from: Date, to: Date): Promise<void> {
  for (const r of await cooloffsEndedBetween(from, to)) {
    emitAppEvent({ kind: 'readmit', seat: seatOf(r), hub: r.origin_hub, at: new Date(r.cool_down_until).toISOString() });
  }
}

export function startFeedJobs(everyMs = 30_000): () => void {
  let checkedUntil = new Date();
  const handle = setInterval(async () => {
    const now = new Date();
    try {
      await checkReadmits(checkedUntil, now);
      checkedUntil = now;
    } catch (err) {
      if (!isConnectivityError(err)) console.error('[app] readmit check failed:', (err as Error).message);
    }
  }, everyMs);
  (handle as { unref?: () => void }).unref?.();
  return () => clearInterval(handle);
}
