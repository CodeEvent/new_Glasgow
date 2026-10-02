/**
 * Headless check that the demo engine (PGlite + adapter) runs every scenario.
 * Run: npx tsx src/demo/smoke.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-demo-smoke-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'pglite://memory',
  WHATSAPP_ACCESS_TOKEN: 'demo',
  WHATSAPP_PHONE_NUMBER_ID: 'demo',
  WHATSAPP_GROUP_ID: 'DEMO-GROUP',
  WHATSAPP_VERIFY_TOKEN: 'demo',
  MOCK_WHATSAPP_API: 'true',
  OFFLINE_LOG_PATH: path.join(tmp, 'offline_incidents.log'),
  OFFLINE_SYNC_INTERVAL_MS: '60000',
});

async function main() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { createDemoEngine } = await import('./engine');
  const migDir = path.resolve(__dirname, '../../migrations');
  const sql = fs.readdirSync(migDir).filter((f) => f.endsWith('.up.sql')).sort().map((f) => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');
  const engine = await createDemoEngine(await PGlite.create(), sql);

  const base = { ticket_id: 'TM-1', steward_name: 'Dave', party_size: 2, description: 'Green hat' };
  const expect = (label: string, cond: boolean) => {
    console.log(`${cond ? '✓' : '✗'} ${label}`);
    if (!cond) process.exitCode = 1;
  };

  const a = await engine.scan({ ...base, hub_location: 'West Hub', action_logged: 'cool_off' });
  expect('A new incident', a.body.scenario === 'NEW_INCIDENT');
  const [b1, b2] = await Promise.all([
    engine.scan({ ...base, hub_location: 'South Hub', action_logged: 'cool_off', steward_name: 'Sarah' }),
    engine.lookup('TM-1'),
  ]);
  expect('B hub hop', b1.body.scenario === 'HUB_HOP_BYPASS');
  expect('lookup during txn', b2.body.found === true);
  const c = await engine.scan({ ...base, hub_location: 'East Hub', action_logged: 'admitted', steward_name: 'Kev' });
  expect('C breach', c.body.scenario === 'UNAUTHORIZED_ADMISSION');

  await engine.scan({ ...base, ticket_id: 'TM-2', hub_location: 'West Hub', action_logged: 'cool_off' });
  await engine.timeTravel('TM-2', 31);
  const cleared = await engine.scan({ ...base, ticket_id: 'TM-2', hub_location: 'West Hub', action_logged: 'admitted' });
  expect('cleared admission after time travel', cleared.body.scenario === 'CLEARED_ADMISSION');

  const r = await engine.chat('check tm-1');
  expect('chat Check handled', r.handled);
  expect('profile reply', engine.messages().at(-1)!.text.body.includes('TICKET PROFILE RETRIEVED'));

  await engine.setOutage(true);
  const off = await engine.scan({ ...base, ticket_id: 'TM-3', hub_location: 'South Hub', action_logged: 'refused' });
  expect('outage buffers (202)', off.status === 202);
  expect('offline log has entry', (await engine.state()).offline_log.length === 1);
  await engine.setOutage(false);
  const st = await engine.state();
  expect('resynced after restore', st.offline_log.length === 0 && st.tickets.some((t) => t.ticket_id === 'TM-3'));
  expect('delayed sync alert', engine.messages().some((m) => m.text.body.includes('DELAYED SYNC')));

  await engine.reset();
  expect('reset', (await engine.state()).tickets.length === 0);
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
