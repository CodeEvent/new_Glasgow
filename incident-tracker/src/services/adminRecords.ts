import { getConfig } from '../config/env';
import { getPool } from '../db/pool';
import { HUBS, STATUSES, type Hub, type IncidentStatus } from '../domain';

/**
 * Supervisor view of everything logged (WhatsApp bot or web form): list, search,
 * correct, delete, export. Used by /admin/records.
 */

export interface RecordFilter {
  q?: string; // seat, description, reason or ticket code
  hub?: Hub; // any log at this hub
  status?: IncidentStatus;
  breaches?: boolean; // only people who tried another hub
}

export interface RecordRow {
  ticket_id: string;
  current_status: IncidentStatus;
  description: string;
  reasoning: string;
  cool_down_until: Date | null;
  created_at: Date;
  updated_at: Date;
  section: string | null;
  row_label: string | null;
  seat_number: string | null;
  origin_hub: Hub | null;
  origin_steward: string | null;
  origin_at: Date | null;
  breaches: number;
  photos: number;
  party_size: number;
  notes: string | null; // "22:10 Dave: came back calm | …", oldest first
}

export function parseFilter(query: Record<string, unknown>): RecordFilter {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const hub = str(query.hub);
  const status = str(query.status);
  return {
    q: str(query.q)?.replace(/\s+/g, ' ').slice(0, 100),
    hub: HUBS.includes(hub as Hub) ? (hub as Hub) : undefined,
    status: STATUSES.includes(status as IncidentStatus) ? (status as IncidentStatus) : undefined,
    breaches: query.breaches === '1' || query.breaches === 'true',
  };
}

export async function listRecords(f: RecordFilter, limit = 500): Promise<RecordRow[]> {
  const { rows } = await getPool().query<RecordRow>(
    `SELECT t.ticket_id, t.current_status, t.description, t.reasoning, t.cool_down_until,
            t.created_at, t.updated_at, t.section, t.row_label, t.seat_number,
            o.hub_location AS origin_hub, o.steward_name AS origin_steward, o.timestamp AS origin_at,
            (SELECT count(*)::int FROM scan_events b WHERE b.ticket_id = t.ticket_id AND b.is_breach_event) AS breaches,
            (SELECT count(*)::int FROM ticket_photos p WHERE p.ticket_id = t.ticket_id) AS photos,
            t.party_size,
            (SELECT string_agg(n.author || ': ' || n.body, ' | ' ORDER BY n.created_at)
               FROM ticket_notes n WHERE n.ticket_id = t.ticket_id) AS notes
       FROM tickets t
       LEFT JOIN LATERAL (
         SELECT hub_location, steward_name, timestamp FROM scan_events e
          WHERE e.ticket_id = t.ticket_id ORDER BY timestamp ASC LIMIT 1
       ) o ON TRUE
      WHERE ($1::text IS NULL
             OR upper(concat_ws(' ', t.section, t.row_label, t.seat_number, t.description, t.reasoning, t.ticket_id)) LIKE '%' || upper($1::text) || '%'
             OR EXISTS (SELECT 1 FROM ticket_notes q WHERE q.ticket_id = t.ticket_id AND upper(q.body) LIKE '%' || upper($1::text) || '%'))
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM scan_events h WHERE h.ticket_id = t.ticket_id AND h.hub_location::text = $2::text))
        AND ($3::text IS NULL OR t.current_status::text = $3::text)
        AND (NOT $4::boolean OR EXISTS (SELECT 1 FROM scan_events x WHERE x.ticket_id = t.ticket_id AND x.is_breach_event))
      ORDER BY t.updated_at DESC
      LIMIT $5`,
    [f.q ?? null, f.hub ?? null, f.status ?? null, f.breaches ?? false, limit],
  );
  return rows;
}

export async function getRecord(ticketId: string) {
  const pool = getPool();
  const [t, events, photos, notes] = await Promise.all([
    pool.query<RecordRow>(
      `SELECT ticket_id, current_status, description, reasoning, cool_down_until, created_at, updated_at,
              section, row_label, seat_number, party_size
         FROM tickets WHERE ticket_id = $1`,
      [ticketId],
    ),
    pool.query(
      `SELECT hub_location, steward_name, action_logged, is_breach_event, timestamp
         FROM scan_events WHERE ticket_id = $1 ORDER BY timestamp ASC`,
      [ticketId],
    ),
    pool.query<{ id: string; created_at: Date }>(
      'SELECT id, created_at FROM ticket_photos WHERE ticket_id = $1 ORDER BY created_at DESC',
      [ticketId],
    ),
    getNotes(ticketId),
  ]);
  if (!t.rows[0]) return null;
  return { ...t.rows[0], events: events.rows, photos: photos.rows, notes };
}

