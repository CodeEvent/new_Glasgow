-- =====================================================================
-- 002_seat_location (UP)
-- Section / row / seat on tickets. Ticketmaster SafeTix QR codes rotate every
-- few seconds, so the seat is the stable way to recognise the same patron at
-- another hub. seat_key is the normalised lookup value (upper-case, no spaces).
-- =====================================================================

ALTER TABLE tickets
    ADD COLUMN section     VARCHAR(16),
    ADD COLUMN row_label   VARCHAR(8),
    ADD COLUMN seat_number VARCHAR(8),
    ADD COLUMN seat_key    TEXT GENERATED ALWAYS AS (
        CASE WHEN section IS NOT NULL AND row_label IS NOT NULL AND seat_number IS NOT NULL THEN
            upper(regexp_replace(section, '\s+', '', 'g')) || '|' ||
            upper(regexp_replace(row_label, '\s+', '', 'g')) || '|' ||
            upper(regexp_replace(seat_number, '\s+', '', 'g'))
        END
    ) STORED;

-- All three parts or none.
ALTER TABLE tickets ADD CONSTRAINT chk_tickets_seat_complete CHECK (
    (section IS NULL) = (row_label IS NULL) AND (row_label IS NULL) = (seat_number IS NULL)
);

CREATE INDEX idx_tickets_seat_key ON tickets(seat_key) WHERE seat_key IS NOT NULL;
