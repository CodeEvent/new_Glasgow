import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getConfig } from '../config/env';
import type { ScanInput } from './scanService';

/**
 * Append-only JSON-lines buffer used when PostgreSQL is unreachable.
 * Each line is self-contained so a torn final write never corrupts earlier entries.
 */
export interface OfflineEntry {
  buffer_id: string;
  buffered_at: string; // ISO time the server received the scan
  reason: string;
  payload: ScanInput;
}

export function offlineLogPath(): string {
  return path.resolve(getConfig().OFFLINE_LOG_PATH);
}

export function appendOfflineIncident(payload: ScanInput, reason: string): OfflineEntry {
  const entry: OfflineEntry = {
    buffer_id: randomUUID(),
    buffered_at: new Date().toISOString(),
    reason,
    payload,
  };
  // Synchronous + O_APPEND: the scan is on disk before we tell the steward it was saved.
  fs.appendFileSync(offlineLogPath(), JSON.stringify(entry) + '\n', { encoding: 'utf8', flag: 'a' });
  return entry;
}

export interface ReadResult {
  entries: OfflineEntry[];
  malformed: string[];
}

export function readOfflineIncidents(file = offlineLogPath()): ReadResult {
  if (!fs.existsSync(file)) return { entries: [], malformed: [] };
  const entries: OfflineEntry[] = [];
  const malformed: string[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as OfflineEntry);
    } catch {
      malformed.push(line);
    }
  }
  return { entries, malformed };
}

export function hasPendingOfflineIncidents(file = offlineLogPath()): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}
