-- =====================================================================
-- 001_init_incident_schema (UP)
-- Ticket incident tracking for East / West / South / Hospitality hubs.
-- Supabase compatible (PostgreSQL 13+). Runs inside a single transaction.
-- =====================================================================

-- gen_random_uuid() is core since PG13; pgcrypto keeps older hosts working.
-- Best-effort so hosts without the extension (e.g. embedded PGlite) still migrate.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgcrypto unavailable (%); relying on core gen_random_uuid()', SQLERRM;
END
$$;

CREATE TYPE incident_status AS ENUM ('cooling_off', 'completely_refused', 'admitted');
CREATE TYPE screening_hub AS ENUM ('East Hub', 'West Hub', 'South Hub', 'Hospitality Hub');

CREATE TABLE tickets (
    ticket_id        VARCHAR(64) PRIMARY KEY,
    current_status   incident_status NOT NULL,
    party_size       INTEGER NOT NULL DEFAULT 1 CHECK (party_size > 0),
    description      TEXT NOT NULL,
    reasoning        TEXT NOT NULL,
    cool_down_until  TIMESTAMP WITH TIME ZONE,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,

    CONSTRAINT chk_tickets_ticket_id_not_blank CHECK (length(btrim(ticket_id)) > 0),
    -- A cooling-off ticket must always carry its release time.
    CONSTRAINT chk_tickets_cooling_off_has_deadline
        CHECK (current_status <> 'cooling_off' OR cool_down_until IS NOT NULL),
    CONSTRAINT chk_tickets_updated_after_created CHECK (updated_at >= created_at)
);

CREATE TABLE scan_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       VARCHAR(64) NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
    hub_location    screening_hub NOT NULL,
    latitude        NUMERIC(10, 7),
    longitude       NUMERIC(10, 7),
    steward_name    VARCHAR(100) NOT NULL,
    action_logged   VARCHAR(50) NOT NULL,
    is_breach_event BOOLEAN NOT NULL DEFAULT FALSE,
    timestamp       TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,

    CONSTRAINT chk_scan_events_action_logged CHECK (action_logged IN (
        'initial_refusal',
        'initial_cool_off',
        'bypass_attempt',
        'unauthorized_admission',
        'cleared_admission',   -- admission after a cooling-off period has expired
        'repeat_scan'          -- same-hub re-scan, no state change
    )),
    -- Breach flag must agree with the action that was logged.
    CONSTRAINT chk_scan_events_breach_consistency CHECK (
        is_breach_event = (action_logged IN ('bypass_attempt', 'unauthorized_admission'))
    ),
    CONSTRAINT chk_scan_events_latitude  CHECK (latitude  IS NULL OR latitude  BETWEEN -90  AND 90),
    CONSTRAINT chk_scan_events_longitude CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
    CONSTRAINT chk_scan_events_steward_not_blank CHECK (length(btrim(steward_name)) > 0)
);

-- Indexes for performance optimizing live dashboard queries and lookups
CREATE INDEX idx_tickets_status ON tickets(current_status);
CREATE INDEX idx_scan_events_ticket_id ON scan_events(ticket_id);
CREATE INDEX idx_scan_events_timestamp ON scan_events(timestamp DESC);

-- Origin-hub lookup ("first log for this ticket") and per-ticket history, index-only.
CREATE INDEX idx_scan_events_ticket_ts ON scan_events(ticket_id, timestamp ASC) INCLUDE (hub_location);
-- Live breach feed for the supervisor dashboard.
CREATE INDEX idx_scan_events_breaches ON scan_events(timestamp DESC) WHERE is_breach_event;
-- "Who is still cooling off right now" sweeps.
CREATE INDEX idx_tickets_cool_down_active ON tickets(cool_down_until) WHERE current_status = 'cooling_off';

-- Keep updated_at honest regardless of which client writes the row.
CREATE OR REPLACE FUNCTION set_tickets_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := TIMEZONE('utc'::text, NOW());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tickets_updated_at
    BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION set_tickets_updated_at();
