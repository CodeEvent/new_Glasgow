import type { ScanInput, ScanOutcome } from './scanService';
import type { MessagePriority } from './whatsapp';
import {
  agoLabel,
  formatClock,
  mapsLink,
  minutesBetween,
  minutesUntil,
  partyLabel,
  sanitize,
  statusLabel,
} from './format';

export interface AlertMessage {
  body: string;
  priority: MessagePriority;
}

function delayedPrefix(outcome: ScanOutcome, replayed: boolean): string {
  return replayed ? `⏪ *DELAYED SYNC* (scan occurred ${formatClock(outcome.evaluatedAt)}, buffered while DB was offline)\n\n` : '';
}

function locationLine(input: ScanInput): string {
  const link = mapsLink(input.latitude, input.longitude);
  return link ? `\n📍 *GPS:* ${link}` : '';
}

/** Builds the WhatsApp group message for a scan outcome, or null when no alert is warranted. */
export function buildScanAlert(input: ScanInput, outcome: ScanOutcome, replayed = false): AlertMessage | null {
  const { ticket, originEvent, evaluatedAt } = outcome;
  if (!ticket || outcome.alertPriority === 'none') return null;

  const prefix = delayedPrefix(outcome, replayed);
  const id = sanitize(ticket.ticket_id, 64);
  const desc = sanitize(ticket.description);
  const reasoning = sanitize(ticket.reasoning);
  const steward = sanitize(input.steward_name, 100);
  const originHub = originEvent?.hub_location ?? 'unknown hub';
  const originSteward = originEvent ? sanitize(originEvent.steward_name, 100) : 'unknown';
  const minsSinceOrigin = originEvent ? minutesBetween(originEvent.timestamp, evaluatedAt) : 0;
  const originKind = outcome.previousStatus === 'cooling_off' ? 'cool-off' : 'refusal';

  switch (outcome.scenario) {
    case 'NEW_INCIDENT': {
      const header =
        ticket.current_status === 'cooling_off'
          ? `🟠 *COOL-OFF LOGGED — ${input.hub_location}*`
          : `🔴 *ENTRY REFUSED — ${input.hub_location}*`;
      const timing =
        ticket.current_status === 'cooling_off' && ticket.cool_down_until
          ? `\n⏳ *Allowed back after:* ${formatClock(ticket.cool_down_until)} (${minutesUntil(ticket.cool_down_until, evaluatedAt)} mins)`
          : '\n⛔ *Not to be admitted tonight.*';
      return {
        priority: 'standard',
        body:
          `${prefix}${header}\n\n` +
          `🎟️ *Ticket ID:* ${id}` +
          timing +
          `\n👥 *Party Size:* ${partyLabel(ticket.party_size)}` +
          `\n👤 *Description:* ${desc}` +
          `\n📝 *Reasoning:* ${reasoning}` +
          `\n🧑‍✈️ *Logged by:* ${steward} at ${formatClock(evaluatedAt)}` +
          locationLine(input) +
          `\n\n_All hubs: watch for this ticket. Reply "Check ${id}" for full history._`,
      };
    }

    case 'HUB_HOP_BYPASS': {
      const remaining =
        ticket.current_status === 'cooling_off' && ticket.cool_down_until
          ? `\n⏳ *Cool-off remaining:* ${minutesUntil(ticket.cool_down_until, evaluatedAt)} mins (until ${formatClock(ticket.cool_down_until)})`
          : '';
      return {
        priority: 'high',
        body:
          `${prefix}🚨 *CRITICAL RE-SCAN DETECTED:* Ticket ${id} is attempting a gate-bypass at *${input.hub_location}*! ` +
          `Original ${originKind} logged at *${originHub}* ${agoLabel(minsSinceOrigin)} (${desc}).\n\n` +
          `📊 *Status:* ${statusLabel(ticket.current_status)}` +
          remaining +
          `\n👥 *Party Size:* ${partyLabel(ticket.party_size)}` +
          `\n🧑‍✈️ *Intercepted by:* ${steward} at ${formatClock(evaluatedAt)}` +
          `\n🧑‍✈️ *Original call by:* ${originSteward} (${originHub})` +
          locationLine(input) +
          `\n\n⛔ *ENTRY BLOCKED — DO NOT ADMIT. ALL HUBS BE ALERT.*`,
      };
    }

    case 'UNAUTHORIZED_ADMISSION': {
      const crossHub = originEvent && originHub !== input.hub_location ? ' (different hub — hub-hop succeeded)' : '';
      return {
        priority: 'critical',
        body:
          `${prefix}🚨🚨 *CRITICAL SECURITY BREACH — UNAUTHORIZED ADMISSION* 🚨🚨\n\n` +
          `Ticket *${id}* was ADMITTED at *${input.hub_location}*${crossHub} by steward *${steward}* ` +
          `despite being flagged ${statusLabel(outcome.previousStatus ?? 'completely_refused')}.\n\n` +
          `🚪 *Breach entry point:* ${input.hub_location}` +
          `\n🧑‍✈️ *Authorised by:* ${steward} at ${formatClock(evaluatedAt)}` +
          `\n📌 *Original ${originKind}:* ${originHub} by ${originSteward}, ${agoLabel(minsSinceOrigin)}` +
          `\n👥 *Party Size:* ${partyLabel(ticket.party_size)}` +
          `\n👤 *Description:* ${desc}` +
          `\n📝 *Reasoning:* ${reasoning}` +
          locationLine(input) +
          `\n\n‼️ *Supervisors: locate and intercept this party inside the venue immediately.*`,
      };
    }

    case 'CLEARED_ADMISSION':
      return {
        priority: 'standard',
        body:
          `${prefix}🟢 *CLEARED ADMISSION — ${input.hub_location}*\n\n` +
          `🎟️ *Ticket ID:* ${id}\n` +
          `Cool-off (logged at ${originHub}) expired; admitted by ${steward} at ${formatClock(evaluatedAt)}.`,
      };

    case 'REASSESSMENT':
      return {
        priority: 'standard',
        body:
          `${prefix}🔁 *RE-ASSESSMENT — ${input.hub_location}*\n\n` +
          `🎟️ *Ticket ID:* ${id}\n` +
          `📊 *Status:* ${statusLabel(outcome.previousStatus!)} → ${statusLabel(ticket.current_status)}` +
          (ticket.current_status === 'cooling_off' && ticket.cool_down_until
            ? `\n⏳ *New cool-off ends:* ${formatClock(ticket.cool_down_until)}`
            : '') +
          `\n🧑‍✈️ *By:* ${steward} at ${formatClock(evaluatedAt)}`,
      };

    default:
      return null;
  }
}

/** Sent when the database is unreachable so the group still sees the live feed. */
export function buildOfflineAlert(input: ScanInput): AlertMessage {
  const action =
    input.action_logged === 'cool_off'
      ? '🟠 Cool-off (30 min)'
      : input.action_logged === 'refused'
        ? '🔴 Completely refused'
        : '🟢 Admitted';
  return {
    priority: input.action_logged === 'admitted' ? 'high' : 'standard',
    body:
      `⚠️ *DATABASE OFFLINE — INCIDENT BUFFERED LOCALLY* ⚠️\n\n` +
      `🎟️ *Ticket ID:* ${sanitize(input.ticket_id, 64)}\n` +
      `🚪 *Hub:* ${input.hub_location}\n` +
      `📋 *Action:* ${action}\n` +
      `🧑‍✈️ *Steward:* ${sanitize(input.steward_name, 100)}\n` +
      (input.description ? `👤 *Description:* ${sanitize(input.description)}\n` : '') +
      `\n_Hub-hopping checks are unavailable until the database recovers. Treat any ticket posted here as flagged._`,
  };
}
