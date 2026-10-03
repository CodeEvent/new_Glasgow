-- =====================================================================
-- 006_venue_map (UP)
-- The seating-plan image an admin uploads for the records page map. It stays in
-- this database (on the phone/server), never in the code repository. Block
-- positions on it live in app_settings ('map_blocks').
-- =====================================================================

CREATE TABLE venue_map (
    id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- one plan
    mime_type  VARCHAR(50) NOT NULL,
    data       BYTEA NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    CONSTRAINT chk_venue_map_size CHECK (octet_length(data) <= 10 * 1024 * 1024)
);
