-- =====================================================================
-- 001_init_incident_schema (DOWN)
-- Reverses 001 in dependency order. Destroys all incident data.
-- =====================================================================

DROP TRIGGER IF EXISTS trg_tickets_updated_at ON tickets;
DROP FUNCTION IF EXISTS set_tickets_updated_at();

DROP INDEX IF EXISTS idx_tickets_cool_down_active;
DROP INDEX IF EXISTS idx_scan_events_breaches;
DROP INDEX IF EXISTS idx_scan_events_ticket_ts;
DROP INDEX IF EXISTS idx_scan_events_timestamp;
DROP INDEX IF EXISTS idx_scan_events_ticket_id;
DROP INDEX IF EXISTS idx_tickets_status;

DROP TABLE IF EXISTS scan_events;
DROP TABLE IF EXISTS tickets;

DROP TYPE IF EXISTS screening_hub;
DROP TYPE IF EXISTS incident_status;

-- pgcrypto is intentionally left installed: other schemas (e.g. Supabase auth) may depend on it.
