import 'dotenv/config';
import { validateEnvOrExit } from '../config/env';
import { closePool } from '../db/pool';
import { offlineLogPath } from '../services/offlineBuffer';
import { resyncOfflineIncidents } from '../services/offlineSync';

/** Manual re-sync of offline_incidents.log (the server also does this automatically). */
async function main() {
  validateEnvOrExit();
  const quiet = process.argv.includes('--no-alerts');
  console.log(`[resync] replaying ${offlineLogPath()}${quiet ? ' (WhatsApp alerts suppressed)' : ''}`);
  const report = await resyncOfflineIncidents({ sendAlerts: !quiet });
  console.log('[resync] done:', report);
  await closePool();
  process.exit(report.requeued ? 2 : 0);
}

main().catch(async (err) => {
  console.error('[resync] failed:', err);
  await closePool().catch(() => undefined);
  process.exit(1);
});
