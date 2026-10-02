-- =====================================================================
-- 003_linked_whatsapp (UP)
-- Storage for the linked-device WhatsApp group bot: its session keys (so a
-- linked phone survives redeploys) and small app settings (selected groups).
-- =====================================================================

CREATE TABLE wa_session (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,          -- JSON with Buffers encoded (Baileys BufferJSON)
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);
