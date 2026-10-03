import { getPool } from '../db/pool';
import { StewardBot } from './stewardBot';

/**
 * Wipes every record (with its history, photos and notes) and, optionally, loads made-up demo
 * records for practice. Keeps the WhatsApp link, selected groups, policy and seating map.
 * The demo records are created by sending the bot its own commands, at times spread over the
 * last couple of hours, so they behave exactly like real logs (re-entries, groups, cool-offs).
 */

const MIN = 60_000;

// [minutes ago, demo steward, message] — all made up.
const SCRIPT: Array<[number, string, string]> = [
  [95, 'Alex', 'REFUSED 313 YY 56 West 1 M 3 3 adult green hat, black jacket'],
  [90, 'Alex', 'EJECTED 313 YY 57 West 2 M 2 1 adult grey hoodie'],
  [80, 'Priya', 'REFUSED 52 YY 14 East 5 M 3 2 adult white trainers, black cap'],
  [78, 'Priya', 'NOTE 52 YY 14 item handed to police at the gate'],
  [70, 'Sam', 'REFUSED 12 C 3 West 1 F 2 2 adult blue dress'],
  [65, 'Sam', 'CLEAR 12 C 3'],
  [60, 'Jo', 'REFUSED 313 YY 56 South 2 -'], // re-entry attempt at another hub
  [50, 'Jo', '30 101 A 4 South 1 M 2 2 adult blue cap'], // cool-off already over
  [40, 'Kim', 'REFUSED 300 L 205 206 207 Hosp 1 2 M 2 2 adult matching pink t-shirts, stag party'],
  [38, 'Kim', 'NOTE 300 L 206 groom, loudest of the group'],
  [30, 'Alex', 'REFUSED 223 Y 100 South 4 F 1 1 minor school hoodie'],
  [20, 'Priya', '30 234 O 9 East 3 F 1 1 adult red coat'], // still cooling off
  [15, 'Sam', 'REFUSED 118 D 7 Hosp 2 F 2 2 adult black dress, gold bag'],
  [10, 'Jo', '30 205 B 18 East 6'],
  [10, 'Jo', 'tried to climb the barrier'], // "What happened?" for reason Other
  [10, 'Jo', 'M 3 3 adult green and white football top'],
];

export async function resetRecords(opts: { demo: boolean }, now = Date.now()): Promise<{ deleted: number; created: number }> {
  const { rowCount } = await getPool().query('DELETE FROM tickets'); // cascades to history, photos and notes
  if (!opts.demo) return { deleted: rowCount ?? 0, created: 0 };

  // Its own bot (no AI, OCR, alerts or shift hubs), with a clock set to each step's time, so
  // clears and notes get realistic times too.
  let clock = now;
  const bot = new StewardBot(() => clock);
  for (const [ago, who, text] of SCRIPT) {
    clock = now - ago * MIN;
    await bot.handle({ chatId: 'demo@g.us', senderId: `demo-${who}`, senderName: `Demo · ${who}`, text, at: new Date(clock) });
  }
  const { rows } = await getPool().query<{ n: number }>('SELECT count(*)::int AS n FROM tickets');
  return { deleted: rowCount ?? 0, created: rows[0].n };
}
