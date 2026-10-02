import path from 'path';
import fs from 'fs';
import { getConfig } from '../config/env';
import { getPool, isConnectivityError } from '../db/pool';
import { offlineLogPath, readOfflineIncidents, type OfflineEntry } from './offlineBuffer';
import { runScanPipeline } from './scanPipeline';
import { scanInputSchema } from './scanService';

export interface ResyncReport {
  attempted: number;
  synced: number;
  failed: number; // permanently rejected (validation / constraint) -> dead letter
  requeued: number; // DB dropped mid-sync -> back in the offline log
  malformed: number;
}

let running = false;

/**
 * Replays offline_incidents.log into PostgreSQL in original scan order.
 *
 * The live log is atomically renamed to a ".syncing" file first, so scans that
 * arrive (and get buffered) during the replay land in a fresh log and are never lost.
 * Synced entries are archived to offline_incidents.synced.log for audit;
 * permanently invalid entries go to offline_incidents.rejected.log.
 */
export async function resyncOfflineIncidents(opts: { sendAlerts?: boolean } = {}): Promise<ResyncReport> {
  const report: ResyncReport = { attempted: 0, synced: 0, failed: 0, requeued: 0, malformed: 0 };
  if (running) return report;
  running = true;

  const live = offlineLogPath();
  const claimed = `${live}.${Date.now()}.syncing`;
  const stem = live.replace(/\.log$/, '');
  const rejectedLog = `${stem}.rejected.log`;
  const syncedLog = `${stem}.synced.log`;
  try {
    // Pick up any ".syncing" files orphaned by a crash, plus the current live log.
    const dir = path.dirname(live);
    const base = path.basename(live);
    const orphans = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.syncing'))
      .map((f) => path.join(dir, f));
    if (fs.existsSync(live) && fs.statSync(live).size > 0) {
      fs.renameSync(live, claimed);
      orphans.push(claimed);
    }
    if (orphans.length === 0) return report;

    const entries: OfflineEntry[] = [];
    for (const file of orphans) {
      const { entries: e, malformed } = readOfflineIncidents(file);
      entries.push(...e);
      report.malformed += malformed.length;
      if (malformed.length) {
        fs.appendFileSync(rejectedLog, malformed.map((m) => `${m}\n`).join(''));
      }
    }
    entries.sort((a, b) => (a.payload.occurred_at ?? a.buffered_at).localeCompare(b.payload.occurred_at ?? b.buffered_at));

    const requeue: OfflineEntry[] = [];
    let dbDown = false;
    for (const entry of entries) {
      if (dbDown) {
        requeue.push(entry);
        continue;
      }
      report.attempted++;
      const parsed = scanInputSchema.safeParse({
        ...entry.payload,
        occurred_at: entry.payload.occurred_at ?? entry.buffered_at,
      });
      if (!parsed.success) {
        report.failed++;
        fs.appendFileSync(rejectedLog, JSON.stringify({ ...entry, error: parsed.error.message }) + '\n');
        continue;
      }
      try {
        const res = await runScanPipeline(parsed.data, { replayed: true, bufferOnOutage: false });
        if (opts.sendAlerts !== false && res.alert) await res.alert;
        report.synced++;
        fs.appendFileSync(syncedLog, JSON.stringify({ ...entry, synced_at: new Date().toISOString() }) + '\n');
      } catch (err) {
        if (isConnectivityError(err)) {
          dbDown = true;
          report.attempted--;
          requeue.push(entry);
        } else {
          report.failed++;
          fs.appendFileSync(
            rejectedLog,
            JSON.stringify({ ...entry, error: (err as Error).message }) + '\n',
          );
        }
      }
    }

    if (requeue.length) {
      fs.appendFileSync(live, requeue.map((e) => JSON.stringify(e) + '\n').join(''));
      report.requeued = requeue.length;
    }
    for (const f of orphans) fs.rmSync(f, { force: true });
    return report;
  } finally {
    running = false;
  }
}

/**
 * Background watchdog: every `intervalMs`, if the offline log has entries and the
 * database answers, replay it. This is the "sync back the moment connectivity is restored" loop.
 */
export function startOfflineSyncWatchdog(intervalMs = getConfig().OFFLINE_SYNC_INTERVAL_MS): () => void {
  const tick = async () => {
    try {
      const live = offlineLogPath();
      const pending = fs.existsSync(live) && fs.statSync(live).size > 0;
      const orphan = fs
        .readdirSync(path.dirname(live))
        .some((f) => f.startsWith(`${path.basename(live)}.`) && f.endsWith('.syncing'));
      if (!pending && !orphan) return;
      await getPool().query('SELECT 1');
      const r = await resyncOfflineIncidents();
      if (r.attempted || r.requeued) console.log('[offline-sync] replay complete:', r);
    } catch (err) {
      if (!isConnectivityError(err)) console.error('[offline-sync] watchdog error:', (err as Error).message);
    }
  };
  const handle = setInterval(tick, intervalMs);
  (handle as { unref?: () => void }).unref?.();
  void tick();
  return () => clearInterval(handle);
}
