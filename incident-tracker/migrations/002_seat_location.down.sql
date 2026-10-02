-- 002_seat_location (DOWN)
DROP INDEX IF EXISTS idx_tickets_seat_key;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS chk_tickets_seat_complete;
ALTER TABLE tickets
    DROP COLUMN IF EXISTS seat_key,
    DROP COLUMN IF EXISTS seat_number,
    DROP COLUMN IF EXISTS row_label,
    DROP COLUMN IF EXISTS section;
