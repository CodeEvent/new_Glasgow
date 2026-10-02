import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { getConfig } from '../config/env';
import { HELP_TEXT, parseCommand } from '../services/commandParser';
import {
  formatNotFound,
  formatSeatNotFound,
  formatTicketProfile,
  getTicketProfile,
  getTicketProfileBySeat,
} from '../services/ticketLookup';
import { sendGroupMessage } from '../services/whatsapp';

export interface InboundTextMessage {
  id: string;
  from: string;
  groupId: string | null;
  text: string;
}

// Minimal shape of Meta's webhook payload that we rely on.
interface MetaMessage {
  id?: string;
  from?: string;
  type?: string;
  group_id?: string;
  text?: { body?: string };
  context?: { group_id?: string };
}
interface MetaWebhookBody {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: { group_id?: string; metadata?: { group_id?: string }; messages?: MetaMessage[] };
    }>;
  }>;
}

/** Flattens a Meta webhook body into text messages, tolerating the various group-id placements. */
export function extractTextMessages(body: unknown): InboundTextMessage[] {
  const out: InboundTextMessage[] = [];
  const b = body as MetaWebhookBody;
  if (!b || !Array.isArray(b.entry)) return out;
  for (const entry of b.entry) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      for (const msg of value?.messages ?? []) {
        if (msg.type !== 'text' || !msg.text?.body || !msg.id) continue;
        out.push({
          id: msg.id,
          from: msg.from ?? '',
          groupId: msg.group_id ?? msg.context?.group_id ?? value?.group_id ?? value?.metadata?.group_id ?? null,
          text: msg.text.body,
        });
      }
    }
  }
  return out;
}

/**
 * Only the designated supervisors' group, or a supervisor texting the bot directly
 * (WHATSAPP_SUPERVISOR_NUMBERS), is answered. Everyone else is ignored.
 */
export function isFromDesignatedGroup(msg: InboundTextMessage): boolean {
  const cfg = getConfig();
  const groupId = cfg.WHATSAPP_GROUP_ID;
  if (groupId && msg.groupId === groupId) return true;
  if (msg.groupId !== null) return false;
  const from = msg.from.replace(/\D/g, '');
  // `from === groupId` supports sandbox setups where the "group" is a single test number.
  return (groupId !== undefined && msg.from === groupId) || cfg.WHATSAPP_SUPERVISOR_NUMBERS.includes(from);
}

/** Validates Meta's X-Hub-Signature-256 header when WHATSAPP_APP_SECRET is configured. */
export function verifySignature(rawBody: Buffer | undefined, header: string | undefined): boolean {
  const secret = getConfig().WHATSAPP_APP_SECRET;
  if (!secret) return true;
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header.slice('sha256='.length));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Meta retries deliveries; remember recent message ids so a command is answered once.
const SEEN_LIMIT = 5_000;
const seen = new Set<string>();
function firstTime(id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
  return true;
}

/** Handles one inbound message; returns the reply body that was sent (or null). */
export async function handleInboundMessage(msg: InboundTextMessage): Promise<string | null> {
  if (!isFromDesignatedGroup(msg)) {
    // Shown in the server log so a first-time setup can see whose number to allow.
    console.warn(`[webhook] ignored message from ${msg.from}${msg.groupId ? ` in group ${msg.groupId}` : ''} (not in WHATSAPP_SUPERVISOR_NUMBERS / WHATSAPP_GROUP_ID)`);
    return null;
  }
  if (!firstTime(msg.id)) return null;
  const cmd = parseCommand(msg.text);
  if (!cmd) return null;

  let reply: string;
  if (cmd.kind === 'help') {
    reply = HELP_TEXT;
  } else if (cmd.kind === 'invalid_check') {
    reply = `⚠️ Could not read a ticket ID from that message.\n\n${HELP_TEXT}`;
  } else {
    const what = cmd.kind === 'check' ? cmd.ticketId : `Section ${cmd.section} Row ${cmd.row} Seat ${cmd.seat}`;
    try {
      if (cmd.kind === 'check') {
        const profile = await getTicketProfile(cmd.ticketId);
        reply = profile ? formatTicketProfile(profile) : formatNotFound(cmd.ticketId);
      } else {
        let profile = await getTicketProfileBySeat(cmd.section, cmd.row, cmd.seat);
        if (!profile && cmd.fallbackTicketId) profile = await getTicketProfile(cmd.fallbackTicketId);
        reply = profile ? formatTicketProfile(profile) : formatSeatNotFound(cmd.section, cmd.row, cmd.seat);
      }
    } catch (err) {
      console.error('[webhook] lookup failed:', (err as Error).message);
      reply = `⚠️ *Database unavailable*: could not look up ${what}. Check the latest alerts in this chat and try again shortly.`;
    }
  }
  const replyTo = msg.groupId ?? msg.from;
  await sendGroupMessage(reply, 'standard', replyTo);
  return reply;
}

export const whatsappWebhookRouter = Router();

// Meta webhook verification handshake.
whatsappWebhookRouter.get('/incoming', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (typeof mode !== 'string' || typeof token !== 'string' || typeof challenge !== 'string') {
    res.status(400).type('text/plain').send('Missing hub.mode, hub.verify_token or hub.challenge');
    return;
  }
  const expected = Buffer.from(getConfig().WHATSAPP_VERIFY_TOKEN);
  const given = Buffer.from(token);
  const tokenOk = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (mode === 'subscribe' && tokenOk) {
    res.status(200).type('text/plain').send(challenge);
    return;
  }
  res.status(403).type('text/plain').send('Verification failed');
});

// Inbound messages. Acknowledge immediately (Meta expects a fast 200), then process.
whatsappWebhookRouter.post('/incoming', (req: Request, res: Response) => {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!verifySignature(raw, req.get('x-hub-signature-256'))) {
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200);

  const messages = extractTextMessages(req.body);
  for (const msg of messages) {
    handleInboundMessage(msg).catch((err) => console.error('[webhook] handler error:', err));
  }
});
