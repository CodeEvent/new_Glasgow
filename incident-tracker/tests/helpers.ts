import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrate } from '../src/db/migrate';
import { getPool } from '../src/db/pool';
import { resetConfigCache } from '../src/config/env';
import { mockOutbox } from '../src/services/whatsapp';

export const HAS_DB = Boolean(process.env.TEST_DATABASE_URL);
let migrated = false;

export async function resetDatabase(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL!;
  if (!migrated) {
    await migrate('up', url); // applies only pending migrations
    migrated = true;
  }
  await getPool().query('TRUNCATE tickets CASCADE');
  mockOutbox.length = 0;
}

export function tempOfflineLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatekeeper-'));
  const file = path.join(dir, 'offline_incidents.log');
  process.env.OFFLINE_LOG_PATH = file;
  resetConfigCache();
  return file;
}

/** Waits for fire-and-forget alert dispatches to land in the mock outbox. */
export async function flushAsync(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 10));
}

export const baseScan = {
  ticket_id: 'TM-847294-X',
  hub_location: 'West Hub',
  latitude: 55.8497,
  longitude: -4.2055,
  steward_name: 'Supervisor Dave',
  action_logged: 'cool_off',
  party_size: 4,
  description: 'Male, 6ft, neon green hat',
  indicators: ['Slurred speech', 'Stumbling'],
};
