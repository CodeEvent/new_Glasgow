import { getConfig } from '../config/env';
import { getPool, isConnectivityError } from '../db/pool';
import { listRecords, recordsToCsv, type RecordRow } from './adminRecords';
import { formatClock, sanitize } from './format';

/**
 * Tonight's numbers (STATS / end-of-night summary) and the background jobs that post
 * into the WhatsApp groups: readmit reminders and the scheduled summary.
 * "Tonight" is everything still on record (records are deleted after RETENTION_HOURS).
 */

const seatOf = (r: { section: string | null; row_label: string | null; seat_number: string | null; ticket_id: string }) =>
  r.section ? `${r.section} ${r.row_label} ${r.seat_number}` : r.ticket_id;

/** Reasons are stored as "Intoxicated, Abusive, Other: threw a bottle". */
function reasonsOf(reasoning: string): string[] {
  if (!reasoning || reasoning === 'Not provided') return [];
  return reasoning
    .replace(/^Ejected:?\s*/, '')
    .split(/\s*,\s*(?=[A-Z])/)
    .map((r) => (r.startsWith('Other') ? 'Other' : r.replace(/\s*·\s*Cleared by.*$/, '').trim()))
    .filter(Boolean);
}

function tally(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${sanitize(k, 40)} ${n}`)
    .join(' · ');
}

export function statsText(rows: RecordRow[], now: Date, title = '📊 *TONIGHT SO FAR*'): string {
  if (!rows.length) return `${title}\nNothing logged.`;
  const ejected = rows.filter((r) => r.current_status === 'completely_refused' && /^Ejected/.test(r.reasoning)).length;
  const refused = rows.filter((r) => r.current_status === 'completely_refused').length - ejected;
  const awayNow = rows.filter((r) => r.current_status === 'cooling_off' && r.cool_down_until && new Date(r.cool_down_until) > now).length;
  const ended = rows.filter((r) => r.current_status === 'cooling_off' && (!r.cool_down_until || new Date(r.cool_down_until) <= now)).length;
  const admitted = rows.filter((r) => r.current_status === 'admitted').length;
  const hops = rows.filter((r) => r.breaches > 0);
  const lines = [
    title,
    `${rows.length} logged · 🔴 ${refused} refused${ejected ? ` · ⛔ ${ejected} ejected` : ''} · 🟠 ${awayNow} sent away now` +
      (ended ? ` · 🟡 ${ended} cool-off ended` : '') +
      (admitted ? ` · 🟢 ${admitted} cleared` : ''),
  ];
  if (hops.length) lines.push(`🚨 ${hops.length} tried another hub (${hops.reduce((n, r) => n + r.breaches, 0)} attempts)`);
  const reasons = tally(rows.flatMap((r) => reasonsOf(r.reasoning)));
  if (reasons) lines.push(`*Reasons:* ${reasons}`);
  const hubs = tally(rows.map((r) => r.origin_hub?.replace(' Hub', '') ?? '').filter(Boolean));
  if (hubs) lines.push(`*Hubs:* ${hubs}`);
  const people = rows.reduce((n, r) => n + (r.party_size || 1), 0);
  if (people > rows.length) lines.push(`*People:* ${people} (groups counted)`);
  const minors = rows.filter((r) => /Minor \(under 18\)|Intoxicated minor/.test(`${r.description} ${r.reasoning}`)).length;
  if (minors) lines.push(`*Minors:* ${minors}`);
  return lines.join('\n');
}

export async function currentStats(now = new Date()): Promise<string> {
  return statsText(await listRecords({}, 10_000), now);
}

// ---------------------------------------------------------------- readmit reminders

interface Expired {
  ticket_id: string;
  section: string | null;
  row_label: string | null;
  seat_number: string | null;
  reasoning: string;
  cool_down_until: Date;
  origin_hub: string | null;
  origin_at: Date | null;
}

/** Sent-away people whose cool-off ended in (from, to]. */
export async function cooloffsEndedBetween(from: Date, to: Date): Promise<Expired[]> {
  const { rows } = await getPool().query<Expired>(
    `SELECT t.ticket_id, t.section, t.row_label, t.seat_number, t.reasoning, t.cool_down_until,
            o.hub_location AS origin_hub, o.timestamp AS origin_at
       FROM tickets t
       LEFT JOIN LATERAL (
         SELECT hub_location, timestamp FROM scan_events e
          WHERE e.ticket_id = t.ticket_id ORDER BY timestamp ASC LIMIT 1
       ) o ON TRUE
      WHERE t.current_status = 'cooling_off' AND t.cool_down_until > $1 AND t.cool_down_until <= $2
      ORDER BY t.cool_down_until`,
    [from, to],
  );
  return rows;
}

export function readmitText(r: Expired): string {
  const reason = r.reasoning && r.reasoning !== 'Not provided' ? ` · ${sanitize(r.reasoning, 80)}` : '';
  const from = r.origin_hub ? ` at ${r.origin_hub.replace(' Hub', '')}${r.origin_at ? ` ${formatClock(r.origin_at)}` : ''}` : '';
  return `🟡 *${sanitize(seatOf(r), 40)}* may now be readmitted *if fit* (sent away${from}${reason}).`;
}

// ---------------------------------------------------------------- scheduler

/** "23:30" in the venue's time zone, and the date it belongs to. */
function localClock(d: Date): { hm: string; day: string } {
  const tz = getConfig().TZ_DISPLAY;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return { hm, day };
}

/**
 * Every minute: post readmit reminders for cool-offs that just ended, and the summary at
 * SUMMARY_TIME. `post` sends to the selected groups (it does nothing while unlinked).
 */
export function startNightJobs(
  post: (text: string) => void,
  everyMs = 60_000,
  clock: () => Date = () => new Date(),
  sendToAdmins?: (text: string, document: { data: Buffer; mime: string; fileName: string }) => void,
): () => void {
  let checkedUntil = clock(); // reminders only for cool-offs that end after the bot started
  let summarisedDay = '';
  const tick = async () => {
    const cfg = getConfig();
    const now = clock();
    try {
      if (cfg.WA_READMIT_REMINDERS) {
        for (const r of await cooloffsEndedBetween(checkedUntil, now)) post(readmitText(r));
      }
      checkedUntil = now;

      if (!/^off$/i.test(cfg.SUMMARY_TIME)) {
        const { hm, day } = localClock(now);
        if (hm === cfg.SUMMARY_TIME && summarisedDay !== day) {
          summarisedDay = day;
          const rows = await listRecords({}, 10_000);
          if (rows.length && cfg.WA_NIGHTLY_BACKUP && sendToAdmins) {
            sendToAdmins(
              `🗂️ Tonight's records (${rows.length}), before they're deleted automatically after ${cfg.RETENTION_HOURS} hours. Save this file if you need it.`,
              { data: Buffer.from('\ufeff' + recordsToCsv(rows), 'utf8'), mime: 'text/csv', fileName: `gatekeeper-${day}.csv` },
            );
          }
          if (rows.length) {
            post(`${statsText(rows, now, '🌙 *END OF NIGHT SUMMARY*')}\n\n_Send *LIST* for who is still refused, or *REPORT* to me privately for the spreadsheet. Records are deleted automatically after ${cfg.RETENTION_HOURS} hours._`);
          }
        }
      }
    } catch (err) {
      if (!isConnectivityError(err)) console.error('[night-jobs] failed:', (err as Error).message);
    }
  };
  const handle = setInterval(() => void tick(), everyMs);
  (handle as { unref?: () => void }).unref?.();
  return () => clearInterval(handle);
}
