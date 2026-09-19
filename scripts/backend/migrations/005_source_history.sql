-- The current source row is a pointer; distinct observed payloads remain replayable.
CREATE TABLE IF NOT EXISTS source_snapshots (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_id TEXT,
  content_hash TEXT NOT NULL,
  raw_data TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (book_id, source, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_source_snapshots_identity ON source_snapshots(source,source_id);
