import type { PGlite } from '@electric-sql/pglite';
import { setPool } from '../db/pool';
import { extractTextMessages, handleInboundMessage } from '../routes/whatsappWebhook';
import { handleScanRequest, handleTicketLookup, type ApiResponse } from '../services/scanApi';
import { offlineLogPath, readOfflineIncidents } from '../services/offlineBuffer';
import { resyncOfflineIncidents, startOfflineSyncWatchdog } from '../services/offlineSync';
import { mockOutbox, onMockMessage, type MockMessage } from '../services/whatsapp';
import { getConfig } from '../config/env';
import { createPglitePool, type PgliteDemoPool } from './pgliteAdapter';

/**
 * Demo control surface shared by the local demo server (`npm run demo`) and the
 * in-browser build. Everything here drives the real production modules; the only
 * stand-ins are the embedded database and mock WhatsApp transport.
 */

export interface DemoTicketRow {
  ticket_id: string;
  current_status: string;
  party_size: number;
  description: string;
  cool_down_until: string | null;
  created_at: string;
  scans: number;
  breaches: number;
  last_hub: string | null;
}

export interface DemoEventRow {
  ticket_id: string;
  hub_location: string;
  steward_name: string;
  action_logged: string;
  is_breach_event: boolean;
  timestamp: string;
}

export interface DemoState {
  database: 'up' | 'down';
  db_now: string | null;
  cool_off_minutes: number;
  tickets: DemoTicketRow[];
  events: DemoEventRow[];
  offline_log: string[];
}

export interface DemoEngine {
  scan(body: unknown): Promise<ApiResponse>;
  lookup(query: { ticket_id?: string; section?: string; row?: string; seat?: string } | string): Promise<ApiResponse>;
  /** A supervisor typing into the WhatsApp group. */
  chat(text: string, sender?: string): Promise<{ handled: boolean }>;
  setOutage(down: boolean): Promise<void>;
  /** Pretend `minutes` have passed for a ticket (moves its timestamps back). */
  timeTravel(ticketId: string, minutes: number): Promise<void>;
  resync(): ReturnType<typeof resyncOfflineIncidents>;
  reset(): Promise<void>;
  state(): Promise<DemoState>;
  messages(): MockMessage[];
  onMessage(listener: (m: MockMessage) => void): () => void;
  pool: PgliteDemoPool;
}

export async function createDemoEngine(db: PGlite, migrationSql: string): Promise<DemoEngine> {
  const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.tickets')::text AS t");
  if (!exists.rows[0]?.t) await db.exec(migrationSql);

  const pool = createPglitePool(db);
  setPool(pool);
  startOfflineSyncWatchdog();

  const groupId = getConfig().WHATSAPP_GROUP_ID;
  let seq = 0;

  return {
    pool,
    scan: (body) => handleScanRequest(body),
    lookup: (q) => handleTicketLookup(typeof q === 'string' ? { ticket_id: q } : q),

    async chat(text, sender = '447700900123') {
      // Shape the message exactly as Meta's webhook delivers it, then run the real parser + handler.
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [{ id: `wamid.demo.${Date.now()}.${seq++}`, from: sender, type: 'text', group_id: groupId, text: { body: text } }],
                },
              },
            ],
          },
        ],
      };
      let handled = false;
      for (const msg of extractTextMessages(payload)) {
        if ((await handleInboundMessage(msg)) !== null) handled = true;
      }
      return { handled };
    },

    async setOutage(down) {
      pool.setOutage(down);
      // Coming back online: replay straight away instead of waiting for the watchdog tick.
      if (!down) await resyncOfflineIncidents();
    },

    async timeTravel(ticketId, minutes) {
      const shift = `${Math.max(1, Math.floor(minutes))} minutes`;
      await pool.query(
        `UPDATE tickets
            SET created_at = created_at - $2::interval,
                cool_down_until = cool_down_until - $2::interval
          WHERE ticket_id = $1`,
        [ticketId, shift],
      );
      await pool.query('UPDATE scan_events SET timestamp = timestamp - $2::interval WHERE ticket_id = $1', [ticketId, shift]);
    },

    resync: () => resyncOfflineIncidents(),

    async reset() {
      pool.setOutage(false);
      await pool.query('TRUNCATE tickets CASCADE');
      mockOutbox.length = 0;
    },

    async state() {
      const offline = readOfflineIncidents(offlineLogPath()).entries.map((e) => JSON.stringify(e));
      if (pool.isDown()) {
        return { database: 'down', db_now: null, cool_off_minutes: getConfig().COOL_OFF_MINUTES, tickets: [], events: [], offline_log: offline };
      }
      const [tickets, events, now] = await Promise.all([
        pool.query(
          `SELECT t.ticket_id, t.current_status, t.party_size, t.description, t.cool_down_until, t.created_at,
                  count(e.id)::int AS scans,
                  count(e.id) FILTER (WHERE e.is_breach_event)::int AS breaches,
                  (array_agg(e.hub_location::text ORDER BY e.timestamp DESC))[1] AS last_hub
             FROM tickets t LEFT JOIN scan_events e ON e.ticket_id = t.ticket_id
            GROUP BY t.ticket_id
            ORDER BY max(e.timestamp) DESC NULLS LAST
            LIMIT 50`,
        ),
        pool.query(
          `SELECT ticket_id, hub_location, steward_name, action_logged, is_breach_event, timestamp
             FROM scan_events ORDER BY timestamp DESC LIMIT 40`,
        ),
        pool.query('SELECT NOW() AS now'),
      ]);
      return {
        database: 'up',
        db_now: new Date(now.rows[0].now).toISOString(),
        cool_off_minutes: getConfig().COOL_OFF_MINUTES,
        tickets: tickets.rows as DemoTicketRow[],
        events: events.rows as DemoEventRow[],
        offline_log: offline,
      };
    },

    messages: () => [...mockOutbox],
    onMessage: (l) => onMockMessage(l),
  };
}
