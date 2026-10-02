export type BotCommand =
  | { kind: 'check'; ticketId: string }
  | { kind: 'check_seat'; section: string; row: string; seat: string; fallbackTicketId?: string }
  | { kind: 'help' }
  | { kind: 'invalid_check'; raw: string };

// "Check TM-847294-X", "check: tm 847294 x", "CHECK #ABC123" -> ticket id with whitespace stripped.
const CHECK_RE = /^\s*check\b\s*[:#-]?\s*(.*?)\s*$/i;
const HELP_RE = /^\s*(gatekeeper\s+)?(help|menu|\?)\s*$/i;
// QR payloads can carry base64-ish characters; whitespace is never part of an ID.
const TICKET_ID_RE = /^[\x21-\x7E]{1,64}$/;

// "Section 112 Row F Seat 14", "sec 112, row f, seat 14", "Block 112 Row F Seat 14", "S112 RF S14".
const SEAT_LABELLED_RE =
  /^(?:section|sect|sec|block|blk|s)\.?\s*:?\s*([a-z0-9]{1,16})\s*[,;/]?\s*(?:row|rw|r)\.?\s*:?\s*([a-z0-9]{1,8})\s*[,;/]?\s*(?:seat|st|s)\.?\s*:?\s*([a-z0-9]{1,8})$/i;
// Shorthand "112 F 14", "112/F/14", "112, F, 14". Dashes are left to ticket IDs (TM-847294-X).
const SEAT_SHORT_RE = /^([a-z0-9]{1,16})\s*[\s/,|]\s*([a-z0-9]{1,4})\s*[\s/,|]\s*([a-z0-9]{1,4})$/i;

/** Returns the bot command in a message, or null if the message is ordinary chat. */
export function parseCommand(text: string | undefined | null): BotCommand | null {
  if (!text) return null;
  if (HELP_RE.test(text)) return { kind: 'help' };
  const m = CHECK_RE.exec(text);
  if (!m) return null;
  const rest = m[1];

  const labelled = SEAT_LABELLED_RE.exec(rest);
  if (labelled) return { kind: 'check_seat', section: labelled[1], row: labelled[2], seat: labelled[3] };

  const ticketId = rest.replace(/\s+/g, '');
  const short = SEAT_SHORT_RE.exec(rest);
  if (short) {
    // "Check AB 12 C" could be either; try the seat first, then the joined code.
    return {
      kind: 'check_seat',
      section: short[1],
      row: short[2],
      seat: short[3],
      fallbackTicketId: TICKET_ID_RE.test(ticketId) ? ticketId : undefined,
    };
  }

  if (!TICKET_ID_RE.test(ticketId)) return { kind: 'invalid_check', raw: rest };
  return { kind: 'check', ticketId };
}

export const HELP_TEXT =
  '🤖 *GATEKEEPER BOT*\n\n' +
  'Look up a patron by ticket code or by seat:\n' +
  '• *Check TM-847294-X*\n' +
  '• *Check Section 112 Row F Seat 14*\n' +
  '• *Check 112 F 14*\n\n' +
  'You get their status, cool-off time left, description and every gate they have tried.\n' +
  '• *Help*: this message';
