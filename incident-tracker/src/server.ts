import 'dotenv/config';
import { validateEnvOrExit } from './config/env';

// Fail fast before anything touches the database or Meta.
const config = validateEnvOrExit();

import { createApp } from './app';
import { closePool } from './db/pool';
import { startOfflineSyncWatchdog } from './services/offlineSync';

const app = createApp();
const server = app.listen(config.PORT, () => {
  console.log(`[gatekeeper] listening on :${config.PORT} (env=${config.NODE_ENV})`);
  if (config.MOCK_WHATSAPP_API) console.log('[gatekeeper] MOCK_WHATSAPP_API=true — outbound WhatsApp messages are logged, not sent');
});

const stopWatchdog = startOfflineSyncWatchdog();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[gatekeeper] ${signal} received, draining…`);
  stopWatchdog();
  server.close(async () => {
    await closePool().catch(() => undefined);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('[gatekeeper] unhandled rejection:', reason));
