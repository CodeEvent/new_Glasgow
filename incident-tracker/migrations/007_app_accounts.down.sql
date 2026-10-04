-- 007_app_accounts (DOWN)
ALTER TABLE scan_events DROP COLUMN IF EXISTS user_id;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS app_sessions;
DROP TABLE IF EXISTS app_users;
