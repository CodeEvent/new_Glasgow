import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../src/config/env';
import { closePool, getPool } from '../src/db/pool';
import { startNightJobs } from '../src/services/nightReport';
import { StewardBot, type InboundMessage } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const msg = (text: string): InboundMessage => ({ chatId: 'g@g.us', senderId: 'dave', senderName: 'Dave', text, at: new Date() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await sleep(20);
};

describe.skipIf(!HAS_DB)('night jobs (PostgreSQL)', () => {
  let stop: () => void = () => undefined;
  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
  });
  afterEach(() => {
    stop();
    delete process.env.SUMMARY_TIME;
    delete process.env.WA_READMIT_REMINDERS;
    resetConfigCache();
  });
  afterAll(async () => {
    await closePool();
  });

  it('posts a readmit reminder once when a cool-off ends', async () => {
    const bot = new StewardBot();
    await bot.handle(msg('30 52 YY 14 West 1 -'));
    const { rows } = await getPool().query('SELECT cool_down_until FROM tickets');
    const end = new Date(rows[0].cool_down_until).getTime();
    const posts: string[] = [];
    let now = new Date();
    stop = startNightJobs((t) => posts.push(t), 15, () => now);
    await sleep(60);
    expect(posts.filter((p) => p.startsWith('🟡'))).toEqual([]); // not yet
    now = new Date(end + 1_000);
    await waitFor(() => posts.some((p) => p.startsWith('🟡')));
    await sleep(60);
    const reminders = posts.filter((p) => p.startsWith('🟡'));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain('🟡 *52 YY 14* may now be readmitted *if fit* (sent away at West');
    expect(reminders[0]).toContain('Intoxicated');
  });

  it('can be switched off', async () => {
    process.env.WA_READMIT_REMINDERS = 'off';
    resetConfigCache();
    const bot = new StewardBot();
    await bot.handle(msg('30 52 YY 14 West 1 -'));
    const posts: string[] = [];
    let now = new Date();
    stop = startNightJobs((t) => posts.push(t), 15, () => now);
    now = new Date(Date.now() + 60 * 60_000);
    await sleep(100);
    expect(posts).toEqual([]);
  });

  it('posts the end-of-night summary once at SUMMARY_TIME, only when something was logged', async () => {
    process.env.SUMMARY_TIME = '23:30'; // tests run with TZ_DISPLAY=UTC
    process.env.WA_READMIT_REMINDERS = 'off';
    resetConfigCache();
    const posts: string[] = [];
    let now = new Date('2099-01-01T23:29:30Z');
    stop = startNightJobs((t) => posts.push(t), 15, () => now);
    now = new Date('2099-01-01T23:30:05Z');
    await sleep(100);
    expect(posts).toEqual([]); // nothing logged: stay quiet
    stop();

    await new StewardBot().handle(msg('REFUSED 313 H 02 West 2 -'));
    now = new Date('2099-01-02T23:29:30Z');
    stop = startNightJobs((t) => posts.push(t), 15, () => now);
    now = new Date('2099-01-02T23:30:05Z');
    await waitFor(() => posts.length > 0);
    await sleep(80);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('🌙 *END OF NIGHT SUMMARY*');
    expect(posts[0]).toContain('🔴 1 refused');
    expect(posts[0]).toContain('*Reasons:* Abusive 1');
  });

  it('sends the CSV backup to admins at summary time', async () => {
    process.env.SUMMARY_TIME = '23:30';
    process.env.WA_READMIT_REMINDERS = 'off';
    resetConfigCache();
    await new StewardBot().handle(msg('REFUSED 313 H 02 West 2 -'));
    const files: Array<{ text: string; fileName: string; csv: string }> = [];
    let now = new Date('2099-01-03T23:29:30Z');
    stop = startNightJobs(() => undefined, 15, () => now, (text, doc) => files.push({ text, fileName: doc.fileName, csv: doc.data.toString('utf8') }));
    now = new Date('2099-01-03T23:30:05Z');
    await waitFor(() => files.length > 0);
    await sleep(80);
    expect(files).toHaveLength(1);
    expect(files[0].fileName).toBe('gatekeeper-2099-01-03.csv');
    expect(files[0].csv).toContain('313,H,02,Refused,Abusive');
  });
});
