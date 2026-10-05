-- =====================================================================
-- 010_photo_details (UP)
-- Photos added in the app: of the person or of the ticket, and who added them.
-- Still deleted with the record (RETENTION).
-- =====================================================================

ALTER TABLE ticket_photos ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'ticket'));
ALTER TABLE ticket_photos ADD COLUMN user_id UUID REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE ticket_photos ADD COLUMN added_by VARCHAR(60);
