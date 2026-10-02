import { Router, type Request, type Response } from 'express';
import { stewardAuth } from '../middleware/stewardAuth';
import { runScanPipeline } from '../services/scanPipeline';
import { scanInputSchema } from '../services/scanService';
import { getTicketProfile } from '../services/ticketLookup';
import { isConnectivityError } from '../db/pool';
import { statusLabel } from '../services/format';

export const scanRouter = Router();

scanRouter.post('/scan', stewardAuth, async (req: Request, res: Response) => {
  const parsed = scanInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'Invalid scan payload',
      details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
    return;
  }

  try {
    const result = await runScanPipeline(parsed.data);
    if (result.kind === 'buffered') {
      res.status(202).json({ ok: true, buffered: true, buffer_id: result.bufferId, screen: result.screen });
      return;
    }
    const { outcome, screen } = result;
    res.status(outcome.scenario === 'NEW_INCIDENT' ? 201 : 200).json({
      ok: true,
      buffered: false,
      scenario: outcome.scenario,
      alert_priority: outcome.alertPriority,
      is_breach: outcome.event?.is_breach_event ?? false,
      screen,
      ticket: outcome.ticket,
      event: outcome.event,
      origin_hub: outcome.originEvent?.hub_location ?? null,
    });
  } catch (err) {
    console.error('[scan] unhandled error:', err);
    res.status(500).json({ ok: false, error: 'Scan could not be processed. Radio your supervisor.' });
  }
});

/** Read-only pre-check the intake form calls straight after the QR is scanned. */
scanRouter.get('/tickets/:ticketId', stewardAuth, async (req: Request, res: Response) => {
  const id = String(req.params.ticketId ?? '').trim();
  if (!id || id.length > 64) {
    res.status(400).json({ ok: false, error: 'ticket_id must be 1-64 characters' });
    return;
  }
  try {
    const p = await getTicketProfile(id);
    if (!p) {
      res.json({ ok: true, found: false });
      return;
    }
    const flagged = p.current_status !== 'admitted';
    res.json({
      ok: true,
      found: true,
      flagged,
      status_label: statusLabel(p.current_status),
      origin_hub: p.events.find((e) => e.action_logged.startsWith('initial_'))?.hub_location ?? p.events[0]?.hub_location ?? null,
      mins_left: p.mins_left,
      ticket: p,
    });
  } catch (err) {
    const offline = isConnectivityError(err);
    res.status(offline ? 503 : 500).json({ ok: false, offline, error: offline ? 'Database unreachable' : 'Lookup failed' });
  }
});
