import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getConfig } from '../config/env';
import { withTransaction } from '../db/pool';
import { HUBS, normalizeSeatPart, seatKey, type Hub, type IntakeAction, type LoggedAction, type ScanEventRow, type TicketRow } from '../domain';

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

const ACTION_ALIASES: Record<string, IntakeAction> = {
  cool_off: 'cool_off',
  cooloff: 'cool_off',
  cooling_off: 'cool_off',
  initial_cool_off: 'cool_off',
  sent_away: 'cool_off',
  refused: 'refused',
  refuse: 'refused',
  refusal: 'refused',
  completely_refused: 'refused',
  initial_refusal: 'refused',
  admitted: 'admitted',
  admit: 'admitted',
};

const optionalCoord = (min: number, max: number) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.coerce.number().min(min).max(max).optional(),
  );

const seatPart = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(max).regex(/^[A-Za-z0-9 ]+$/, 'letters and numbers only').optional(),
  );

const scanObject = z.object({
  /** Text from the ticket QR code. Optional when the full seat is given. */
  ticket_id: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(64, 'ticket_id must be at most 64 characters').optional(),
  ),
  section: seatPart(16),
  row: seatPart(8),
  seat: seatPart(8),
  hub_location: z.enum(HUBS),
  latitude: optionalCoord(-90, 90),
  longitude: optionalCoord(-180, 180),
  steward_name: z.string().trim().min(1, 'steward_name is required').max(100),
  action_logged: z.preprocess(
    (v) => (typeof v === 'string' ? ACTION_ALIASES[v.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? v : v),
    z.enum(['cool_off', 'refused', 'admitted']),
  ),
  party_size: z.coerce.number().int().min(1).max(500).optional(),
  description: z.string().trim().max(2000).optional(),
  indicators: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  reasoning: z.string().trim().max(2000).optional(),
  /**
   * When the scan actually happened. Used by the device-side queue and offline
   * re-sync so cool-down windows and history reflect real time, not sync time.
   * Clamped server-side to [now - 24h, now].
   */
  occurred_at: z.iso.datetime({ offset: true }).optional(),
});

export const scanInputSchema = scanObject
  .superRefine((v, ctx) => {
    const parts = [v.section, v.row, v.seat].filter(Boolean).length;
    if (parts !== 0 && parts !== 3) {
      ctx.addIssue({ code: 'custom', path: ['seat'], message: 'Give section, row and seat together' });
    }
    if (!v.ticket_id && parts !== 3) {
      ctx.addIssue({ code: 'custom', path: ['ticket_id'], message: 'Scan the ticket QR code or enter the section, row and seat' });
    }
  })
  .transform((v) => ({
    ...v,
    // Seat-only scans get a deterministic ID so every hub logging the same seat lands on one record.
    ticket_id: v.ticket_id ?? `SEAT-${[v.section!, v.row!, v.seat!].map(normalizeSeatPart).join('-')}`.slice(0, 64),
  }));

export type ScanInput = z.output<typeof scanInputSchema>;

export function inputSeatKey(input: Pick<ScanInput, 'section' | 'row' | 'seat'>): string | null {
  return input.section && input.row && input.seat ? seatKey(input.section, input.row, input.seat) : null;
}

// ---------------------------------------------------------------------------
// Outcome contract
// ---------------------------------------------------------------------------

export type Scenario =
  | 'NEW_INCIDENT' // Scenario A
  | 'HUB_HOP_BYPASS' // Scenario B
  | 'UNAUTHORIZED_ADMISSION' // Scenario C
  | 'CLEARED_ADMISSION' // admitted after a cool-off legitimately expired
  | 'REASSESSMENT' // same hub re-scan; latest assessment applied
  | 'REPEAT_SCAN' // no state change
  | 'NO_INCIDENT'; // admitted ticket with no record: nothing stored

export type AlertPriority = 'none' | 'standard' | 'high' | 'critical';

