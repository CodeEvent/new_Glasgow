import QRCode from 'qrcode';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../src/db/pool';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

// WhatsApp media downloads go to WhatsApp's servers; return a known image instead.
const media = { buffer: Buffer.alloc(0), downloads: 0 };
vi.mock('../src/channels/baileys', () => ({
  loadBaileys: async () => ({ downloadMediaMessage: async () => (media.downloads++, media.buffer) }),
}));

const { LinkedWhatsApp, messageImage, messageText } = await import('../src/channels/linkedWhatsApp');

const GROUP = '120363000000000001@g.us';
type Sent = { jid: string; content: Record<string, unknown>; quoted: boolean };

function fakeSocket(sent: Sent[]) {
  return {
    user: { id: '447700900999:1@s.whatsapp.net' },
    ev: { on: () => undefined, removeAllListeners: () => undefined },
    sendMessage: async (jid: string, content: Record<string, unknown>, opts?: { quoted?: unknown }) => {
      sent.push({ jid, content, quoted: Boolean(opts?.quoted) });
    },
    groupFetchAllParticipating: async () => ({
      [GROUP]: { id: GROUP, subject: 'Stadium stewards', participants: [{ id: '111@lid', phoneNumber: '447700900111@s.whatsapp.net', admin: 'admin' }, { id: '222@lid' }] },
    }),
    requestPairingCode: async () => 'ABCDEFGH',
    logout: async () => undefined,
    end: () => undefined,
  };
}

function waMsg(jid: string, message: Record<string, unknown>, opts: { participant?: string; ageS?: number; name?: string } = {}) {
  return {
    key: { remoteJid: jid, fromMe: false, id: Math.random().toString(36), participant: opts.participant },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000) - (opts.ageS ?? 0),
    pushName: opts.name ?? 'Dave',
  };
}

const settle = () => new Promise((r) => setTimeout(r, 900));
/** For slow paths (QR decoding): wait until a reply has been sent, up to 5 s. */
const replied = async (sent: unknown[]) => {
  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
};

describe('message unwrapping', () => {
  it('finds text and images inside WhatsApp wrappers', () => {
    expect(messageText({ conversation: 'BB 212 100' })).toBe('BB 212 100');
    expect(messageText({ ephemeralMessage: { message: { extendedTextMessage: { text: 'help' } } } })).toBe('help');
    expect(messageImage({ viewOnceMessageV2: { message: { imageMessage: { caption: 'REFUSED BB 212 100' } } } })).toMatchObject({ caption: 'REFUSED BB 212 100' });
    expect(messageImage({ conversation: 'hi' })).toBeNull();
  });
});