export interface TicketNote {
  author: string;
  body: string;
  created_at: Date;
}

export async function getNotes(ticketId: string): Promise<TicketNote[]> {
  const { rows } = await getPool().query<TicketNote>(
    'SELECT author, body, created_at FROM ticket_notes WHERE ticket_id = $1 ORDER BY created_at',
    [ticketId],
  );
  return rows;
}

/** Adds a note and counts it as activity on the record (so the 24h retention restarts). */
export async function addNote(ticketId: string, author: string, body: string): Promise<void> {
  const text = body.trim().slice(0, 500);
  if (!text) throw new Error('Empty note');
  await getPool().query('INSERT INTO ticket_notes (ticket_id, author, body) VALUES ($1, $2, $3)', [ticketId, author.slice(0, 100) || 'Steward', text]);
  await getPool().query('UPDATE tickets SET party_size = party_size WHERE ticket_id = $1', [ticketId]); // fires the updated_at trigger
}

export async function getPhoto(ticketId: string, photoId: string): Promise<{ data: Buffer; mime: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(photoId)) return null;
  const { rows } = await getPool().query<{ data: Buffer; mime_type: string }>(
    'SELECT data, mime_type FROM ticket_photos WHERE ticket_id = $1 AND id = $2',
    [ticketId, photoId],
  );
  return rows[0] ? { data: Buffer.from(rows[0].data), mime: rows[0].mime_type } : null;
}

export interface RecordUpdate {
  status?: IncidentStatus;
  description?: string;
  reasoning?: string;
}

/** Supervisor corrections. A new "cooling off" restarts the cool-off from now. */
export async function updateRecord(ticketId: string, u: RecordUpdate): Promise<boolean> {
  if (u.status !== undefined && !STATUSES.includes(u.status)) throw new Error('Unknown status');
  const text = (v: string | undefined, name: string) => {
    if (v === undefined) return null;
    const s = String(v).trim();
    if (s.length > 2000) throw new Error(`${name} is too long`);
    return s || 'Not provided';
  };
  const { rowCount } = await getPool().query(
    `UPDATE tickets SET
        current_status  = COALESCE($2::incident_status, current_status),
        cool_down_until = CASE
                            WHEN $2::text IS NULL THEN cool_down_until
                            WHEN $2::text = 'cooling_off' THEN NOW() + make_interval(mins => $5::int)
                            ELSE NULL
                          END,
        description     = COALESCE($3::text, description),
        reasoning       = COALESCE($4::text, reasoning)
      WHERE ticket_id = $1`,
    [ticketId, u.status ?? null, text(u.description, 'Description'), text(u.reasoning, 'Reason'), getConfig().COOL_OFF_MINUTES],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteRecord(ticketId: string): Promise<boolean> {
  const { rowCount } = await getPool().query('DELETE FROM tickets WHERE ticket_id = $1', [ticketId]);
  return (rowCount ?? 0) > 0;
}

const STATUS_TEXT: Record<IncidentStatus, string> = {
  completely_refused: 'Refused',
  cooling_off: 'Sent away',
  admitted: 'Admitted',
};

/** "2026-10-03 21:40" in the venue's time zone, which spreadsheets read as a date. */
function localStamp(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: getConfig().TZ_DISPLAY, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

function csvCell(v: unknown): string {
  let s = v instanceof Date ? localStamp(v) : v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets running it as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function recordsToCsv(rows: RecordRow[]): string {
  const head = ['Section', 'Row', 'Seat', 'Status', 'Reason', 'Description', 'Party', 'Notes', 'First hub', 'Logged by', 'Logged at', 'Back after', 'Tried another hub', 'Photos', 'Ticket'];
  const lines = rows.map((r) =>
    [
      r.section, r.row_label, r.seat_number, STATUS_TEXT[r.current_status], r.reasoning, r.description, r.party_size, r.notes,
      r.origin_hub, r.origin_steward, r.origin_at, r.cool_down_until, r.breaches, r.photos, r.ticket_id,
    ].map(csvCell).join(','),
  );
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}
