import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool';
import type { RecordRow } from '../src/services/adminRecords';
import { briefText } from '../src/services/nightReport';
import { StewardBot, type InboundMessage } from '../src/services/stewardBot';
import { HAS_DB, resetDatabase, tempOfflineLog } from './helpers';

const NOW = new Date('2026-10-03T21:40:00Z');
const min = (m: number) => new Date(NOW.getTime() + m * 60_000);
let n = 0;
const row = (over: Partial<RecordRow>): RecordRow => ({
  ticket_id: `t${++n}`, current_status: 'completely_refused', description: 'Not provided', reasoning: 'Intoxicated',
  cool_down_until: null, created_at: min(-60), updated_at: min(-60), section: '313', row_label: 'YY', seat_number: String(n),
  origin_hub: 'West Hub', origin_steward: 'Dave', origin_at: min(-60), breaches: 0, photos: 0, party_size: 1, notes: null,
  ...over,
});

describe('BRIEF text', () => {
  it('says when it’s quiet', () => {
    const t = briefText([], NOW, {});
    expect(t).toContain('📋 *SHIFT BRIEF*');
    expect(t).toContain('Nothing logged yet');
  });

  it('gives the numbers, who is back soon, who to watch for and the busy hubs', () => {
    const rows = [
      row({ seat_number: '56', reasoning: 'Intoxicated, Abusive', description: 'Male · Tall · green hat' }),
      row({ seat_number: '57', reasoning: 'Ejected: Abusive', origin_hub: 'East Hub', description: 'Female · red coat' }),
      row({ seat_number: '58', current_status: 'cooling_off', cool_down_until: min(12), description: 'Male · blue cap' }),
      row({ seat_number: '59', current_status: 'cooling_off', cool_down_until: min(55) }), // not back within 30 min
      row({ seat_number: '60', current_status: 'cooling_off', cool_down_until: min(-5) }), // cool-off over
      row({ seat_number: '61', reasoning: 'Intoxicated, Already refused, tried re-entry', breaches: 1 }),
      row({ seat_number: '62', current_status: 'admitted', breaches: 2 }), // cleared: not one to watch
    ];
    const t = briefText(rows, NOW, {});
    expect(t).toContain('🔴 2 refused · ⛔ 1 ejected · 🟠 2 sent away now'); // 57 is ejected, not refused
    expect(t).toContain('🟡 *Back soon*');
    expect(t).toMatch(/313 YY 58\*.*back \d\d:\d\d \(12 min\)/);
    expect(t).not.toMatch(/313 YY 59\*.*back/);
    const watch = t.slice(t.indexOf('🚨 *Watch for*'));
    expect(watch).toContain('313 YY 57'); // ejected
    expect(watch).toContain('313 YY 61'); // tried re-entry
    expect(watch).toContain('red coat');
    expect(watch).not.toContain('313 YY 62');
    expect(t).toContain('*Busiest hubs:* West 6 · East 1');
    expect(t).toContain('*Top reasons:* Intoxicated');
    expect(t).toContain('*LIST*');
  });

  it('adds the steward’s hub and the policy when there is one', () => {
    const rows = [row({ origin_hub: 'West Hub', origin_at: min(-10) }), row({ origin_hub: 'East Hub' })];
    const t = briefText(rows, NOW, { hub: 'West Hub', policy: 'Under 18s with alcohol: refuse and call a supervisor.\nSecond line.' });
    expect(t).toContain('🏟️ *West tonight:* 1 logged, last');
    expect(t).toContain('📋 *Policy:* Under 18s with alcohol: refuse and call a supervisor.');
    expect(t).not.toContain('Second line');
  });

  it('keeps long nights to one short message', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ reasoning: 'Ejected: Abusive', seat_number: String(100 + i) }));
    const t = briefText(rows, NOW, {});
    expect(t).toContain('…and 35 more');
    expect(t.length).toBeLessThan(2500);
  });
});

describe.skipIf(!HAS_DB)('BRIEF in the group (PostgreSQL)', () => {
  let bot: StewardBot;
  const msg = (text: string): InboundMessage => ({ chatId: 'g@g.us', senderId: 'dave', senderName: 'Dave', text, at: new Date() });

  beforeEach(async () => {
    tempOfflineLog();
    await resetDatabase();
    await getPool().query("DELETE FROM app_settings WHERE key = 'refusal_policy'");
    bot = new StewardBot();
  });
  afterAll(async () => {
    await closePool();
  });

  it('briefs from tonight’s records, with the shift hub', async () => {
    expect((await bot.handle(msg('brief')))[0].text).toContain('Nothing logged yet');
    await bot.handle(msg('HUB WEST'));
    await bot.handle(msg('EJECTED 313 YY 56 2 M 3 3 adult green hat'));
    const [b] = await bot.handle(msg('BRIEF'));
    expect(b.text).toContain('⛔ 1 ejected');
    expect(b.text).toContain('🚨 *Watch for*');
    expect(b.text).toContain('green hat');
    expect(b.text).toContain('🏟️ *West tonight:* 1 logged');
  });

  it('is in HELP', async () => {
    expect((await bot.handle(msg('HELP')))[0].text).toContain('*BRIEF*');
  });
});
