import QRCode from 'qrcode';
import { Jimp } from 'jimp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool';
import { decodeQrFromImage, ticketCodeFromQr } from '../src/services/qrImage';
import { purgeExpired } from '../src/services/retention';
import { StewardBot, parseDecision, parseDetails, parseHub, parseLogCommand, type InboundMessage } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const SAFETIX = 'SAFETIX:eyJ0IjoiVE0tODQ3Mjk0LVgiLCJzIjoiNjIzODQxMDk4MjM3NDEiLCJ0cyI6MTc5MDk2MTE2Mn0.rotating.token.abc123';

async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { width: 400, margin: 4 });
}
async function plainPhoto(): Promise<Buffer> {
  const img = new Jimp({ width: 120, height: 90, color: 0x336699ff });
  return img.getBuffer('image/png');
}

describe('log message parsing', () => {
  it('reads decision, seat, hub and notes from one line', () => {
    expect(parseLogCommand('REFUSED BB 212 100 West green hat, very drunk')).toEqual({
      decision: 'refused', section: 'BB', row: '212', seat: '100', hub: 'West Hub', clothing: 'green hat, very drunk',
    });
    expect(parseLogCommand('REFUSED 52 YY 14 West 1 3 M 3 2 adult green hat')).toEqual({
      decision: 'refused', section: '52', row: 'YY', seat: '14', hub: 'West Hub', reasons: ['Intoxicated', 'Under the influence'],
      gender: 'Male', height: 'Tall', build: 'Average build', age: 'Adult', clothing: 'green hat',
    });
    expect(parseLogCommand('30 bb 212 100 hospitality')).toEqual({ decision: 'cool_off', section: 'BB', row: '212', seat: '100', hub: 'Hospitality Hub' });
    expect(parseLogCommand('sent away Section BB Row 212 Seat 100 swaying')).toMatchObject({ decision: 'cool_off', seat: '100', clothing: 'swaying' });
    expect(parseLogCommand('Refused')).toEqual({ decision: 'refused' });
  });

  it('reads "30 min" and section-row-seat order', () => {
    for (const d of ['30 min', '30min', '30 mins', '30 minutes']) {
      expect(parseLogCommand(`${d} 52 YY 14 East drunk`)).toEqual({ decision: 'cool_off', section: '52', row: 'YY', seat: '14', hub: 'East Hub', reasons: ['Intoxicated'] });
    }
    expect(parseDecision('30 min')).toBe('cool_off');
  });

  it('reads one or more reasons', () => {
    expect(parseDetails('1 3 5')).toEqual({ reasons: ['Intoxicated', 'Under the influence', 'Found in possession'] });
    expect(parseDetails('1,3,5')).toEqual(parseDetails('1 3 5'));
    expect(parseDetails('135')).toEqual(parseDetails('1 3 5'));
    expect(parseDetails('2 2 abusive')).toEqual({ reasons: ['Abusive'] }); // no repeats
    expect(parseDetails('drunk & abusive')).toEqual({ reasons: ['Intoxicated', 'Abusive'] });
    expect(parseDetails('6 1')).toEqual({ reasons: ['Other', 'Intoxicated'] });
    expect(parseDetails('7')).toEqual({ clothing: '7' });
    expect(parseDetails('stumbling')).toEqual({ clothing: 'stumbling' });
  });

  it('reads the description options in the order they are asked', () => {
    expect(parseDetails('4 f 1 1 minor red dress')).toEqual({
      reasons: ['Intoxicated minor'], gender: 'Female', height: 'Short', build: 'Slim', age: 'Minor (under 18)', clothing: 'red dress',
    });
    expect(parseDetails('possession male tall heavy adult')).toEqual({
      reasons: ['Found in possession'], gender: 'Male', height: 'Tall', build: 'Heavy', age: 'Adult',
    });
    expect(parseDetails('3 -')).toEqual({ reasons: ['Under the influence'], gender: '', height: '', build: '', age: '', clothing: '' });
    expect(parseDetails('abusive green hat')).toEqual({ reasons: ['Abusive'], clothing: 'green hat' });
    expect(parseDetails('2 f black dress 3', 'reasons')).toEqual({ reasons: ['Abusive'], gender: 'Female', clothing: 'black dress 3' });
    expect(parseDetails('2', 'height')).toEqual({ height: 'Average height' });
    expect(parseDetails('3', 'build')).toEqual({ build: 'Heavy' });
    expect(parseDetails('average', 'build')).toEqual({ build: 'Average build' });
    expect(parseDetails('2', 'age')).toEqual({ age: 'Minor (under 18)' });
    expect(parseDetails('A', 'age')).toEqual({ age: 'Adult' });
    expect(parseDetails('a green hat', 'gender')).toEqual({ clothing: 'a green hat' }); // "a" is not "adult" here
    expect(parseDetails('F 1 3 black jacket', 'gender')).toEqual({ gender: 'Female', height: 'Short', build: 'Heavy', clothing: 'black jacket' });
  });

  it('ignores ordinary chat', () => {
    for (const t of ['really busy at the south gate', 'see you 10', 'r u there', 'sa', 'coolest night ever']) {
      expect(parseLogCommand(t)).toBeNull();
    }
  });

  it('parses single-word answers', () => {
    expect(parseDecision('30')).toBe('cool_off');
    expect(parseDecision('refused')).toBe('refused');
    expect(parseHub('hosp')).toBe('Hospitality Hub');
    expect(parseHub('South hub')).toBe('South Hub');
  });
});

