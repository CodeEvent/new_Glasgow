import { getConfig } from '../config/env';
import { HELP_TEXT, parseGroupMessage } from '../services/commandParser';
import { formatQuickCheck } from '../services/quickCheck';
import { getTicketProfile, getTicketProfileBySeat } from '../services/ticketLookup';
import { StewardBot } from '../services/stewardBot';
import { registerAlertSink } from '../services/whatsapp';
import { loadBaileys, type WAMessage, type WASocket } from './baileys';
import { clearPostgresAuthState, getSetting, setSetting, usePostgresAuthState } from './pgAuthState';

/**
 * Group bot on a spare WhatsApp number, connected as a "linked device" (the
 * same mechanism as WhatsApp Web). It sits in the work group like a colleague
 * and answers seat checks such as "BB 212 100".
 *
 * Unofficial: WhatsApp's terms don't allow automating a normal account, and
 * WhatsApp may ban the spare number. It reads only the groups chosen on the
 * admin page, answers only messages that look like a check, and posts nothing
 * unprompted unless WA_LINKED_POST_ALERTS is on.
 */

export type LinkStatus =
  | 'disabled'
  | 'starting'
  | 'waiting_for_link'
  | 'connected'
  | 'reconnecting'
  | 'logged_out'
  | 'replaced'
  | 'error';

export interface GroupRef {
  jid: string;
  subject: string;
}

const GROUPS_SETTING = 'linked_whatsapp_groups';
const MAX_MESSAGE_AGE_S = 120; // ignore backlog delivered on reconnect
const REPLY_GAP_MS = 700; // pacing between replies in one group
const MAX_QUEUED_PER_GROUP = 20;

/** The answer the bot would post for a group message, or null to stay quiet. Pure apart from DB reads. */
export async function answerGroupMessage(text: string | null | undefined): Promise<string | null> {
  const cmd = parseGroupMessage(text);
  if (!cmd) return null;
  if (cmd.kind === 'help') return HELP_TEXT;
  if (cmd.kind === 'invalid_check') return null;
  try {
    if (cmd.kind === 'check') {
      return formatQuickCheck(await getTicketProfile(cmd.ticketId), { ticketId: cmd.ticketId });
    }
    let profile = await getTicketProfileBySeat(cmd.section, cmd.row, cmd.seat);
    if (!profile && cmd.fallbackTicketId) profile = await getTicketProfile(cmd.fallbackTicketId);
    return formatQuickCheck(profile, cmd);
  } catch (err) {
    console.error('[linked-wa] lookup failed:', (err as Error).message);
    return '⚠️ Gatekeeper can’t reach its database right now. Treat this seat as *unchecked* and ask a supervisor.';
  }
}

/** Text of a WhatsApp message, looking inside disappearing / view-once / edited wrappers. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function messageText(message: any): string | null {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ??
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      m.documentWithCaptionMessage?.message ??
      m.editedMessage?.message?.protocolMessage?.editedMessage;
    if (!inner) break;
    m = inner;
  }
  return m?.conversation ?? m?.extendedTextMessage?.text ?? m?.imageMessage?.caption ?? null;
}

/** The image part of a message (looking inside disappearing / view-once wrappers), if any. */
export function messageImage(message: any): { mimetype?: string; caption?: string } | null {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    if (m.imageMessage) return m.imageMessage;
    m = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message;
  }
  return null;
}

function timestampSeconds(ts: WAMessage['messageTimestamp']): number {
  if (typeof ts === 'number') return ts;
  if (ts && typeof (ts as any).toNumber === 'function') return (ts as any).toNumber();
  return Math.floor(Date.now() / 1000);
}

