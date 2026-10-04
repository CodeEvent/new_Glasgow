-- =====================================================================
-- 007_app_accounts (UP)
-- People who use the Gatekeeper app (name + PIN), their login sessions,
-- and an audit log of who changed what. Roles:
--   area       = area supervisor: logs only in their own hub, sees all
--   senior     = senior supervisor: sees, adds, edits and deletes everything
--   superadmin = all of that, plus settings and accounts
-- =====================================================================

CREATE TABLE app_users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(60) NOT NULL,
    name_key        VARCHAR(60) NOT NULL UNIQUE, -- lower-case name, for login and no duplicates
    role            VARCHAR(20) NOT NULL CHECK (role IN ('area', 'senior', 'superadmin')),
    hub             screening_hub,
    pin_hash        TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    last_login_at   TIMESTAMP WITH TIME ZONE,
    CONSTRAINT chk_app_users_area_has_hub CHECK (role <> 'area' OR hub IS NOT NULL),
    CONSTRAINT chk_app_users_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE TABLE app_sessions (
    token_hash  CHAR(64) PRIMARY KEY, -- sha256 of the cookie value; the token itself is never stored
    user_id     UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    expires_at  TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX idx_app_sessions_user ON app_sessions(user_id);

CREATE TABLE audit_log (
    id         BIGSERIAL PRIMARY KEY,
    at         TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    user_id    UUID REFERENCES app_users(id) ON DELETE SET NULL,
    user_name  VARCHAR(60) NOT NULL,
    action     VARCHAR(40) NOT NULL,
    detail     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_log_at ON audit_log(at DESC);

-- Which app user logged each event (the WhatsApp bot and older rows leave it empty).
ALTER TABLE scan_events ADD COLUMN user_id UUID REFERENCES app_users(id) ON DELETE SET NULL;
