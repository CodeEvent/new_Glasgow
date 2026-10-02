import { isConnectivityError } from '../db/pool';
import { statusLabel } from './format';
import { runScanPipeline, type PipelineResult } from './scanPipeline';
import { scanInputSchema } from './scanService';
import { getTicketProfile, getTicketProfileBySeat } from './ticketLookup';

/**
 * Transport-agnostic handlers behind POST /api/scan and GET /api/tickets/:id.
 * Express calls these; so does the in-browser demo build.
 */
export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export async function handleScanRequest(
  raw: unknown,
  onAlert?: (p: NonNullable<PipelineResult['alert']>) => void,
): Promise<ApiResponse> {
  const parsed = scanInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'Invalid scan payload',
        details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      },
    };
  }

  try {
    const result = await runScanPipeline(parsed.data);
    if (result.alert) onAlert?.(result.alert);
    if (result.kind === 'buffered') {
      return { status: 202, body: { ok: true, buffered: true, buffer_id: result.bufferId, screen: result.screen } };
    }
    const { outcome, screen } = result;
    return {
      status: outcome.scenario === 'NEW_INCIDENT' ? 201 : 200,
      body: {
        ok: true,
        buffered: false,
        scenario: outcome.scenario,
        alert_priority: outcome.alertPriority,
        is_breach: outcome.event?.is_breach_event ?? false,
        screen,
        ticket: outcome.ticket,
        event: outcome.event,
        origin_hub: outcome.originEvent?.hub_location ?? null,
      },
    };
  } catch (err) {
    console.error('[scan] unhandled error:', err);
    return { status: 500, body: { ok: false, error: 'Scan could not be processed. Radio your supervisor.' } };
  }
}

export interface LookupQuery {
  ticket_id?: unknown;
  section?: unknown;
  row?: unknown;
  seat?: unknown;
}

/** Looks a patron up by ticket code, falling back to section / row / seat. Accepts a bare ID for compatibility. */
export async function handleTicketLookup(query: unknown): Promise<ApiResponse> {
  const q: LookupQuery = typeof query === 'object' && query !== null ? (query as LookupQuery) : { ticket_id: query };
  const str = (v: unknown, max: number) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s && s.length <= max ? s : '';
  };
  const id = str(q.ticket_id, 64);
  const section = str(q.section, 16);
  const row = str(q.row, 8);
  const seat = str(q.seat, 8);
  const hasSeat = Boolean(section && row && seat);
  if (!id && !hasSeat) {
    return { status: 400, body: { ok: false, error: 'Give a ticket_id (1-64 characters) or section, row and seat' } };
  }
  try {
    let matchedBy: 'ticket' | 'seat' = 'ticket';
    let p = id ? await getTicketProfile(id) : null;
    if (!p && hasSeat) {
      p = await getTicketProfileBySeat(section, row, seat);
      matchedBy = 'seat';
    }
    if (!p) return { status: 200, body: { ok: true, found: false } };
    return {
      status: 200,
      body: {
        ok: true,
        found: true,
        matched_by: matchedBy,
        flagged: p.current_status !== 'admitted',
        status_label: statusLabel(p.current_status),
        origin_hub:
          p.events.find((e) => e.action_logged.startsWith('initial_'))?.hub_location ?? p.events[0]?.hub_location ?? null,
        mins_left: p.mins_left,
        ticket: p,
      },
    };
  } catch (err) {
    const offline = isConnectivityError(err);
    return {
      status: offline ? 503 : 500,
      body: { ok: false, offline, error: offline ? 'Database unreachable' : 'Lookup failed' },
    };
  }
}
