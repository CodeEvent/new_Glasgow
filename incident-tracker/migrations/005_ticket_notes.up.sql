-- =====================================================================
-- 005_ticket_notes (UP)
-- Free-text notes stewards add to a record from WhatsApp ("NOTE 52 YY 14 came
-- back calm"). Deleted with the ticket (24h retention).
-- =====================================================================

CREATE TABLE ticket_notes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id  VARCHAR(64) NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
    author     VARCHAR(100) NOT NULL,
    body       TEXT NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 500),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX idx_ticket_notes_ticket ON ticket_notes(ticket_id, created_at);
