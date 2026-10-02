import { getConfig } from '../config/env';
import { getPool, isConnectivityError } from '../db/pool';

/**
 * Personal data (descriptions, photos) is only needed for the event itself.
 * Every ticket untouched for RETENTION_HOURS is deleted, which cascades to its
 * scan history and photos.
 */
export async function purgeExpired(hours = getConfig().RETENTION_HOURS): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM tickets WHERE updated_at < NOW() - make_interval(hours => $1)`,
    [hours],
  );
  return rowCount ?? 0;
}

export function startRetentionJob(everyMs = 15 * 60_000): () => void {
  const run = async () => {
    try {
      const n = await purgeExpired();
      if (n) console.log(`[retention] deleted ${n} record(s) older than ${getConfig().RETENTION_HOURS}h`);
    } catch (err) {
      if (!isConnectivityError(err)) console.error('[retention] purge failed:', (err as Error).message);
    }
  };
  const handle = setInterval(run, everyMs);
  (handle as { unref?: () => void }).unref?.();
  void run();
  return () => clearInterval(handle);
}