describe.skipIf(!HAS_DB)('linked WhatsApp bot routing (fake socket)', () => {
  let wa: InstanceType<typeof LinkedWhatsApp>;
  let sent: Sent[];

  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    sent = [];
    wa = new LinkedWhatsApp();
    const internals = wa as unknown as { sock: unknown; status: string };
    internals.sock = fakeSocket(sent);
    internals.status = 'connected';
    wa.groups = [{ jid: GROUP, subject: 'Stadium stewards' }];
  });
  afterAll(async () => {
    await closePool();
  });

  const deliver = (m: ReturnType<typeof waMsg>) => (wa as unknown as { onMessage(m: unknown): void }).onMessage(m);

  it('logs and checks in the selected group, replying to the steward’s message', async () => {
    deliver(waMsg(GROUP, { conversation: 'REFUSED BB 212 100 West 1 M 2 2 adult very drunk' }, { participant: '111@lid' }));
    await settle();
    expect(sent[0]).toMatchObject({ jid: GROUP, quoted: true });
    expect(sent[0].content.text).toContain('✅ Logged 🔴 *REFUSED* · BB 212 100');

    deliver(waMsg(GROUP, { conversation: 'BB 212 100' }, { participant: '222@lid', name: 'Sarah' }));
    await settle();
    expect(sent[1].content.text).toContain('🔴 *REFUSED*');
  });

  it('reads a ticket QR from a photo', async () => {
    media.buffer = await QRCode.toBuffer('TM-847294-X', { width: 300 });
    deliver(waMsg(GROUP, { imageMessage: { mimetype: 'image/png', caption: '30 BB 212 100 South 1 F 1 1 adult swaying' } }, { participant: '111@lid' }));
    await replied(sent);
    expect(sent[0].content.text).toContain('✅ Logged 🟠 *SENT AWAY 30 MIN* · BB 212 100');
  });

  it('ignores unselected groups, strangers, old messages and its own messages', async () => {
    deliver(waMsg('999@g.us', { conversation: 'BB 212 100' }, { participant: '111@lid' }));
    deliver(waMsg('447700999999@s.whatsapp.net', { conversation: 'BB 212 100' }));
    deliver(waMsg(GROUP, { conversation: 'BB 212 100' }, { participant: '111@lid', ageS: 600 }));
    const own = waMsg(GROUP, { conversation: 'BB 212 100' }, { participant: '111@lid' });
    own.key.fromMe = true;
    deliver(own);
    await settle();
    expect(sent).toEqual([]);
    expect(wa.seenGroups.has('999@g.us')).toBe(true);
  });

  it('answers group members in a private chat', async () => {
    deliver(waMsg('447700900111@s.whatsapp.net', { conversation: 'BB 1 2' }));
    await settle();
    expect(sent[0]).toMatchObject({ jid: '447700900111@s.whatsapp.net' });
    expect(sent[0].content.text).toContain('NOT REFUSED');
  });

  it('lets only group admins use CLEAR and REPORT', async () => {
    deliver(waMsg(GROUP, { conversation: 'REFUSED BB 212 100 West 1 -' }, { participant: '111@lid' }));
    await settle();
    deliver(waMsg(GROUP, { conversation: 'CLEAR BB 212 100' }, { participant: '222@lid' }));
    await settle();
    expect(sent.at(-1)!.content.text).toContain('⛔ Only group admins');
    deliver(waMsg('447700900111@s.whatsapp.net', { conversation: 'REPORT' })); // admin, private chat
    await settle();
    expect(sent.at(-1)!.content.document).toBeDefined();
    deliver(waMsg(GROUP, { conversation: 'CLEAR BB 212 100' }, { participant: '111@lid' }));
    await settle();
    expect(sent.at(-1)!.content.text).toContain('🟢 *BB 212 100* cleared');
  });

  it('sends private messages and files to group admins only', async () => {
    (wa as unknown as { status: string }).status = 'connected';
    const n = await wa.sendToAdmins('🗂️ backup', { data: Buffer.from('a,b'), mime: 'text/csv', fileName: 'x.csv' });
    await settle();
    expect(n).toBe(1);
    expect(sent.map((m) => m.jid)).toEqual(['447700900111@s.whatsapp.net', '447700900111@s.whatsapp.net']);
    expect(sent[0].content.text).toBe('🗂️ backup');
    expect(sent[1].content.fileName).toBe('x.csv');
  });

  it('listens to voice notes only in private chats', async () => {
    const heard: Array<{ mime: string; bytes: number }> = [];
    (wa as unknown as { bot: { ai: unknown } }).bot.ai = {
      handle: async () => ({ kind: 'answer', text: 'x' }),
      handleAudio: async (audio: Buffer, mime: string) => (heard.push({ mime, bytes: audio.length }), { kind: 'answer', text: 'Nobody in a red coat tonight.' }),
    };
    media.buffer = Buffer.from('OggS-voice');
    media.downloads = 0;
    deliver(waMsg(GROUP, { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 4, ptt: true } }, { participant: '111@lid' }));
    await settle();
    expect(media.downloads).toBe(0); // group voice notes are never downloaded
    expect(sent).toEqual([]);
    deliver(waMsg('447700900111@s.whatsapp.net', { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 4, ptt: true } }));
    await settle();
    expect(heard).toEqual([{ mime: 'audio/ogg; codecs=opus', bytes: 10 }]);
    expect(sent[0].content.text).toBe('🤖 Nobody in a red coat tonight.');
  });

  it('sends the stored photo back with a check', async () => {
    const { Jimp } = await import('jimp');
    media.buffer = await new Jimp({ width: 60, height: 60, color: 0xaa3333ff }).getBuffer('image/png');
    deliver(waMsg(GROUP, { imageMessage: { mimetype: 'image/png', caption: 'REFUSED BB 212 100 West 1 -' } }, { participant: '111@lid' }));
    await settle();
    deliver(waMsg(GROUP, { conversation: 'BB 212 100' }, { participant: '222@lid' }));
    await settle();
    const check = sent.at(-1)!;
    expect(Buffer.isBuffer(check.content.image)).toBe(true);
    expect(check.content.caption).toContain('🔴 *REFUSED*');
  });
});
