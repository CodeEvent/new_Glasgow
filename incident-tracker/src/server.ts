import 'dotenv/config';
import { validateEnvOrExit } from './config/env';

// Fail fast before anything touches the database or Meta.
const config = validateEnvOrExit();

import { createApp } from './app';
import { closePool } from './db/pool';
import { startOfflineSyncWatchdog } from './services/offlineSync';
import { linkedWhatsApp } from './channels/linkedWhatsApp';
import { startRetentionJob } from './services/retention';
import { startNightJobs } from './services/nightReport';
import { startFeedJobs } from './services/appFeed';
import { startHealthJob } from './services/health';

const app = createApp();
// HOST=127.0.0.1 keeps the server private to this computer (used by `npm run local`).
const server = app.listen(config.PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`[gatekeeper] listening on :${config.PORT} (env=${config.NODE_ENV})`);
  if (config.MOCK_WHATSAPP_API) console.log('[gatekeeper] MOCK_WHATSAPP_API=true — outbound WhatsApp messages are logged, not sent');
});

const stopWatchdog = startOfflineSyncWatchdog();
const stopRetention = startRetentionJob();
const stopFeedJobs = startFeedJobs(); // 'may now be readmitted' alerts in the app

// Readmit reminders and the end-of-night summary, posted into the selected WhatsApp groups.
const stopNightJobs = config.WA_LINKED_ENABLED
  ? startNightJobs(
      (text) => void linkedWhatsApp.postToGroups(text),
      undefined,
      undefined,
      (text, doc) => void linkedWhatsApp.sendToAdmins(text, doc),
    )
  : () => undefined;
// Battery / unplugged alerts to the group admins (Android phone with Termux:API only).
const stopHealth =
  config.WA_LINKED_ENABLED && config.WA_HEALTH_ALERTS ? startHealthJob((text) => void linkedWhatsApp.sendToAdmins(text)) : () => undefined;

if (config.WA_LINKED_ENABLED) {
  linkedWhatsApp
    .start()
    .then(() => console.log(`[gatekeeper] WhatsApp group bot starting; link the phone at /admin/whatsapp`))
    .catch((err) => console.error('[gatekeeper] WhatsApp group bot failed to start:', err));
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[gatekeeper] ${signal} received, draining…`);
  stopWatchdog();
  stopRetention();
  stopFeedJobs();
  stopNightJobs();
  stopHealth();
  await linkedWhatsApp.stop().catch(() => undefined);
  server.close(async () => {
    await closePool().catch(() => undefined);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('[gatekeeper] unhandled rejection:', reason));
