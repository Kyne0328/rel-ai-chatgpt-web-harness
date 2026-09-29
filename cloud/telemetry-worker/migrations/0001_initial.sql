CREATE TABLE IF NOT EXISTS installations (
  installation_id TEXT PRIMARY KEY NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_version TEXT NOT NULL,
  current_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  architecture TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_installations_last_seen
  ON installations(last_seen_at);

CREATE INDEX IF NOT EXISTS idx_installations_first_seen
  ON installations(first_seen_at);

CREATE INDEX IF NOT EXISTS idx_installations_current_version
  ON installations(current_version);

CREATE INDEX IF NOT EXISTS idx_installations_platform
  ON installations(platform);

CREATE TABLE IF NOT EXISTS daily_metrics (
  day TEXT PRIMARY KEY NOT NULL,
  total_installations INTEGER NOT NULL,
  active_1d INTEGER NOT NULL,
  active_7d INTEGER NOT NULL,
  active_30d INTEGER NOT NULL,
  new_1d INTEGER NOT NULL
);
