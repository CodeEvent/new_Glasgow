import { getPool } from '../db/pool';
import type { Hub, IncidentStatus, LoggedAction } from '../domain';
import { actionLabel, agoLabel, formatClock, minutesBetween, partyLabel, sanitize, statusLabel } from './format';

export interface TicketProfileEvent {
  hub_location: Hub;
  steward_name: string;
  action_logged: LoggedAction;
  is_breach_event: boolean;
  timestamp: Date;
}

export interface TicketProfile {
  ticket_id: string;
  current_status: IncidentStatus;
  party_size: number;
  description: string;
  reasoning: string;
  cool_down_until: Date | null;
  created_at: Date;
  mins_left: number | null;
  db_now: Date;
  events: TicketProfileEvent[];
}

const PROFILE_SQL = `
  SELECT t.ticket_id, t.current_status, t.party_size, t.description, t.reasoning,
         t.cool_down_until, t.created_at, NOW() AS db_now,
         CASE WHEN t.current_status = 'cooling_off' AND t.cool_down_until IS NOT NULL
              THEN GREATEST(0, CEIL(EXTRACT(EPOCH FROM (t.cool_down_until - NOW())) / 60))::int
         END AS mins_left,
         COALESCE(
           json_agg(json_build_object(
             'hub_location', e.hub_location,
             'steward_name', e.steward_name,
             'action_logged', e.action_logged,
             'is_breach_event', e.is_breach_event,
             'timestamp', e.timestamp
           ) ORDER BY e.timestamp ASC) FILTER (WHERE e.id IS NOT NULL),
           '[]'::json
         ) AS events
    FROM tickets t
    LEFT JOIN scan_events e ON e.ticket_id = t.ticket_id
   WHERE t.ticket_id = $1
   GROUP BY t.ticket_id`;

/** Exact (indexed) match first; falls back to a case-insensitive match for hand-typed IDs. */
export async function getTicketProfile(ticketId: string): Promise<TicketProfile | null> {
  const pool = getPool();
  let { rows } = await pool.query(PROFILE_SQL, [ticketId]);
  if (!rows[0]) {
    const ci = await pool.query<{ ticket_id: string }>(
      'SELECT ticket_id FROM tickets WHERE upper(ticket_id) = upper($1) LIMIT 1',
      [ticketId],
    );
    if (!ci.rows[0]) return null;
    ({ rows } = await pool.query(PROFILE_SQL, [ci.rows[0].ticket_id]));
  }
  const r = rows[0];
  if (!r) return null;
  return {
    ...r,
    events: (r.events as Array<TicketProfileEvent & { timestamp: string }>).map((e) => ({
      ...e,
      timestamp: new Date(e.timestamp),
    })),
  };
}

const MAX_HISTORY_LINES = 15;

export function formatTicketProfile(p: TicketProfile): string {
  const first = p.events[0];
  const firstHub = first?.hub_location ?? 'unknown hub';
  const remaining =
    p.current_status === 'cooling_off' && p.cool_down_until
      ? `${p.mins_left ?? 0} minutes${p.mins_left ? ` (until ${formatClock(p.cool_down_until)})` : ' (cool-off expired)'}`
      : 'N/A';

  let msg =
    `🤖 *TICKET PROFILE RETRIEVED* 🤖\n\n` +
    `🎟️ *Ticket ID:* ${sanitize(p.ticket_id, 64)}\n` +
    `📊 *Current Status:* ${statusLabel(p.current_status)}\n` +
    `⏳ *Remaining Time:* ${remaining}\n` +
    `⏱️ *First Logged:* ${formatClock(p.created_at)} (${agoLabel(minutesBetween(p.created_at, p.db_now))}) at ${firstHub}\n` +
    `👥 *Party Size:* ${partyLabel(p.party_size)}\n` +
    `👤 *Description:* ${sanitize(p.description)}\n` +
    `📝 *Reasoning:* ${sanitize(p.reasoning)}`;

  // Re-scan / breach history only when there is more than the initial log.
  if (p.events.length > 1) {
    const breaches = p.events.filter((e) => e.is_breach_event).length;
    const shown = p.events.slice(-MAX_HISTORY_LINES);
    msg += `\n\n🔄 *Scan Event History:*${breaches ? ` (⚠️ ${breaches} breach event${breaches === 1 ? '' : 's'})` : ''}`;
    if (shown.length < p.events.length) msg += `\n_…${p.events.length - shown.length} earlier events omitted_`;
    for (const e of shown) {
      msg += `\n• ${formatClock(e.timestamp)} [${e.hub_location}]: ${actionLabel(e.action_logged, sanitize(e.steward_name, 100))}`;
    }
  }
  return msg;
}

export function formatNotFound(queryId: string): string {
  return `❌ *No Database Record Extracted for Ticket ID:* ${sanitize(queryId, 64)}`;
}