describe('QR codes in photos', () => {
  it('decodes a Ticketmaster-style QR and fingerprints long payloads', async () => {
    const raw = await decodeQrFromImage(await qrPng(SAFETIX));
    expect(raw).toBe(SAFETIX);
    expect(await ticketCodeFromQr(raw!)).toMatch(/^QR-[0-9a-f]{32}$/);
    expect(await ticketCodeFromQr('TM-847294-X')).toBe('TM-847294-X');
  });

  it('returns null for photos without a QR code or non-images', async () => {
    expect(await decodeQrFromImage(await plainPhoto())).toBeNull();
    expect(await decodeQrFromImage(Buffer.from('not an image'))).toBeNull();
  });
});

describe.skipIf(!HAS_DB)('steward WhatsApp flow (PostgreSQL)', () => {
  let clock = Date.now();
  let bot: StewardBot;
  const msg = (senderId: string, text: string | null, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    chatId: 'work-group@g.us',
    senderId,
    senderName: senderId === 'sarah' ? 'Sarah' : senderId === 'dave' ? 'Dave' : 'Priya',
    text,
    at: new Date(clock),
    ...extra,
  });

  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    clock = Date.now();
    bot = new StewardBot(() => clock);
  });
  afterAll(async () => {
    await closePool();
  });

  it('logs in one message and answers a check by seat', async () => {
    const [r] = await bot.handle(msg('dave', 'REFUSED BB 212 100 West 1 2 M 3 2 adult green hat, very drunk'));
    expect(r.text).toContain('✅ Logged 🔴 *REFUSED* · BB 212 100');
    expect(r.text).toContain('West Hub');
    expect(r.text).toContain('📝 Intoxicated, Abusive');
    expect(r.text).toContain('👤 Male · Tall · Average build · Adult · green hat, very drunk');

    const [c] = await bot.handle(msg('sarah', 'BB 212 100'));
    expect(c.text).toContain('🔴 *REFUSED*');
    expect(c.text).toContain('green hat, very drunk');
    expect(c.text).toContain('Intoxicated, Abusive');
    expect(c.text).toContain('by Dave');
  });

  it('walks a steward through a QR photo step by step, asking the hub every time', async () => {
    const [a] = await bot.handle(msg('dave', null, { image: { data: await qrPng(SAFETIX), mime: 'image/png' } }));
    expect(a.text).toContain('🎟️ Ticket QR read.');
    expect(a.text).toContain('Refused entry, sent away for 30 minutes, or ejected?');
    const [b] = await bot.handle(msg('dave', '2'));
    expect(b.text).toContain('Which seat?');
    const [c] = await bot.handle(msg('dave', 'BB 212 100'));
    expect(c.text).toContain('Which hub');
    expect(c.text).toContain('*4* Hospitality');
    const [d] = await bot.handle(msg('dave', '2'));
    expect(d.text).toContain('Reason?');
    expect(d.text).toContain('*4* Intoxicated minor');
    expect(d.text).toContain('e.g. *1 3 5*');
    expect((await bot.handle(msg('dave', 'stumbling')))[0].text).toContain('Reason?'); // not an option: asked again
    expect((await bot.handle(msg('dave', '3 5')))[0].text).toContain('Male or female?');
    expect((await bot.handle(msg('dave', 'm')))[0].text).toContain('Height?');
    expect((await bot.handle(msg('dave', '3')))[0].text).toContain('Build?');
    expect((await bot.handle(msg('dave', '-')))[0].text).toContain('Minor or adult?');
    expect((await bot.handle(msg('dave', '2')))[0].text).toContain('What are they wearing?');
    const [e] = await bot.handle(msg('dave', 'black jacket'));
    expect(e.text).toContain('✅ Logged 🟠 *SENT AWAY 30 MIN* · BB 212 100');
    expect(e.text).toContain('📝 Under the influence, Found in possession');
    expect(e.text).toContain('👤 Male · Tall · Minor (under 18) · black jacket');
    expect(e.text).toContain('back after');

    const { rows } = await getPool().query('SELECT ticket_id, seat_key FROM tickets');
    expect(rows[0].ticket_id).toMatch(/^QR-/);
    expect(rows[0].seat_key).toBe('BB|212|100');

    // Next log from Dave: the hub is asked again, with his last one as a hint.
    const [f] = await bot.handle(msg('dave', 'REFUSED C 4 22 2 -'));
    expect(f.text).toContain('Which hub');
    expect(f.text).toContain('Last time: *West* (reply *2*)');
    const [g] = await bot.handle(msg('dave', 'south'));
    expect(g.text).toContain('✅ Logged 🔴 *REFUSED* · C 4 22');
    expect(g.text).toContain('South Hub');
  });

  it('stores the customer photo and sends it back with a check', async () => {
    const photo = await plainPhoto();
    const [a] = await bot.handle(msg('dave', 'REFUSED BB 212 100 West', { image: { data: photo, mime: 'image/png' } }));
    expect(a.text).toContain('📷 Photo saved. Reason?');
    await bot.handle(msg('dave', '1 -'));
    const [c] = await bot.handle(msg('sarah', 'BB 212 100'));
    expect(c.image?.data.equals(photo)).toBe(true);
  });

  it('flags a second attempt at another hub', async () => {
    await bot.handle(msg('dave', '30 BB 212 100 West 1 -'));
    clock += 10 * 60_000;
    const [r] = await bot.handle(msg('sarah', '30 BB 212 100 South 1 -', { at: new Date(clock) }));
    expect(r.text).toContain('🚨 *ALREADY SENT AWAY* · BB 212 100');
    expect(r.text).toContain('First at *West Hub*');
    expect(r.text).toContain('Do not admit');
  });

  it('asks what happened when Other is one of the reasons', async () => {
    expect((await bot.handle(msg('dave', 'REFUSED 52 YY 14 West 2 6')))[0].text).toContain('What happened?');
    expect((await bot.handle(msg('dave', '-')))[0].text).toContain('What happened?'); // Other can't be skipped
    expect((await bot.handle(msg('dave', 'threw a bottle')))[0].text).toContain('Male or female?');
    const [r] = await bot.handle(msg('dave', 'F 2 3 -'));
    expect(r.text).toContain('📝 Abusive, Other: threw a bottle');
    expect(r.text).toContain('👤 Female · Average height · Heavy');
  });

  it('BACK reopens the previous question and forgets that answer', async () => {
    await bot.handle(msg('dave', 'REFUSED 52 YY 14 West'));
    expect((await bot.handle(msg('dave', 'back')))[0].text).toContain('Nothing to go back to');
    expect((await bot.handle(msg('dave', '3 4 5')))[0].text).toContain('*BACK* to change your last answer');
    expect((await bot.handle(msg('dave', 'm')))[0].text).toContain('Height?');
    // Wrong gender: go back, fix it.
    const [b1] = await bot.handle(msg('dave', 'BACK'));
    expect(b1.text).toContain('↩️ Male or female?');
    expect((await bot.handle(msg('dave', 'f')))[0].text).toContain('Height?');
    // Back twice: change the reasons too.
    await bot.handle(msg('dave', 'back'));
    expect((await bot.handle(msg('dave', 'back')))[0].text).toContain('↩️ Reason?');
    await bot.handle(msg('dave', '1 2'));
    await bot.handle(msg('dave', 'f'));
    await bot.handle(msg('dave', '1'));
    await bot.handle(msg('dave', '1'));
    await bot.handle(msg('dave', '1'));
    const [r] = await bot.handle(msg('dave', 'red coat'));
    expect(r.text).toContain('📝 Intoxicated, Abusive');
    expect(r.text).toContain('👤 Female · Short · Slim · Adult · red coat');
  });

  it('BACK after a one-line answer forgets everything that answer filled in', async () => {
    await bot.handle(msg('dave', 'LOG'));
    await bot.handle(msg('dave', '2'));
    await bot.handle(msg('dave', '52 YY 14'));
    await bot.handle(msg('dave', '1'));
    expect((await bot.handle(msg('dave', '1 M 3')))[0].text).toContain('Build?'); // reasons, gender and height in one go
    expect((await bot.handle(msg('dave', 'back')))[0].text).toContain('↩️ Reason?');
    expect((await bot.handle(msg('dave', '2')))[0].text).toContain('Male or female?'); // gender was forgotten too
  });

  it('LIST shows everyone refused or sent away, newest first', async () => {
    expect((await bot.handle(msg('sarah', 'list')))[0].text).toContain('Nobody is refused or sent away');
    await bot.handle(msg('dave', 'REFUSED 313 H 02 West 1 2 M 3 2 adult green hat'));
    await bot.handle(msg('dave', '30 52 YY 14 South 3 -'));
    await bot.handle(msg('priya', '30 52 YY 14 East 3 -')); // hub-hop
    const [r] = await bot.handle(msg('sarah', 'LIST'));
    expect(r.text).toContain('🔴 *REFUSED* (1)');
    expect(r.text).toContain('• *313 H 02* · Intoxicated, Abusive · West');
    expect(r.text).toContain('👤 Male · Tall · Average build · Adult · green hat');
    expect(r.text).toContain('🟠 *SENT AWAY* (1)');
    expect(r.text).toMatch(/\*52 YY 14\* · Under the influence · South \d\d:\d\d · back \d\d:\d\d \(30 min\) · 🚨 tried again ×1/);
    // A half-finished log isn't disturbed by LIST.
    await bot.handle(msg('dave', 'REFUSED 1 A 1 West'));
    await bot.handle(msg('dave', 'list'));
    expect((await bot.handle(msg('dave', '2 -')))[0].text).toContain('✅ Logged');
  });

  it('STATS counts tonight by status, reason and hub', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 H 02 West 1 2 M 3 2 adult green hat'));
    await bot.handle(msg('dave', '30 52 YY 14 West 1 -'));
    await bot.handle(msg('priya', '30 52 YY 14 East 1 -')); // hub-hop
    await bot.handle(msg('sarah', 'REFUSED 9 B 9 South 4 F 1 1 minor -'));
    const [r] = await bot.handle(msg('sarah', 'stats'));
    expect(r.text).toContain('3 logged · 🔴 2 refused · 🟠 1 sent away now');
    expect(r.text).toContain('🚨 1 tried another hub (1 attempts)');
    expect(r.text).toContain('*Reasons:* Intoxicated 2 · Abusive 1 · Intoxicated minor 1');
    expect(r.text).toContain('*Hubs:* West 2 · South 1');
    expect(r.text).toContain('*Minors:* 1');
  });

  it('CLEAR lets someone in and PHOTO adds a picture to a saved record', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 H 02 West 1 -'));
    expect((await bot.handle(msg('sarah', 'CLEAR 1 2 3')))[0].text).toContain('Nothing on record for *1 2 3*');
    bot.canSupervise = async (id) => id === 'sarah';
    expect((await bot.handle(msg('dave', 'CLEAR 313 H 02')))[0].text).toContain('⛔ Only group admins');
    expect((await bot.handle(msg('dave', 'REPORT', { chatId: '447700900111@s.whatsapp.net' })))[0].document).toBeUndefined();
    const [c] = await bot.handle(msg('sarah', 'clear 313 h 02'));
    expect(c.text).toContain('🟢 *313 H 02* cleared by Sarah');
    expect((await bot.handle(msg('sarah', '313 H 02')))[0].text).toContain('🟢 *ADMITTED*');
    expect((await bot.handle(msg('sarah', 'CLEAR 313 H 02')))[0].text).toContain('already cleared');

    const photo = await plainPhoto();
    expect((await bot.handle(msg('dave', 'PHOTO 313 H 02')))[0].text).toContain('Send the customer');
    const [p] = await bot.handle(msg('dave', 'PHOTO 313 H 02', { image: { data: photo, mime: 'image/png' } }));
    expect(p.text).toContain('📷 Photo added to *313 H 02*');
    expect((await bot.handle(msg('sarah', '313 H 02')))[0].image?.data.equals(photo)).toBe(true);
  });

  it('PHOTO also works as a separate message right after the photo', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1 -'));
    const photo = await plainPhoto();
    expect(await bot.handle(msg('dave', null, { image: { data: photo, mime: 'image/png' } }))).toEqual([]); // quiet
    expect((await bot.handle(msg('sarah', 'PHOTO 313 yy 56')))[0].text).toContain('Send the customer'); // not Sarah's photo
    expect((await bot.handle(msg('dave', 'PHOTO 313 yy 56')))[0].text).toContain('📷 Photo added to *313 YY 56*');
    expect((await bot.handle(msg('sarah', '313 YY 56')))[0].image?.data.equals(photo)).toBe(true);
    clock += 6 * 60_000;
    await bot.handle(msg('dave', null, { image: { data: photo, mime: 'image/png' } }));
    clock += 6 * 60_000;
    expect((await bot.handle(msg('dave', 'PHOTO 313 yy 56')))[0].text).toContain('Send the customer'); // too late
  });

  it('REPORT sends the spreadsheet only in a private chat', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 H 02 West 1 -'));
    const [g] = await bot.handle(msg('dave', 'REPORT'));
    expect(g.text).toContain('private chat');
    expect(g.document).toBeUndefined();
    const [d] = await bot.handle(msg('dave', 'report', { chatId: '447700900111@s.whatsapp.net' }));
    expect(d.document?.fileName).toMatch(/^gatekeeper-.*\.csv$/);
    expect(d.document?.data.toString('utf8')).toContain('313,H,02,Refused,Intoxicated');
  });

  it('announces a hub-hop to the other chats', async () => {
    const posts: Array<{ text: string; except?: string }> = [];
    bot.announce = (text, except) => posts.push({ text, except });
    await bot.handle(msg('dave', '30 52 YY 14 West 1 -'));
    expect(posts).toEqual([]);
    await bot.handle(msg('priya', '30 52 YY 14 East 1 -', { chatId: '447700900222@s.whatsapp.net' }));
    expect(posts).toHaveLength(1);
    expect(posts[0].except).toBe('447700900222@s.whatsapp.net');
    expect(posts[0].text).toContain('🚨 *ALREADY SENT AWAY* · 52 YY 14');
    expect(posts[0].text).toContain('Logged by Priya');
  });

  it('FIND searches descriptions, reasons and notes', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1 M 3 2 adult green hat, black jacket'));
    await bot.handle(msg('dave', '30 52 YY 14 West 2 F 1 1 adult red coat'));
    expect((await bot.handle(msg('sarah', 'FIND blue scarf')))[0].text).toContain('Nothing on record matches');
    const [r] = await bot.handle(msg('sarah', 'find green hat'));
    expect(r.text).toContain('🔎 1 match for “green hat”');
    expect(r.text).toContain('🔴 *313 YY 56* · Intoxicated');
    expect((await bot.handle(msg('sarah', 'FIND abusive')))[0].text).toContain('🟠 *52 YY 14*');
    await bot.handle(msg('sarah', 'NOTE 52 YY 14 tattoo on left hand'));
    expect((await bot.handle(msg('sarah', 'find tattoo')))[0].text).toContain('*52 YY 14*');
  });

  it('NOTE adds a note shown on checks', async () => {
    expect((await bot.handle(msg('sarah', 'NOTE 1 2 3 hi')))[0].text).toContain('Nothing on record');
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1 -'));
    expect((await bot.handle(msg('sarah', 'NOTE 313 YY 56')))[0].text).toContain('Add the note after the seat');
    expect((await bot.handle(msg('sarah', 'note 313 yy 56 came back calm, still refused')))[0].text).toContain('🗒️ Note added to *313 YY 56*');
    const [c] = await bot.handle(msg('dave', '313 YY 56'));
    expect(c.text).toMatch(/🗒️ \d\d:\d\d Sarah: came back calm, still refused/);
  });

  it('records party size from the log line or PARTY', async () => {
    const [r] = await bot.handle(msg('dave', 'REFUSED 313 YY 56 West x3 1 -'));
    expect(r.text).toContain('👥 Party of 3');
    expect((await bot.handle(msg('sarah', 'LIST')))[0].text).toContain('👥3');
    expect((await bot.handle(msg('sarah', 'PARTY 313 YY 56 4')))[0].text).toContain('party of 4');
    const { rows } = await getPool().query('SELECT party_size FROM tickets');
    expect(rows[0].party_size).toBe(4);
    expect(parseLogCommand('REFUSED 52 X 3 West')).toMatchObject({ section: '52', row: 'X', seat: '3' }); // row X, not a party
    expect(parseLogCommand('30 52 YY 14 party of 2 1 -')).toMatchObject({ party: 2, reasons: ['Intoxicated'] });
  });

  it('logs ejections', async () => {
    const [a] = await bot.handle(msg('dave', 'LOG'));
    expect(a.text).toContain('*3* Ejected');
    await bot.handle(msg('dave', '3'));
    await bot.handle(msg('dave', '313 YY 56'));
    await bot.handle(msg('dave', '1'));
    const [r] = await bot.handle(msg('dave', '1 2 -'));
    expect(r.text).toContain('✅ Logged ⛔ *EJECTED* · 313 YY 56');
    expect(r.text).toContain('📝 Ejected: Intoxicated, Abusive');
    expect((await bot.handle(msg('sarah', 'EJECTED 52 YY 14 South 2 -')))[0].text).toContain('⛔ *EJECTED*');
    expect((await bot.handle(msg('sarah', 'STATS')))[0].text).toContain('🔴 0 refused · ⛔ 2 ejected');
    expect((await bot.handle(msg('sarah', 'STATS')))[0].text).toContain('*Reasons:* Abusive 2 · Intoxicated 1');
  });

  it('EDIT re-asks reasons and description: own last log, or group admins', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1 M 3 2 adult green hat'));
    bot.canSupervise = async (id) => id === 'sarah';
    expect((await bot.handle(msg('priya', 'EDIT 313 YY 56')))[0].text).toContain('⛔ Only group admins');
    const [e] = await bot.handle(msg('dave', 'EDIT 313 yy 56'));
    expect(e.text).toContain('✏️ Editing *313 YY 56*');
    expect(e.text).toContain('Reason?');
    await bot.handle(msg('dave', '2 5'));
    const [done] = await bot.handle(msg('dave', 'F 1 1 adult red coat'));
    expect(done.text).toContain('✏️ *Updated* · 313 YY 56');
    expect(done.text).toContain('📝 Abusive, Found in possession');
    expect(done.text).toContain('👤 Female · Short · Slim · Adult · red coat');
    const [c] = await bot.handle(msg('priya', '313 YY 56'));
    expect(c.text).toContain('Abusive, Found in possession');
    expect(c.text).toContain('🔴 *REFUSED*'); // status unchanged
    // CANCEL during an edit keeps the record as it was.
    await bot.handle(msg('sarah', 'EDIT 313 YY 56'));
    await bot.handle(msg('sarah', 'cancel'));
    expect((await bot.handle(msg('priya', '313 YY 56')))[0].text).toContain('Abusive, Found in possession');
  });

  it('warns when logging a seat already on record, and checks a seat sent mid-log', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 1 -'));
    // Sarah starts a log by mistake (LOG), then sends the seat she wanted to check.
    await bot.handle(msg('sarah', 'LOG'));
    await bot.handle(msg('sarah', '1'));
    const [w] = await bot.handle(msg('sarah', '313 yy 56'));
    expect(w.text).toContain('⚠️ *Already on record:*');
    expect(w.text).toContain('🔴 *REFUSED*');
    expect(w.text).toContain('Send *CANCEL*');
    expect(w.text).toContain('Which hub');
    // Now a bare seat is a check, with a reminder of the open question.
    const [check, still] = await bot.handle(msg('sarah', '313 YY 56'));
    expect(check.text).toContain('🔴 *REFUSED*');
    expect(still.text).toContain('still logging 313 YY 56');
    expect(still.text).toContain('Which hub');
    expect((await bot.handle(msg('sarah', 'cancel')))[0].text).toContain('Cancelled');
    // A new seat isn't warned about.
    await bot.handle(msg('sarah', 'LOG'));
    await bot.handle(msg('sarah', '1'));
    expect((await bot.handle(msg('sarah', '1 A 1')))[0].text).not.toContain('Already on record');
  });

  it('searches by section, or section and row', async () => {
    await bot.handle(msg('dave', 'REFUSED 313 L 4 West 1 -'));
    await bot.handle(msg('dave', '30 313 L 12 West 2 -'));
    await bot.handle(msg('dave', 'REFUSED 313 YY 56 West 3 -'));
    await bot.handle(msg('dave', 'REFUSED 234 O 9 East 1 -'));
    const [l] = await bot.handle(msg('sarah', '313 l'));
    expect(l.text).toContain('🔎 *Section 313, row L*: 2 on record');
    expect(l.text.indexOf('*313 L 4*')).toBeLessThan(l.text.indexOf('*313 L 12*')); // seat order
    expect(l.text).toContain('🟠 *313 L 12*');
    expect((await bot.handle(msg('sarah', '313')))[0].text).toContain('*Section 313*: 3 on record');
    expect((await bot.handle(msg('sarah', 'section 234 row o')))[0].text).toContain('🔴 *234 O 9*');
    expect((await bot.handle(msg('sarah', '234 Q')))[0].text).toContain('✅ Nothing on record in section 234, row Q');
    expect((await bot.handle(msg('sarah', 'SECTION 99')))[0].text).toContain('Nothing on record in section 99');
    // Chat stays quiet: bare numbers and "5 min" with nothing on record.
    for (const t of ['10', '5 min', '2 ok', '7 pm']) expect(await bot.handle(msg('sarah', t))).toEqual([]);
    // Full seats are still checks.
    expect((await bot.handle(msg('sarah', '313 YY 56')))[0].text).toContain('🔴 *REFUSED*');
  });

  it('starts a log with LOG or a photo captioned with the seat, asking every question', async () => {
    const [a] = await bot.handle(msg('dave', 'log'));
    expect(a.text).toContain('Refused entry, sent away');
    expect((await bot.handle(msg('dave', '1')))[0].text).toContain('Which seat?');
    await bot.handle(msg('priya', '52 YY 14', { image: { data: await plainPhoto(), mime: 'image/png' } }));
    const [b] = await bot.handle(msg('priya', '30'));
    expect(b.text).toContain('Which hub');
  });

  it('says NOT REFUSED for unknown seats and stays quiet for chat and random photos', async () => {
    const [r] = await bot.handle(msg('sarah', 'BB 1 2'));
    expect(r.text).toContain('✅ *NOT REFUSED*');
    expect(await bot.handle(msg('sarah', 'anyone want a coffee?'))).toEqual([]);
    expect(await bot.handle(msg('sarah', null, { image: { data: await plainPhoto(), mime: 'image/png' } }))).toEqual([]);
  });

  it('keeps stewards apart, supports CANCEL and UNDO', async () => {
    await bot.handle(msg('dave', 'REFUSED'));
    // Sarah's check isn't swallowed by Dave's half-finished log.
    const [check] = await bot.handle(msg('sarah', 'BB 9 9'));
    expect(check.text).toContain('NOT REFUSED');
    expect((await bot.handle(msg('dave', 'cancel')))[0].text).toContain('Cancelled');

    await bot.handle(msg('priya', 'REFUSED D 1 1 East 2 -'));
    expect((await bot.handle(msg('priya', 'undo')))[0].text).toContain('Removed your last record');
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM tickets');
    expect(rows[0].n).toBe(0);
  });

  it('deletes records older than the retention window', async () => {
    await bot.handle(msg('dave', 'REFUSED BB 212 100 West 1 -'));
    // The updated_at trigger would reset the timestamp, so backdate with it switched off.
    await getPool().query('ALTER TABLE tickets DISABLE TRIGGER trg_tickets_updated_at');
    try {
      await getPool().query("UPDATE tickets SET created_at = created_at - interval '25 hours', updated_at = NOW() - interval '25 hours'");
    } finally {
      await getPool().query('ALTER TABLE tickets ENABLE TRIGGER trg_tickets_updated_at');
    }
    expect(await purgeExpired(24)).toBe(1);
    const [c] = await bot.handle(msg('sarah', 'BB 212 100'));
    expect(c.text).toContain('NOT REFUSED');
  });
});
