import { getSetting, setSetting } from '../channels/pgAuthState';
import { getConfig } from '../config/env';
import { HUBS } from '../domain';
import { getPool } from '../db/pool';
import { audit } from './accounts';
import { listRecords, recordsToCsv, type RecordRow } from './adminRecords';
import { reasonsOf } from './nightReport';
import type { AppUser } from './permissions';
import { MAP_IMAGE_TYPES, MAX_MAP_BYTES, deleteBlock, getBlocks, getMapImage, hasMapImage, setBlock, setMapImage, validBlock } from './venueMap';

/**
 * The dashboard (live numbers for seniors and the superadmin), events (each match or concert, with
 * its final numbers kept for good), and the app's settings (superadmin).
 */

export class DashError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// ---------------------------------------------------------------- numbers

export interface Summary {
  from: string;
  to: string;
  counts: {
    logged: number;
    refused: number;
    ejected: number;
    away_now: number;
    back_soon: number; // sent away, allowed back within 30 minutes
    ended: number; // sent away, cool-off over
    cleared: number;
    reentries: number;
    people: number;
    minors: number;
  };
  by_hub: Record<string, number>;
  by_reason: Array<{ reason: string; count: number }>;
  by_hour: Array<{ hour: string; count: number }>;
  sections: Record<string, { refused: number; ejected: number; away: number; ended: number; cleared: number; total: number }>;
}

const hourOf = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: getConfig().TZ_DISPLAY, hour: '2-digit', hourCycle: 'h23' }).format(d);

export function summarise(rows: RecordRow[], from: Date, to: Date): Summary {
  const now = to;
  const isEjected = (r: RecordRow) => r.current_status === 'completely_refused' && /^Ejected/.test(r.reasoning);
  const away = (r: RecordRow) => r.current_status === 'cooling_off' && !!r.cool_down_until && new Date(r.cool_down_until) > now;
  const counts: Summary['counts'] = {
    logged: rows.length,
    refused: rows.filter((r) => r.current_status === 'completely_refused' && !isEjected(r)).length,
    ejected: rows.filter(isEjected).length,
    away_now: rows.filter(away).length,
    back_soon: rows.filter((r) => away(r) && new Date(r.cool_down_until!).getTime() - now.getTime() <= 30 * 60_000).length,
    ended: rows.filter((r) => r.current_status === 'cooling_off' && !away(r)).length,
    cleared: rows.filter((r) => r.current_status === 'admitted').length,
    reentries: rows.filter((r) => r.breaches > 0 || /tried re-entry/.test(r.reasoning)).length,
    people: rows.reduce((n, r) => n + (r.party_size || 1), 0),
    minors: rows.filter((r) => /Minor \(under 18\)|Intoxicated minor/.test(`${r.description} ${r.reasoning}`)).length,
  };
  const by_hub = Object.fromEntries(HUBS.map((h) => [h, rows.filter((r) => r.origin_hub === h).length]));
  const reasonCounts = new Map<string, number>();
  for (const r of rows) for (const reason of new Set(reasonsOf(r.reasoning))) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  const by_reason = [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  // One bar per hour from the start of the window (at most 24).
  const by_hour: Summary['by_hour'] = [];
  const startHour = new Date(Math.max(from.getTime(), to.getTime() - 23 * 3_600_000));
  startHour.setMinutes(0, 0, 0);
  for (let t = startHour.getTime(); t <= to.getTime() && by_hour.length < 24; t += 3_600_000) {
    by_hour.push({ hour: `${hourOf(new Date(t))}:00`, count: rows.filter((r) => {
      const at = new Date(r.origin_at ?? r.created_at).getTime();
      return at >= t && at < t + 3_600_000;
    }).length });
  }

  const sections: Summary['sections'] = {};
  for (const r of rows) {
    if (!r.section) continue;
    const c = (sections[r.section.replace(/\s+/g, '').toUpperCase()] ??= { refused: 0, ejected: 0, away: 0, ended: 0, cleared: 0, total: 0 });
    if (r.current_status === 'admitted') c.cleared++;
    else if (isEjected(r)) c.ejected++;
    else if (r.current_status === 'completely_refused') c.refused++;
    else if (away(r)) c.away++;
    else c.ended++;
    c.total++;
  }
  return { from: from.toISOString(), to: to.toISOString(), counts, by_hub, by_reason, by_hour, sections };
}

/** Records first logged in [from, to]. */
async function rowsBetween(from: Date, to: Date): Promise<RecordRow[]> {
  return (await listRecords({}, 20_000)).filter((r) => {
    const at = new Date(r.origin_at ?? r.created_at).getTime();
    return at >= from.getTime() && at <= to.getTime();
  });
}

// ---------------------------------------------------------------- events

interface EventRow {
  id: string;
  name: string;
  started_at: Date;
  ended_at: Date | null;
  started_by: string;
  ended_by: string | null;
  summary: Summary | null;
}

async function openEvent(): Promise<EventRow | null> {
  const { rows } = await getPool().query<EventRow>('SELECT * FROM venue_events WHERE ended_at IS NULL LIMIT 1');
  return rows[0] ?? null;
}

/** Live numbers: since the running event started, or the last 12 hours when none is running. */
export async function dashboard(now = new Date()) {
  const event = await openEvent();
  const from = event ? new Date(event.started_at) : new Date(now.getTime() - 12 * 3_600_000);
  return { event, ...summarise(await rowsBetween(from, now), from, now) };
}

export async function startEvent(user: AppUser, nameIn: unknown) {
  const name = String(nameIn ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80) throw new DashError('Give the event a name (up to 80 characters), e.g. Celtic v Rangers.');
  if (await openEvent()) throw new DashError('An event is already running: end it first.', 409);
  try {
    const { rows } = await getPool().query<EventRow>('INSERT INTO venue_events (name, started_at, started_by) VALUES ($1, NOW(), $2) RETURNING *', [name, user.name]);
    await audit(user, 'event_started', name);
    return rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new DashError('An event is already running: end it first.', 409);
    throw err;
  }
}

export async function endEvent(user: AppUser) {
  const ev = await openEvent();
  if (!ev) throw new DashError('No event is running.', 409);
  const now = new Date();
  const summary = summarise(await rowsBetween(new Date(ev.started_at), now), new Date(ev.started_at), now);
  const { rows } = await getPool().query<EventRow>(
    'UPDATE venue_events SET ended_at = $2, ended_by = $3, summary = $4 WHERE id = $1 AND ended_at IS NULL RETURNING *',
    [ev.id, now, user.name, JSON.stringify(summary)],
  );
  if (!rows[0]) throw new DashError('No event is running.', 409);
  await audit(user, 'event_ended', `${ev.name}: ${summary.counts.logged} logged`);
  return rows[0];
}

export async function listEvents(): Promise<EventRow[]> {
  const { rows } = await getPool().query<EventRow>('SELECT * FROM venue_events ORDER BY started_at DESC LIMIT 100');
  return rows;
}

async function getEvent(id: string): Promise<EventRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DashError('Not found.', 404);
  const { rows } = await getPool().query<EventRow>('SELECT * FROM venue_events WHERE id = $1', [id]);
  if (!rows[0]) throw new DashError('Not found.', 404);
  return rows[0];
}

