-- =====================================================================
-- 008_app_tables (UP)
-- Logs sent from the app carry an id made on the phone. When a phone with
-- poor signal sends the same log again, the saved result is returned instead
-- of logging it twice. Cleared with the records (RETENTION).
-- =====================================================================

CREATE TABLE app_log_requests (
    client_id  UUID PRIMARY KEY,
    user_id    UUID REFERENCES app_users(id) ON DELETE SET NULL,
    results    JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);
CREATE INDEX idx_app_log_requests_created ON app_log_requests(created_at);

-- Phones that have logged in with the right PIN ("trusted devices"): a lock caused by someone else
-- guessing at a name doesn't stop the owner's own phone. Only a sha256 of the cookie is stored.
CREATE TABLE app_devices (
    token_hash   CHAR(64) PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);
CREATE INDEX idx_app_devices_user ON app_devices(user_id);
