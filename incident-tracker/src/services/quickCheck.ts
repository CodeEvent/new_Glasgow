import { seatLabel } from '../domain';
import { agoLabel, formatClock, minutesBetween, partyLabel, sanitize } from './format';
import type { TicketProfile } from './ticketLookup';

/**
 * Short answer for a steward at a gate asking in the group: is this seat refused?
 * The first line answers the question; detail follows for whoever needs it.
 */
export function formatQuickCheck(
  p: TicketProfile | null,
  query: { section?: string; row?: string; seat?: string; ticketId?: string },
): string {
  const asked = query.ticketId
    ? `Ticket ${sanitize(query.ticketId, 64)}`
    : `${sanitize(query.section ?? '', 16)} / ${sanitize(query.row ?? '', 8)} / ${sanitize(query.seat ?? '', 8)}`;

  if (!p) return `✅ *NOT REFUSED* · ${asked}\nNo refusal or cool-off on record.`;

  const where = seatLabel(p.section, p.row_label, p.seat_number) ?? `Ticket ${sanitize(p.ticket_id, 64)}`;
  const origin = p.events.find((e) => e.action_logged === 'initial_refusal' || e.action_logged === 'initial_cool_off') ?? p.events[0];
  const originLine = origin
    ? `${origin.action_logged === 'initial_cool_off' ? 'Sent away' : 'Refused'} at *${origin.hub_location}* ${formatClock(origin.timestamp)} (${agoLabel(minutesBetween(origin.timestamp, p.db_now))}) by ${sanitize(origin.steward_name, 100)}`
    : null;

  let head: string;
  if (p.current_status === 'completely_refused') {
    head = /^Ejected/.test(p.reasoning ?? '')
      ? `⛔ *EJECTED* · ${where}\n⛔ Removed from inside. Do not admit.`
      : `🔴 *REFUSED* · ${where}\n⛔ Do not admit.`;
  } else if (p.current_status === 'cooling_off') {
    head = p.mins_left
      ? `🟠 *COOLING OFF* · ${where}\n⛔ Not before ${p.cool_down_until ? formatClock(p.cool_down_until) : '?'} (${p.mins_left} min left).`
      : `🟡 *COOL-OFF ENDED* · ${where}\nMay be admitted if now fit to enter.`;
  } else {
    const admitted = [...p.events].reverse().find((e) => e.action_logged.endsWith('admission'));
    head =
      `🟢 *ADMITTED* · ${where}` +
      (admitted
        ? `\nLet in at ${admitted.hub_location} ${formatClock(admitted.timestamp)} by ${sanitize(admitted.steward_name, 100)}` +
          (admitted.action_logged === 'unauthorized_admission' ? ' 🚨 *without clearance*' : '')
        : '');
  }

  const lines = [head];
  if (originLine) lines.push(originLine);
  lines.push(`👤 ${sanitize(p.description, 200)} · ${partyLabel(p.party_size)}`);
  if (p.reasoning && p.reasoning !== 'Not provided') lines.push(`📝 ${sanitize(p.reasoning, 200)}`);

  const attempts = p.events.filter((e) => e.action_logged === 'bypass_attempt');
  if (attempts.length) {
    lines.push(
      `🚨 Tried again: ${attempts
        .slice(-3)
        .map((e) => `${e.hub_location} ${formatClock(e.timestamp)}`)
        .join(', ')}${attempts.length > 3 ? ` (+${attempts.length - 3} more)` : ''}`,
    );
  }
  return lines.join('\n');
}