// Baileys expects a pino-style logger. Keep only real problems.
const quietLogger: any = {
  level: 'error',
  child: () => quietLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: (obj: unknown, msg?: string) => console.error('[linked-wa]', msg ?? '', typeof obj === 'object' ? JSON.stringify(obj).slice(0, 300) : obj),
  fatal: (obj: unknown, msg?: string) => console.error('[linked-wa] FATAL', msg ?? '', obj),
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export class LinkedWhatsApp {
  status: LinkStatus = 'disabled';
  qr: string | null = null;
  me: { id: string; name?: string } | null = null;
  lastError: string | null = null;
  groups: GroupRef[] = [];
  /** Groups the bot has seen messages in but that aren't selected yet (helps first-time setup). */
  seenGroups = new Map<string, number>();

  private sock: WASocket | null = null;
  private bot = new StewardBot();
  /** Everyone in the selected groups, so they can also talk to the bot in a private chat. */
  private members = new Set<string>();
  private membersRefreshedAt = 0;
  private stopped = false;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private queues = new Map<string, { chain: Promise<void>; size: number }>();
  private unregisterSink: (() => void) | null = null;

  async start(): Promise<void> {
    this.stopped = false;
    this.status = 'starting';
    this.groups = await getSetting<GroupRef[]>(GROUPS_SETTING, []);
    if (getConfig().WA_LINKED_POST_ALERTS && !this.unregisterSink) {
      this.unregisterSink = registerAlertSink((body) => this.postToGroups(body));
    }
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.unregisterSink?.();
    this.unregisterSink = null;
    this.sock?.ev.removeAllListeners();
    this.sock?.end();
    this.sock = null;
  }

  private scheduleReconnect(delayMs: number) {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.status = 'error';
        this.lastError = (err as Error).message;
        this.scheduleReconnect(Math.min(60_000, 2_000 * 2 ** this.attempts++));
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.status !== 'waiting_for_link' && this.status !== 'logged_out') this.status = 'starting';
    const b = await loadBaileys();
    const { state, saveCreds } = await usePostgresAuthState(b);

    let version: [number, number, number] | undefined;
    try {
      version = (await Promise.race([
        b.fetchLatestBaileysVersion(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5_000)),
      ])).version;
    } catch {
      version = undefined; // fall back to the library's built-in version
    }

    const make = b.makeWASocket ?? b.default;
    const browser = b.Browsers.ubuntu?.('Gatekeeper') ?? b.Browsers.appropriate?.('Gatekeeper');
    const sock = make({
      ...(version ? { version } : {}),
      connectTimeoutMs: 20_000,
      auth: state,
      logger: quietLogger,
      browser,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      saveCreds().catch((err) => console.error('[linked-wa] could not save session:', err.message));
    });

    sock.ev.on('connection.update', (u: { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number }; message?: string } } }) => {
      if (u.qr) {
        this.qr = u.qr;
        this.status = 'waiting_for_link';
      }
      if (u.connection === 'open') {
        this.status = 'connected';
        this.qr = null;
        this.attempts = 0;
        this.lastError = null;
        this.me = sock.user ?? null;
        console.log(`[linked-wa] connected as ${this.me?.id ?? 'unknown'}; answering in ${this.groups.length} group(s)`);
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        this.lastError = u.lastDisconnect?.error?.message ?? null;
        console.warn(`[linked-wa] connection closed (code ${code ?? 'none'}: ${this.lastError ?? 'no reason given'})`);
        sock.ev.removeAllListeners();
        if (this.sock === sock) this.sock = null;
        if (this.stopped) return;

        if (code === b.DisconnectReason.loggedOut) {
          // Unlinked from the phone: forget the session and offer a fresh QR.
          console.warn('[linked-wa] the phone unlinked this device; waiting to be linked again');
          this.status = 'logged_out';
          this.me = null;
          clearPostgresAuthState()
            .catch(() => undefined)
            .finally(() => this.scheduleReconnect(2_000));
        } else if (code === b.DisconnectReason.connectionReplaced) {
          // Another server instance (e.g. during a deploy) took over the session. Don't fight it.
          console.warn('[linked-wa] another instance took over this WhatsApp session; this one is standing down');
          this.status = 'replaced';
        } else {
          this.status = 'reconnecting';
          const delay = code === b.DisconnectReason.restartRequired ? 0 : Math.min(30_000, 1_000 * 2 ** this.attempts++);
          this.scheduleReconnect(delay);
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }: { messages: WAMessage[]; type: string }) => {
      if (type !== 'notify') return;
      for (const msg of messages) this.onMessage(msg);
    });
  }

  private onMessage(msg: WAMessage): void {
    const jid = msg.key.remoteJid;
    if (!jid || msg.key.fromMe) return; // never react to our own messages
    if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return; // statuses, channels
    if (Date.now() / 1000 - timestampSeconds(msg.messageTimestamp) > MAX_MESSAGE_AGE_S) return;

    const isGroup = jid.endsWith('@g.us');
    if (isGroup && !this.groups.some((g) => g.jid === jid)) {
      this.seenGroups.set(jid, Date.now());
      return;
    }
    const senderId = isGroup ? (msg.key.participant ?? '') : jid;
    if (!senderId) return;

    this.enqueue(jid, async () => {
      // Private chats are only for colleagues who are in a selected group.
      if (!isGroup && !(await this.isMember(senderId))) return;

      const img = messageImage(msg.message);
      let image: { data: Buffer; mime: string } | null = null;
      if (img) {
        try {
          const b = await loadBaileys();
          image = { data: await b.downloadMediaMessage(msg, 'buffer', {}), mime: img.mimetype ?? 'image/jpeg' };
        } catch (err) {
          console.error('[linked-wa] could not download photo:', (err as Error).message);
        }
      }
      const text = img ? (img.caption ?? null) : messageText(msg.message);
      if (!text && !image) return;

      const replies = await this.bot.handle({
        chatId: jid,
        senderId,
        senderName: msg.pushName ?? senderId.split('@')[0],
        text,
        image,
        at: new Date(timestampSeconds(msg.messageTimestamp) * 1000),
      });
      for (const r of replies) {
        if (!this.sock) return;
        if (r.image) await this.sock.sendMessage(jid, { image: r.image.data, caption: r.text, mimetype: r.image.mime }, { quoted: msg });
        else await this.sock.sendMessage(jid, { text: r.text }, { quoted: msg });
      }
    });
  }

  private async isMember(senderId: string): Promise<boolean> {
    if (!this.sock || this.groups.length === 0) return false;
    if (Date.now() - this.membersRefreshedAt > 10 * 60_000 || !this.members.has(senderId)) {
      try {
        const all = await this.sock.groupFetchAllParticipating();
        const ids = new Set<string>();
        for (const g of Object.values(all)) {
          if (!this.groups.some((s) => s.jid === g.id)) continue;
          for (const p of g.participants as Array<Record<string, string | undefined>>) {
            for (const k of ['id', 'jid', 'lid', 'phoneNumber']) if (p[k]) ids.add(p[k]!);
          }
        }
        this.members = ids;
        this.membersRefreshedAt = Date.now();
      } catch (err) {
        console.error('[linked-wa] could not refresh group members:', (err as Error).message);
      }
    }
    return this.members.has(senderId);
  }

  /** One reply at a time per group, gently paced, with a cap so a flood can't build a backlog. */
  private enqueue(jid: string, task: () => Promise<void>): void {
    const q = this.queues.get(jid) ?? { chain: Promise.resolve(), size: 0 };
    if (q.size >= MAX_QUEUED_PER_GROUP) return;
    q.size++;
    q.chain = q.chain
      .then(task)
      .catch((err) => console.error('[linked-wa] reply failed:', (err as Error).message))
      .then(() => new Promise<void>((r) => setTimeout(r, REPLY_GAP_MS)))
      .finally(() => {
        q.size--;
      });
    this.queues.set(jid, q);
  }

  private async postToGroups(body: string): Promise<void> {
    if (this.status !== 'connected' || !this.sock) return;
    for (const g of this.groups) {
      this.enqueue(g.jid, async () => {
        await this.sock?.sendMessage(g.jid, { text: body });
      });
    }
  }

  // ---------------------------------------------------------------- admin actions

  async pairingCode(phone: string): Promise<string> {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) throw new Error('Enter the spare number with country code, e.g. +44 7700 900123');
    if (!this.sock || this.status !== 'waiting_for_link') throw new Error('Not ready to link yet. Wait for the QR code to appear, then try again.');
    return this.sock.requestPairingCode(digits);
  }

  async listGroups(): Promise<Array<GroupRef & { members: number; selected: boolean }>> {
    if (!this.sock || this.status !== 'connected') throw new Error('Link the phone first');
    const all = await this.sock.groupFetchAllParticipating();
    return Object.values(all)
      .map((g) => ({ jid: g.id, subject: g.subject, members: g.participants.length, selected: this.groups.some((s) => s.jid === g.id) }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
  }

  async setGroups(groups: GroupRef[]): Promise<void> {
    this.groups = groups.filter((g) => g.jid.endsWith('@g.us')).map((g) => ({ jid: g.jid, subject: String(g.subject).slice(0, 100) }));
    await setSetting(GROUPS_SETTING, this.groups);
  }

  async sendTest(jid: string): Promise<void> {
    if (!this.sock || this.status !== 'connected') throw new Error('Link the phone first');
    await this.sock.sendMessage(jid, {
      text: '✅ *Gatekeeper is connected to this group.*\nSend a seat to check it, e.g. *52 YY 14*, or type *Help*.',
    });
  }

  async logout(): Promise<void> {
    try {
      await this.sock?.logout();
    } catch {
      /* already gone */
    }
    await clearPostgresAuthState();
    this.me = null;
    this.status = 'logged_out';
    this.scheduleReconnect(1_000);
  }
}

export const linkedWhatsApp = new LinkedWhatsApp();
