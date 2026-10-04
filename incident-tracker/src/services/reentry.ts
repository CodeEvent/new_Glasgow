import { getPool } from '../db/pool';

/** "Intoxicated, Already refused, tried re-entry" -> its reasons (the re-entry one has a lower-case "tried"). */
export function splitReasons(reasoning: string | null | undefined): string[] {
  if (!reasoning || reasoning === 'Not provided') return [];
  return reasoning.split(/,\s*(?=[A-Z])/).map((r) => r.trim()).filter(Boolean);
}

/**
 * A re-entry attempt: add "Already refused, tried re-entry" (or "sent away") and any new reasons
 * to the existing record, without repeats. Returns the new reasoning.
 */
export async function addReentryReason(ticketId: string, current: string, previousStatus: string, newReasons?: string): Promise<string> {
  const label = previousStatus === 'cooling_off' ? 'Already sent away, tried re-entry' : 'Already refused, tried re-entry';
  const merged = splitReasons(current);
  for (const r of [label, ...splitReasons(newReasons)]) if (!merged.includes(r)) merged.push(r);
  const text = merged.join(', ').slice(0, 2000);
  if (text !== current) await getPool().query('UPDATE tickets SET reasoning = $2 WHERE ticket_id = $1', [ticketId, text]);
  return text;
}
