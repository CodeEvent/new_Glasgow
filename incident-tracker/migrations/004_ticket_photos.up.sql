-- =====================================================================
-- 004_ticket_photos (UP)
-- Photos sent to the WhatsApp bot when logging someone (the customer, so the
-- next gate can recognise them). Deleted with the ticket (24h retention).
-- =====================================================================

CREATE TABLE ticket_photos (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id  VARCHAR(64) NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
    mime_type  VARCHAR(50) NOT NULL DEFAULT 'image/jpeg',
    data       BYTEA NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    CONSTRAINT chk_ticket_photos_size CHECK (octet_length(data) <= 5 * 1024 * 1024)
);

CREATE INDEX idx_ticket_photos_ticket ON ticket_photos(ticket_id, created_at DESC);
-- Retention sweeps delete by age.
CREATE INDEX idx_tickets_updated_at ON tickets(updated_at);
