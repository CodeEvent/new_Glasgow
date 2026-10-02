export type BotCommand = { kind: 'check'; ticketId: string } | { kind: 'help' } | { kind: 'invalid_check'; raw: string };

// "Check TM-847294-X", "check: tm 847294 x", "CHECK #ABC123" -> ticket id with whitespace stripped.
const CHECK_RE = /^\s*check\b\s*[:#-]?\s*(.*?)\s*$/i;
const HELP_RE = /^\s*(gatekeeper\s+)?help\s*$/i;
// QR payloads can carry base64-ish characters; whitespace is never part of an ID.
const TICKET_ID_RE = /^[\x21-\x7E]{1,64}$/;

/** Returns the bot command in a group message, or null if the message is ordinary chat. */
export function parseCommand(text: string | undefined | null): BotCommand | null {
  if (!text) return null;
  if (HELP_RE.test(text)) return { kind: 'help' };
  const m = CHECK_RE.exec(text);
  if (!m) return null;
  const ticketId = m[1].replace(/\s+/g, '');
  if (!TICKET_ID_RE.test(ticketId)) return { kind: 'invalid_check', raw: m[1] };
  return { kind: 'check', ticketId };
}

export const HELP_TEXT =
  '🤖 *GATEKEEPER BOT*\n\n' +
  'Commands:\n' +
  '• *Check [TICKET_ID]* — full status and scan history for a ticket\n' +
  '  e.g. _Check TM-847294-X_\n' +
  '• *Help* — this message';
