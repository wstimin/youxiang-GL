CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  totp_secret_encrypted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  session_id BIGSERIAL,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip_digest TEXT,
  user_agent TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_id BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_digest TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT '';
CREATE SEQUENCE IF NOT EXISTS sessions_session_id_seq OWNED BY sessions.session_id;
ALTER TABLE sessions ALTER COLUMN session_id SET DEFAULT nextval('sessions_session_id_seq');
UPDATE sessions SET session_id = nextval('sessions_session_id_seq') WHERE session_id IS NULL;
SELECT setval(
  'sessions_session_id_seq',
  GREATEST((SELECT COALESCE(MAX(session_id), 0) FROM sessions), 1),
  EXISTS (SELECT 1 FROM sessions)
);
ALTER TABLE sessions ALTER COLUMN session_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_session_id_idx ON sessions(session_id);

CREATE TABLE IF NOT EXISTS login_challenges (
  id_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mail_accounts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'icloud',
  app_password_encrypted TEXT NOT NULL,
  host TEXT NOT NULL DEFAULT 'imap.mail.me.com',
  port INTEGER NOT NULL DEFAULT 993,
  secure BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_uid BIGINT NOT NULL DEFAULT 0,
  uid_validity TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  last_synced_at TIMESTAMPTZ,
  sync_requested_at TIMESTAMPTZ,
  body_sync_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS uid_validity TEXT;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS sync_requested_at TIMESTAMPTZ;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS body_sync_completed_at TIMESTAMPTZ;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'icloud';
UPDATE mail_accounts SET provider = CASE
  WHEN LOWER(host) = 'imap.gmail.com' THEN 'gmail'
  WHEN LOWER(host) IN ('outlook.office365.com', 'imap-mail.outlook.com') THEN 'outlook'
  ELSE provider
END;

CREATE TABLE IF NOT EXISTS aliases (
  id BIGSERIAL PRIMARY KEY,
  mail_account_id BIGINT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  token_digest TEXT UNIQUE,
  token_encrypted TEXT,
  token_hint TEXT,
  token_expires_at TIMESTAMPTZ,
  totp_secret_encrypted TEXT,
  totp_issuer TEXT NOT NULL DEFAULT '',
  totp_account_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE aliases ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT;
ALTER TABLE aliases ADD COLUMN IF NOT EXISTS totp_issuer TEXT NOT NULL DEFAULT '';
ALTER TABLE aliases ADD COLUMN IF NOT EXISTS totp_account_name TEXT NOT NULL DEFAULT '';
ALTER TABLE aliases ADD COLUMN IF NOT EXISTS token_encrypted TEXT;

CREATE TABLE IF NOT EXISTS totp_entries (
  id BIGSERIAL PRIMARY KEY,
  secret_encrypted TEXT NOT NULL,
  secret_fingerprint TEXT NOT NULL UNIQUE,
  secret_hint TEXT NOT NULL DEFAULT '',
  issuer TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  legacy_alias_address TEXT NOT NULL DEFAULT '',
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS totp_entries_created_idx ON totp_entries(created_at DESC);

CREATE TABLE IF NOT EXISTS verification_messages (
  id BIGSERIAL PRIMARY KEY,
  mail_account_id BIGINT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  alias_id BIGINT REFERENCES aliases(id) ON DELETE CASCADE,
  message_key TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  code_encrypted TEXT,
  code_masked TEXT,
  confidence SMALLINT NOT NULL DEFAULT 0,
  body_text_encrypted TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  mail_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mail_account_id, message_key)
);

ALTER TABLE verification_messages ADD COLUMN IF NOT EXISTS body_text_encrypted TEXT;
ALTER TABLE verification_messages ADD COLUMN IF NOT EXISTS mail_expires_at TIMESTAMPTZ;
UPDATE verification_messages
SET mail_expires_at = COALESCE(received_at, created_at, NOW()) + INTERVAL '7 days'
WHERE mail_expires_at IS NULL;
ALTER TABLE verification_messages ALTER COLUMN mail_expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS verification_messages_alias_recent_idx
  ON verification_messages(alias_id, received_at DESC);
CREATE INDEX IF NOT EXISTS verification_messages_expires_idx
  ON verification_messages(expires_at);
CREATE INDEX IF NOT EXISTS verification_messages_mail_expires_idx
  ON verification_messages(mail_expires_at);

CREATE TABLE IF NOT EXISTS unmatched_messages (
  id BIGSERIAL PRIMARY KEY,
  mail_account_id BIGINT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_key TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  recipient_headers TEXT NOT NULL DEFAULT '',
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mail_account_id, message_key)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  ip_digest TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_status (
  service TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'starting',
  detail TEXT NOT NULL DEFAULT '',
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
