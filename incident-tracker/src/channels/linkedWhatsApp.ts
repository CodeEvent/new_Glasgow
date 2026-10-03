import { getConfig } from '../config/env';
import { HELP_TEXT, parseGroupMessage } from '../services/commandParser';
import { formatQuickCheck } from '../services/quickCheck';
import { getTicketProfile, getTicketProfileBySeat } from '../services/ticketLookup';
import { createAiAgent } from '../services/aiProvider';
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
/** JIDs @mentioned in a text message. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function messageMentions(message: any): string[] {
  const ctx = message?.extendedTextMessage?.contextInfo ?? message?.imageMessage?.contextInfo;
  return Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid.filter((j: unknown): j is string => typeof j === 'string') : [];
}

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
export function messageImage(message: any): { mimetype?: string; caption?: string; fileLength?: unknown } | null {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    if (m.imageMessage) return m.imageMessage;
    m = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message;
  }
  return null;
}

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_VOICE_BYTES = 3 * 1024 * 1024; // ~3 minutes of WhatsApp voice

class TooBigError extends Error {}

/**
 * Downloads media without ever holding more than `max` bytes: refuses files whose declared size is
 * too big, and stops reading as soon as the real size passes the limit (the declared size comes
 * from the sender's app, so it can be missing or wrong).
 */