export interface ScanOutcome {
  scenario: Scenario;
  alertPriority: AlertPriority;
  /** True when the steward's screen must show a hard "DO NOT ADMIT" block. */
  blockEntry: boolean;
  ticket: TicketRow | null;
  event: ScanEventRow | null;
  /** The event that opened the current incident (origin hub / first log). */
  originEvent: ScanEventRow | null;
  /** Ticket state before this scan (null for brand-new tickets). */
  previousStatus: TicketRow['current_status'] | null;
  /** Server time the scan was evaluated at. */
  evaluatedAt: Date;
  /** How the existing record was found: by the QR/ticket code, or by seat (e.g. a rotated SafeTix code). */
  matchedBy: 'ticket' | 'seat' | null;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const FLAGGED = new Set(['cooling_off', 'completely_refused']);

function buildReasoning(input: ScanInput): string {
  const parts: string[] = [];
  if (input.indicators?.length) parts.push(input.indicators.join(', '));
  if (input.reasoning) parts.push(input.reasoning);
  return parts.join('. ') || 'Not provided';
}

async function insertEvent(
  client: PoolClient,
  input: ScanInput,
  action: LoggedAction,
  at: Date,
): Promise<ScanEventRow> {
  const isBreach = action === 'bypass_attempt' || action === 'unauthorized_admission';
  const { rows } = await client.query<ScanEventRow>(
    `INSERT INTO scan_events
       (ticket_id, hub_location, latitude, longitude, steward_name, action_logged, is_breach_event, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.ticket_id,
      input.hub_location,
      input.latitude ?? null,
      input.longitude ?? null,
      input.steward_name,
      action,
      isBreach,
      at,
    ],
  );
  return rows[0];
}

async function lockTicket(client: PoolClient, ticketId: string): Promise<TicketRow | null> {
  const { rows } = await client.query<TicketRow>('SELECT * FROM tickets WHERE ticket_id = $1 FOR UPDATE', [ticketId]);
  return rows[0] ?? null;
}

async function lockTicketBySeat(client: PoolClient, key: string): Promise<TicketRow | null> {
  const { rows } = await client.query<TicketRow>(
    'SELECT * FROM tickets WHERE seat_key = $1 ORDER BY updated_at DESC LIMIT 1 FOR UPDATE',
    [key],
  );
  return rows[0] ?? null;
}

/** The event that opened the ticket's current incident: the latest initial_* log. */
async function originEventFor(client: PoolClient, ticketId: string): Promise<ScanEventRow | null> {
  const { rows } = await client.query<ScanEventRow>(
    `SELECT * FROM scan_events
      WHERE ticket_id = $1 AND action_logged IN ('initial_cool_off', 'initial_refusal')
      ORDER BY timestamp DESC
      LIMIT 1`,
    [ticketId],
  );
  if (rows[0]) return rows[0];
  // Fallback for rows written by other tools: the very first log for the ticket.
  const first = await client.query<ScanEventRow>(
    'SELECT * FROM scan_events WHERE ticket_id = $1 ORDER BY timestamp ASC LIMIT 1',
    [ticketId],
  );
  return first.rows[0] ?? null;
}

/**
 * Evaluates one steward scan against the business rules inside a single
 * transaction. The ticket row is locked (SELECT ... FOR UPDATE) so two hubs
 * scanning the same ticket at the same moment are serialised.
 *
 * Alerts are NOT sent from here; the caller dispatches them after COMMIT so a
 * rolled-back transaction can never produce a WhatsApp message.
 */
export async function processScan(rawInput: ScanInput): Promise<ScanOutcome> {
  const coolOffMinutes = getConfig().COOL_OFF_MINUTES;
  const key = inputSeatKey(rawInput);

  return withTransaction(async (client) => {
    let input = rawInput;
    let matchedBy: ScanOutcome['matchedBy'] = null;
    // One authoritative clock (the DB's), optionally back-dated for queued/offline scans.
    const clock = await client.query<{ at: Date }>(
      `SELECT GREATEST(LEAST(COALESCE($1::timestamptz, NOW()), NOW()), NOW() - INTERVAL '24 hours') AS at`,
      [input.occurred_at ?? null],
    );
    const at = clock.rows[0].at;

    let ticket = await lockTicket(client, input.ticket_id);
    if (ticket) {
      matchedBy = 'ticket';
    } else if (key) {
      // Unknown code but a known seat: the same patron presenting a rotated or different code.
      ticket = await lockTicketBySeat(client, key);
      if (ticket) {
        matchedBy = 'seat';
        input = { ...input, ticket_id: ticket.ticket_id };
      }
    }
    if (ticket && key && !ticket.seat_key) {
      // First time we learn this ticket's seat: remember it for later lookups.
      const upd = await client.query<TicketRow>(
        'UPDATE tickets SET section = $2, row_label = $3, seat_number = $4 WHERE ticket_id = $1 RETURNING *',
        [ticket.ticket_id, input.section, input.row, input.seat],
      );
      ticket = upd.rows[0];
    }

    // ---------------- SCENARIO A: new incident ----------------
    if (!ticket) {
      if (input.action_logged === 'admitted') {
        // Nothing on record and nothing to record: a clean admission.
        return {
          scenario: 'NO_INCIDENT',
          alertPriority: 'none',
          blockEntry: false,
          ticket: null,
          event: null,
          originEvent: null,
          previousStatus: null,
          evaluatedAt: at,
      matchedBy,
        };
      }

      const status = input.action_logged === 'cool_off' ? 'cooling_off' : 'completely_refused';
      const inserted = await client.query<TicketRow>(
        `INSERT INTO tickets
           (ticket_id, current_status, party_size, description, reasoning, cool_down_until, created_at,
            section, row_label, seat_number)
         VALUES ($1, $2::incident_status, $3, $4, $5,
                 CASE WHEN $2::incident_status = 'cooling_off' THEN $6::timestamptz + make_interval(mins => $7) END,
                 $6, $8, $9, $10)
         ON CONFLICT (ticket_id) DO NOTHING
         RETURNING *`,
        [
          input.ticket_id,
          status,
          input.party_size ?? 1,
          input.description || 'Not provided',
          buildReasoning(input),
          at,
          coolOffMinutes,
          input.section ?? null,
          input.row ?? null,
          input.seat ?? null,
        ],
      );

      if (inserted.rows[0]) {
        const event = await insertEvent(
          client,
          input,
          status === 'cooling_off' ? 'initial_cool_off' : 'initial_refusal',
          at,
        );
        return {
          scenario: 'NEW_INCIDENT',
          alertPriority: 'standard',
          blockEntry: false,
          ticket: inserted.rows[0],
          event,
          originEvent: event,
          previousStatus: null,
          evaluatedAt: at,
      matchedBy,
        };
      }

      // Lost a race with another hub inserting the same ticket: fall through to the existing-ticket rules.
      ticket = await lockTicket(client, input.ticket_id);
      if (!ticket) throw new Error(`Ticket ${input.ticket_id} vanished during concurrent insert`);
      matchedBy = 'ticket';
    }

    const previousStatus = ticket.current_status;
    const originEvent = await originEventFor(client, input.ticket_id);
    const originHub: Hub | null = originEvent?.hub_location ?? null;

    if (FLAGGED.has(ticket.current_status)) {
      if (input.action_logged === 'admitted') {
        const coolOffExpired =
          ticket.current_status === 'cooling_off' &&
          ticket.cool_down_until !== null &&
          new Date(ticket.cool_down_until).getTime() <= at.getTime();

        // ---------------- SCENARIO C: unauthorized admission ----------------
        // Takes precedence over hub-hopping: the person is already inside.
        const updated = await client.query<TicketRow>(
          `UPDATE tickets SET current_status = 'admitted' WHERE ticket_id = $1 RETURNING *`,
          [input.ticket_id],
        );
        const event = await insertEvent(
          client,
          input,
          coolOffExpired ? 'cleared_admission' : 'unauthorized_admission',
          at,
        );
        return {
          scenario: coolOffExpired ? 'CLEARED_ADMISSION' : 'UNAUTHORIZED_ADMISSION',
          alertPriority: coolOffExpired ? 'standard' : 'critical',
          blockEntry: false,
          ticket: updated.rows[0],
          event,
          originEvent,
          previousStatus,
          evaluatedAt: at,
      matchedBy,
        };
      }

      // ---------------- SCENARIO B: hub hopping ----------------
      if (originHub && input.hub_location !== originHub) {
        // Ticket status is deliberately left untouched.
        const event = await insertEvent(client, input, 'bypass_attempt', at);
        return {
          scenario: 'HUB_HOP_BYPASS',
          alertPriority: 'high',
          blockEntry: true,
          ticket,
          event,
          originEvent,
          previousStatus,
          evaluatedAt: at,
      matchedBy,
        };
      }

      // Same hub: apply the supervisor's latest assessment (escalate to refusal or restart the cool-off).
      const status = input.action_logged === 'cool_off' ? 'cooling_off' : 'completely_refused';
      const updated = await client.query<TicketRow>(
        `UPDATE tickets
            SET current_status = $2::incident_status,
                cool_down_until = CASE WHEN $2::incident_status = 'cooling_off' THEN $3::timestamptz + make_interval(mins => $4) END,
                party_size = COALESCE($5, party_size),
                description = COALESCE(NULLIF($6, ''), description)
          WHERE ticket_id = $1
          RETURNING *`,
        [input.ticket_id, status, at, coolOffMinutes, input.party_size ?? null, input.description ?? null],
      );
      const event = await insertEvent(client, input, 'repeat_scan', at);
      return {
        scenario: 'REASSESSMENT',
        alertPriority: 'standard',
        blockEntry: true,
        ticket: updated.rows[0],
        event,
        originEvent,
        previousStatus,
        evaluatedAt: at,
      matchedBy,
      };
    }

    // Ticket is currently 'admitted'.
    if (input.action_logged === 'admitted') {
      const event = await insertEvent(client, input, 'repeat_scan', at);
      return {
        scenario: 'REPEAT_SCAN',
        alertPriority: 'none',
        blockEntry: false,
        ticket,
        event,
        originEvent,
        previousStatus,
        evaluatedAt: at,
      matchedBy,
      };
    }

    // A previously admitted ticket is refused/cooled again (e.g. re-entry attempt): open a new incident.
    const status = input.action_logged === 'cool_off' ? 'cooling_off' : 'completely_refused';
    const updated = await client.query<TicketRow>(
      `UPDATE tickets
          SET current_status = $2::incident_status,
              cool_down_until = CASE WHEN $2::incident_status = 'cooling_off' THEN $3::timestamptz + make_interval(mins => $4) END,
              party_size = COALESCE($5, party_size),
              description = COALESCE(NULLIF($6, ''), description),
              reasoning = $7
        WHERE ticket_id = $1
        RETURNING *`,
      [
        input.ticket_id,
        status,
        at,
        coolOffMinutes,
        input.party_size ?? null,
        input.description ?? null,
        buildReasoning(input),
      ],
    );
    const event = await insertEvent(
      client,
      input,
      status === 'cooling_off' ? 'initial_cool_off' : 'initial_refusal',
      at,
    );
    return {
      scenario: 'NEW_INCIDENT',
      alertPriority: 'standard',
      blockEntry: false,
      ticket: updated.rows[0],
      event,
      originEvent: event,
      previousStatus,
      evaluatedAt: at,
      matchedBy,
    };
  });
}
