/**
 * Loader for Baileys (WhatsApp Web protocol library). It ships as an ES module
 * while this app compiles to CommonJS, so it is loaded with a real dynamic
 * import that TypeScript leaves untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const esmImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface BaileysModule {
  default: (config: Record<string, unknown>) => WASocket;
  makeWASocket?: (config: Record<string, unknown>) => WASocket;
  BufferJSON: { replacer: (k: string, v: any) => any; reviver: (k: string, v: any) => any };
  initAuthCreds: () => any;
  proto: { Message: { AppStateSyncKeyData: { fromObject: (o: any) => any } } };
  DisconnectReason: Record<string, number>;
  Browsers: Record<string, (name: string) => [string, string, string]>;
  fetchLatestBaileysVersion: () => Promise<{ version: [number, number, number] }>;
  downloadMediaMessage: (msg: WAMessage, type: 'buffer', options: Record<string, unknown>) => Promise<Buffer>;
}

export type OutgoingContent =
  | { text: string }
  | { image: Buffer; caption?: string; mimetype?: string }
  | { document: Buffer; mimetype: string; fileName: string };

export interface WAMessage {
  key: { remoteJid?: string | null; fromMe?: boolean | null; id?: string | null; participant?: string | null };
  message?: any;
  messageTimestamp?: number | { toNumber(): number } | null;
  pushName?: string | null;
}

export interface WASocket {
  ev: { on(event: string, handler: (arg: any) => void): void; removeAllListeners(event?: string): void };
  user?: { id: string; name?: string } | null;
  sendMessage(jid: string, content: OutgoingContent, options?: { quoted?: WAMessage }): Promise<unknown>;
  groupFetchAllParticipating(): Promise<Record<string, { id: string; subject: string; participants: unknown[] }>>;
  requestPairingCode(phoneNumber: string): Promise<string>;
  logout(): Promise<void>;
  end(err?: Error): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let cached: Promise<BaileysModule> | null = null;
export function loadBaileys(): Promise<BaileysModule> {
  cached = cached ?? (esmImport('@whiskeysockets/baileys') as Promise<BaileysModule>);
  return cached;
}
