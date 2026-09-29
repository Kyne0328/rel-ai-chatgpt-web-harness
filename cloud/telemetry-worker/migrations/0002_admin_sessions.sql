CREATE TABLE IF NOT EXISTS admin_sessions (
  session_hash TEXT PRIMARY KEY NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions(expires_at);
