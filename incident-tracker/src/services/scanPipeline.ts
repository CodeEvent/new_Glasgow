import { isConnectivityError } from '../db/pool';
import { buildOfflineAlert, buildScanAlert } from './alerts';
import { appendOfflineIncident } from './offlineBuffer';
import { processScan, type ScanInput, type ScanOutcome } from './scanService';
import { dispatchAlert, type SendResult } from './whatsapp';
import { formatClock, minutesUntil, statusLabel } from './format';

export interface StewardScreen {
  level: 'clear' | 'info' | 'warning' | 'critical';
  block_entry: boolean;
  headline: string;
  message: string;
}

export type PipelineResult =
  | { kind: 'processed'; outcome: ScanOutcome; screen: StewardScreen; alert: Promise<SendResult> | null }
  | { kind: 'buffered'; bufferId: string; screen: StewardScreen; alert: Promise<SendResult> };

/** What the steward's phone shows after submitting. */
export function stewardScreen(outcome: ScanOutcome): StewardScreen {
  const t = outcome.ticket;
  const origin = outcome.originEvent;
  switch (outcome.scenario) {
    case 'NO_INCIDENT':
      return { level: 'clear', block_entry: false, headline: 'No incident on record', message: 'Ticket has no refusal or cool-off history.' };
    case 'NEW_INCIDENT':
      return {
        level: 'info',
        block_entry: false,
        headline: t?.current_status === 'cooling_off' ? 'Cool-off logged' : 'Refusal logged',
        message:
          t?.current_status === 'cooling_off' && t.cool_down_until
            ? `Allowed back after ${formatClock(t.cool_down_until)}. All hubs notified.`
            : 'Not to be admitted. All hubs notified.',
      };
    case 'HUB_HOP_BYPASS':
      return {
        level: 'critical',
        block_entry: true,
        headline: '⛔ DO NOT ADMIT — HUB HOPPER',
        message:
          `This ticket is ${statusLabel(t!.current_status)} from ${origin?.hub_location ?? 'another hub'}` +
          (t!.current_status === 'cooling_off' && t!.cool_down_until
            ? ` (${minutesUntil(t!.cool_down_until, outcome.evaluatedAt)} mins of cool-off left)`
            : '') +
          `. Description: ${t!.description}. Supervisors have been alerted.`,
      };
    case 'UNAUTHORIZED_ADMISSION':
      return {
        level: 'critical',
        block_entry: true,
        headline: '🚨 SECURITY BREACH LOGGED',
        message: `This ticket was flagged at ${origin?.hub_location ?? 'another hub'} and must not be admitted. The admission has been recorded against your name and supervisors alerted.`,
      };
    case 'CLEARED_ADMISSION':
      return { level: 'info', block_entry: false, headline: 'Cool-off complete', message: 'Cool-off period has expired. Admission recorded.' };
    case 'REASSESSMENT':
      return {
        level: 'warning',
        block_entry: true,
        headline: 'Re-assessment recorded',
        message: `Status now ${statusLabel(t!.current_status)}. Do not admit.`,
      };
    case 'REPEAT_SCAN':
      return { level: 'info', block_entry: false, headline: 'Already admitted', message: 'Ticket was previously admitted.' };
  }
}

/**
 * Full scan lifecycle: transactional state machine -> post-commit alert dispatch.
 * On database connectivity failure the scan is written to the offline log and an
 * "offline" notice still goes to WhatsApp (when `bufferOnOutage` is set).
 */
export async function runScanPipeline(
  input: ScanInput,
  opts: { replayed?: boolean; bufferOnOutage?: boolean } = {},
): Promise<PipelineResult> {
  const { replayed = false, bufferOnOutage = true } = opts;
  let outcome: ScanOutcome;
  try {
    outcome = await processScan(input);
  } catch (err) {
    if (!bufferOnOutage || !isConnectivityError(err)) throw err;
    console.error(`[scan] database unreachable, buffering ticket ${input.ticket_id}: ${(err as Error).message}`);
    // Pin the real scan time so a later re-sync back-dates correctly.
    const entry = appendOfflineIncident({ ...input, occurred_at: input.occurred_at ?? new Date().toISOString() }, (err as Error).message);
    const offline = buildOfflineAlert(input);
    return {
      kind: 'buffered',
      bufferId: entry.buffer_id,
      alert: dispatchAlert(offline.body, offline.priority),
      screen: {
        level: 'warning',
        block_entry: input.action_logged !== 'admitted',
        headline: 'Saved offline',
        message: 'Database unreachable. Scan saved to the emergency log and will sync automatically. Supervisors notified via WhatsApp.',
      },
    };
  }

  const alert = buildScanAlert(input, outcome, replayed);
  return {
    kind: 'processed',
    outcome,
    screen: stewardScreen(outcome),
    alert: alert ? dispatchAlert(alert.body, alert.priority) : null,
  };
}
