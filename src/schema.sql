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
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS sync_locked_at TIMESTAMPTZ;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS first_sync_completed BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE mail_accounts SET provider = CASE
  WHEN LOWER(host) = 'imap.gmail.com' THEN 'gmail'
  WHEN LOWER(host) IN ('outlook.office365.com', 'imap-mail.outlook.com') THEN 'outlook'
  ELSE provider
END;

CREATE TABLE IF NOT EXISTS mail_folders (
  id BIGSERIAL PRIMARY KEY,
  mail_account_id BIGINT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  special_use TEXT NOT NULL DEFAULT '',
  selectable BOOLEAN NOT NULL DEFAULT TRUE,
  uid_validity TEXT,
  last_uid BIGINT NOT NULL DEFAULT 0,
  history_synced_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mail_account_id, path)
);

INSERT INTO mail_folders(
  mail_account_id, path, special_use, selectable, uid_validity,
  last_uid, history_synced_at, last_synced_at
)
SELECT id, 'INBOX', '\\Inbox', TRUE, uid_validity,
       last_uid, body_sync_completed_at, last_synced_at
FROM mail_accounts
ON CONFLICT (mail_account_id, path) DO NOTHING;

CREATE INDEX IF NOT EXISTS mail_folders_account_idx
  ON mail_folders(mail_account_id, selectable, id);

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
  mailbox_paths TEXT[] NOT NULL DEFAULT ARRAY['INBOX']::TEXT[],
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  mail_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mail_account_id, message_key)
);

ALTER TABLE verification_messages ADD COLUMN IF NOT EXISTS body_text_encrypted TEXT;
ALTER TABLE verification_messages ADD COLUMN IF NOT EXISTS mail_expires_at TIMESTAMPTZ;
ALTER TABLE verification_messages ADD COLUMN IF NOT EXISTS mailbox_paths TEXT[] NOT NULL DEFAULT ARRAY['INBOX']::TEXT[];
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

CREATE TABLE IF NOT EXISTS mail_import_jobs (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  import_type TEXT NOT NULL CHECK (import_type IN ('aliases', 'mail_accounts')),
  total_count INTEGER NOT NULL DEFAULT 0,
  waiting_count INTEGER NOT NULL DEFAULT 0,
  validating_count INTEGER NOT NULL DEFAULT 0,
  syncing_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mail_import_jobs_admin_idx ON mail_import_jobs(admin_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mail_import_items (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES mail_import_jobs(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'icloud',
  app_password_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  failure_reason TEXT,
  mail_account_id BIGINT REFERENCES mail_accounts(id) ON DELETE SET NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mail_import_items_queue_idx
  ON mail_import_items(status, next_retry_at, id);
CREATE INDEX IF NOT EXISTS mail_import_items_job_idx ON mail_import_items(job_id, id);

CREATE TABLE IF NOT EXISTS mail_messages (
  id BIGSERIAL PRIMARY KEY,
  mail_account_id BIGINT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  alias_id BIGINT REFERENCES aliases(id) ON DELETE SET NULL,
  uid BIGINT NOT NULL,
  uid_validity TEXT NOT NULL,
  message_id TEXT NOT NULL DEFAULT '',
  mailbox_paths TEXT[] NOT NULL DEFAULT ARRAY['INBOX']::TEXT[],
  sender TEXT NOT NULL DEFAULT '',
  recipients_encrypted TEXT,
  subject TEXT NOT NULL DEFAULT '',
  body_preview TEXT NOT NULL DEFAULT '',
  body_text_encrypted TEXT,
  code_encrypted TEXT,
  code_masked TEXT,
  confidence SMALLINT NOT NULL DEFAULT 0,
  code_expires_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mail_expires_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS code_expires_at TIMESTAMPTZ;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS mailbox_paths TEXT[] NOT NULL DEFAULT ARRAY['INBOX']::TEXT[];
ALTER TABLE mail_messages DROP CONSTRAINT IF EXISTS mail_messages_mail_account_id_uid_validity_uid_key;
DROP INDEX IF EXISTS mail_messages_account_message_idx;
WITH duplicate_messages AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY mail_account_id, message_id
           ORDER BY id
         ) AS row_number
  FROM mail_messages
  WHERE message_id <> ''
)
DELETE FROM mail_messages mm
USING duplicate_messages duplicate
WHERE mm.id = duplicate.id AND duplicate.row_number > 1;
CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_account_message_nonempty_idx
  ON mail_messages(mail_account_id, message_id)
  WHERE message_id <> '';

CREATE INDEX IF NOT EXISTS mail_messages_recent_idx ON mail_messages(received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS mail_messages_alias_recent_idx ON mail_messages(alias_id, received_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS mail_message_locations (
  id BIGSERIAL PRIMARY KEY,
  mail_message_id BIGINT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  mail_folder_id BIGINT NOT NULL REFERENCES mail_folders(id) ON DELETE CASCADE,
  uid BIGINT NOT NULL,
  uid_validity TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mail_folder_id, uid_validity, uid)
);

ALTER TABLE mail_message_locations
  DROP CONSTRAINT IF EXISTS mail_message_locations_mail_message_id_mail_folder_id_key;

INSERT INTO mail_message_locations(mail_message_id, mail_folder_id, uid, uid_validity)
SELECT mm.id, mf.id, mm.uid, mm.uid_validity
FROM mail_messages mm
JOIN mail_folders mf ON mf.mail_account_id = mm.mail_account_id AND mf.path = 'INBOX'
ON CONFLICT (mail_folder_id, uid_validity, uid) DO NOTHING;

CREATE INDEX IF NOT EXISTS mail_message_locations_message_idx
  ON mail_message_locations(mail_message_id, mail_folder_id);

CREATE TABLE IF NOT EXISTS unmatched_messages (
  id BIGSERIAL PRIMARY KEY,
  mail_account_id BIGINT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_key TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  mailbox_paths TEXT[] NOT NULL DEFAULT ARRAY['INBOX']::TEXT[],
  recipient_headers TEXT NOT NULL DEFAULT '',
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mail_account_id, message_key)
);

ALTER TABLE unmatched_messages ADD COLUMN IF NOT EXISTS mailbox_paths TEXT[] NOT NULL DEFAULT ARRAY['INBOX']::TEXT[];

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