/** An ended event's kept numbers, or a running event's numbers so far. */
export async function eventReport(id: string) {
  const ev = await getEvent(id);
  const summary = ev.summary ?? summarise(await rowsBetween(new Date(ev.started_at), new Date()), new Date(ev.started_at), new Date());
  return { event: { ...ev, summary: undefined }, summary };
}

/** The event's records that are still kept (30 days), as a spreadsheet. */
export async function eventCsv(id: string): Promise<{ name: string; csv: string }> {
  const ev = await getEvent(id);
  const rows = await rowsBetween(new Date(ev.started_at), ev.ended_at ? new Date(ev.ended_at) : new Date());
  return { name: ev.name, csv: `﻿${recordsToCsv(rows)}` };
}

// ---------------------------------------------------------------- settings (superadmin)

export interface AppSettings {
  policy: string;
  ai_enabled: boolean;
  venue_name: string;
}

export async function getAppSettings(): Promise<AppSettings> {
  const [stored, policy] = await Promise.all([
    getSetting<Partial<AppSettings> | null>('app_settings', null),
    getSetting<{ text: string } | null>('refusal_policy', null),
  ]);
  return { policy: policy?.text ?? '', ai_enabled: stored?.ai_enabled ?? true, venue_name: stored?.venue_name ?? '' };
}

export async function putAppSettings(user: AppUser, body: { policy?: unknown; ai_enabled?: unknown; venue_name?: unknown }): Promise<AppSettings> {
  const cur = await getAppSettings();
  const next = { ...cur };
  if (body.policy !== undefined) {
    const p = String(body.policy).trim();
    if (p.length > 4000) throw new DashError('The policy is too long (4,000 characters at most).');
    next.policy = p;
  }
  if (body.ai_enabled !== undefined) next.ai_enabled = body.ai_enabled === true;
  if (body.venue_name !== undefined) {
    const v = String(body.venue_name).trim();
    if (v.length > 60) throw new DashError('The venue name is too long.');
    next.venue_name = v;
  }
  await setSetting('app_settings', { ai_enabled: next.ai_enabled, venue_name: next.venue_name });
  if (next.policy !== cur.policy) {
    await setSetting('refusal_policy', next.policy ? { text: next.policy, by: user.name, at: new Date().toISOString() } : null);
  }
  const changed = (['policy', 'ai_enabled', 'venue_name'] as const).filter((k) => next[k] !== cur[k]);
  if (changed.length) await audit(user, 'settings_changed', changed.join(', '));
  return next;
}

// ---------------------------------------------------------------- seating map

export async function mapInfo() {
  return { has_image: await hasMapImage(), blocks: await getBlocks() };
}

export { getMapImage };

export async function putMapImage(user: AppUser, data: unknown, mime: string): Promise<void> {
  const type = mime.split(';')[0].trim().toLowerCase();
  if (!(MAP_IMAGE_TYPES as readonly string[]).includes(type)) throw new DashError('The plan must be a PNG, JPEG, WebP or GIF image.', 415);
  if (!Buffer.isBuffer(data) || !data.length) throw new DashError('Send the plan image.');
  if (data.length > MAX_MAP_BYTES) throw new DashError('The plan image is too big (10 MB at most).', 413);
  await setMapImage(data, type);
  await audit(user, 'map_changed', 'new plan image');
}

export async function putBlock(user: AppUser, block: string, body: { x?: unknown; y?: unknown }) {
  const [x, y] = [Number(body.x), Number(body.y)];
  if (!validBlock(block)) throw new DashError('Section names: letters and numbers, up to 6.');
  if (![x, y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new DashError('Position must be inside the plan.');
  const blocks = await setBlock(block, x, y);
  await audit(user, 'map_changed', `placed ${block.toUpperCase()}`);
  return blocks;
}

export async function removeBlock(user: AppUser, block: string) {
  if (!validBlock(block)) throw new DashError('Not found.', 404);
  const blocks = await deleteBlock(block);
  await audit(user, 'map_changed', `removed ${block.toUpperCase()}`);
  return blocks;
}