async function downloadCapped(msg: WAMessage, declared: unknown, max: number): Promise<Buffer> {
  const size = typeof declared === 'number' ? declared : Number((declared as { toNumber?: () => number })?.toNumber?.() ?? declared ?? 0);
  if (size > max) throw new TooBigError();
  const b = await loadBaileys();
  const stream = await b.downloadMediaMessage(msg, 'stream', {});
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > max) {
      stream.destroy();
      throw new TooBigError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** A voice note or audio clip (unwrapping ephemeral messages). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function messageAudio(message: any): { mimetype?: string; seconds?: number; fileLength?: unknown } | null {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    if (m.audioMessage) return m.audioMessage;
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
  private bot = (() => {
    const bot = new StewardBot();
    bot.announce = (text, exceptChatId) => void this.postToGroups(text, exceptChatId);
    bot.canSupervise = (senderId) => this.isAdmin(senderId);
    return bot;
  })();
  /** Everyone in the selected groups, so they can also talk to the bot in a private chat. */
  private members = new Set<string>();
  private admins = new Set<string>(); // admins of the selected groups = supervisors (CLEAR, REPORT)
  private adminChats: string[] = []; // one private chat per admin (phone number if known), for backups and health alerts
  private saidOnline = false;
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
    if (!this.bot.ai) {
      const ai = createAiAgent();
      if (ai) {
        this.bot.ai = ai;
        console.log(`[linked-wa] AI helper on (${ai.model}, up to ${getConfig().AI_DAILY_LIMIT} messages a day)`);
      }
    }
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
        if (!this.saidOnline && getConfig().WA_HEALTH_ALERTS && this.groups.length) {
          this.saidOnline = true; // once per start, not on every reconnect
          const at = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: getConfig().TZ_DISPLAY }).format(new Date());
          void this.sendToAdmins(`✅ Gatekeeper is online (started ${at}).`).catch(() => undefined);
        }
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
    if (!jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return; // statuses, channels
    const isGroup = jid.endsWith('@g.us');
    const where = isGroup ? `group "${this.groups.find((g) => g.jid === jid)?.subject ?? 'not ticked'}"` : 'private chat';
    // One line per message (never its text) so `gk-log` shows why the bot did or didn't answer.
    const note = (what: string) => console.log(`[linked-wa] message in ${where}: ${what}`);

    if (msg.key.fromMe) return note('sent by the bot’s own number, ignored (send from another phone)');
    const age = Math.round(Date.now() / 1000 - timestampSeconds(msg.messageTimestamp));
    if (age > MAX_MESSAGE_AGE_S) {
      return note(`${age}s old, ignored as backlog${age > 600 ? ' (if you just sent it, this device’s clock is wrong: turn on automatic date & time)' : ''}`);
    }
    if (isGroup && !this.groups.some((g) => g.jid === jid)) {
      this.seenGroups.set(jid, Date.now());
      return note('group not ticked on the setup page, ignored');
    }
    const senderId = isGroup ? (msg.key.participant ?? '') : jid;
    if (!senderId) return note('no sender, ignored');
    if (!msg.message) {
      return note('could not be decrypted yet (normal for a few minutes after linking; send it again)');
    }

    this.enqueue(jid, async () => {
      // Private chats are only for colleagues who are in a selected group.
      if (!isGroup && !(await this.isMember(senderId))) return note('sender is not in a ticked group, ignored');

      const img = messageImage(msg.message);
      let image: { data: Buffer; mime: string } | null = null;
      if (img) {
        try {
          image = { data: await downloadCapped(msg, img.fileLength, MAX_PHOTO_BYTES), mime: img.mimetype ?? 'image/jpeg' };
        } catch (err) {
          if (err instanceof TooBigError) {
            await this.sock?.sendMessage(jid, { text: '⚠️ That photo is too big (max 8 MB). Send a normal photo or a screenshot.' }, { quoted: msg });
            return note('photo too big, not downloaded');
          }
          console.error('[linked-wa] could not download photo:', (err as Error).message);
          note('photo could not be downloaded');
          await this.sock?.sendMessage(
            jid,
            { text: '⚠️ I couldn’t download that photo. Please send it again (as a normal photo, not “view once”).' },
            { quoted: msg },
          );
          return;
        }
      }
      // Voice notes: private chats only, and only when the AI can listen (never downloaded otherwise).
      const voice = messageAudio(msg.message);
      let audio: { data: Buffer; mime: string } | null = null;
      if (voice) {
        if (isGroup) return note('voice note in a group, ignored');
        const tooLong = async () => {
          await this.sock?.sendMessage(jid, { text: '🎙️ That voice note is too long. Keep it under a minute, or type it.' }, { quoted: msg });
          return note('voice note too long');
        };
        if ((voice.seconds ?? 0) > 120) return tooLong();
        if (!this.bot.ai?.handleAudio) {
          // The bot will explain voice notes need the Gemini AI: no need to fetch the recording.
          audio = { data: Buffer.alloc(0), mime: voice.mimetype ?? 'audio/ogg' };
        } else try {
          audio = { data: await downloadCapped(msg, voice.fileLength, MAX_VOICE_BYTES), mime: voice.mimetype ?? 'audio/ogg' };
        } catch (err) {
          if (err instanceof TooBigError) return tooLong();
          console.error('[linked-wa] could not download voice note:', (err as Error).message);
          return note('voice note could not be downloaded');
        }
      }
      const text = img ? (img.caption ?? null) : messageText(msg.message);
      if (!text && !image && !audio) return note('no text, photo or voice, ignored');

      const mentioned = messageMentions(msg.message);
      const mentionsBot = mentioned.length > 0 && this.isMe(mentioned);
      const replies = await this.bot.handle({
        chatId: jid,
        senderId,
        senderName: msg.pushName ?? senderId.split('@')[0],
        // "@447… how many refused?" -> "how many refused?"
        text: mentionsBot && text ? text.replace(/@\d{5,}\s*/g, '').trim() : text,
        mentionsBot,
        audio,
        image,
        at: new Date(timestampSeconds(msg.messageTimestamp) * 1000),
      });
      note(replies.length ? `answered (${replies.length} repl${replies.length === 1 ? 'y' : 'ies'})` : 'not a log or seat check, no reply');
      for (const r of replies) {
        if (!this.sock) return;
        if (r.image) await this.sock.sendMessage(jid, { image: r.image.data, caption: r.text, mimetype: r.image.mime }, { quoted: msg });
        else if (r.document) {
          await this.sock.sendMessage(jid, { text: r.text }, { quoted: msg });
          await this.sock.sendMessage(jid, { document: r.document.data, mimetype: r.document.mime, fileName: r.document.fileName });
        } else await this.sock.sendMessage(jid, { text: r.text }, { quoted: msg });
      }
    });
  }

  /** Members (and admins) of the selected groups, refreshed at most every 10 minutes, or 1 minute for an unknown sender. */
  private async refreshMembers(senderId: string, known: Set<string>): Promise<void> {
    if (!this.sock) return;
    const age = Date.now() - this.membersRefreshedAt;
    if (age < (known.has(senderId) ? 10 * 60_000 : 60_000)) return;
    try {
      const all = await this.sock.groupFetchAllParticipating();
      const ids = new Set<string>();
      const admins = new Set<string>();
      const chats: string[] = [];
      for (const g of Object.values(all)) {
        if (!this.groups.some((s) => s.jid === g.id)) continue;
        for (const p of g.participants as Array<Record<string, string | undefined>>) {
          const pIds = ['id', 'jid', 'lid', 'phoneNumber'].map((k) => p[k]).filter((v): v is string => !!v);
          for (const id of pIds) ids.add(id);
          if (p.admin === 'admin' || p.admin === 'superadmin') {
            for (const id of pIds) admins.add(id);
            const chat = pIds.find((id) => id.endsWith('@s.whatsapp.net')) ?? pIds[0];
            if (chat && !this.isMe(pIds) && !chats.includes(chat)) chats.push(chat);
          }
        }
      }
      this.members = ids;
      this.admins = admins;
      this.adminChats = chats;
      this.membersRefreshedAt = Date.now();
    } catch (err) {
      console.error('[linked-wa] could not refresh group members:', (err as Error).message);
    }
  }

  /** Whether any of these ids is the bot's own number ("447…:72@s.whatsapp.net" -> "447…"). */
  private isMe(ids: string[]): boolean {
    const me = [this.me?.id, (this.me as { lid?: string } | null)?.lid].filter(Boolean).map((j) => j!.split(':')[0].split('@')[0]);
    return ids.some((id) => me.includes(id.split(':')[0].split('@')[0]));
  }

  /** Private message (and optional file) to every admin of the selected groups. */
  async sendToAdmins(text: string, document?: { data: Buffer; mime: string; fileName: string }): Promise<number> {
    if (this.status !== 'connected' || !this.sock || this.groups.length === 0) return 0;
    this.membersRefreshedAt = 0; // always use the current admin list
    await this.refreshMembers('', this.admins);
    for (const jid of this.adminChats) {
      this.enqueue(jid, async () => {
        await this.sock?.sendMessage(jid, { text });
        if (document) await this.sock?.sendMessage(jid, { document: document.data, mimetype: document.mime, fileName: document.fileName });
      });
    }
    return this.adminChats.length;
  }

  private async isMember(senderId: string): Promise<boolean> {
    if (!this.sock || this.groups.length === 0) return false;
    await this.refreshMembers(senderId, this.members);
    return this.members.has(senderId);
  }

  /** Supervisors are the WhatsApp admins of a selected group (switch off with WA_SUPERVISOR_ONLY=off). */
  async isAdmin(senderId: string): Promise<boolean> {
    if (!getConfig().WA_SUPERVISOR_ONLY) return true;
    if (!this.sock || this.groups.length === 0) return false;
    await this.refreshMembers(senderId, this.admins);
    return this.admins.has(senderId);
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

  /** Post into every selected group (except one, e.g. where the steward already saw it). */
  async postToGroups(body: string, exceptJid?: string): Promise<void> {
    if (this.status !== 'connected' || !this.sock) return;
    for (const g of this.groups) {
      if (g.jid === exceptJid) continue;
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
