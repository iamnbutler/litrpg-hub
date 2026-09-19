-- Durable author content profiles.
-- A profile is an aggregate over several distinct works by one author. It is never a guess
-- from an author's name, and it can only ever record a `present` default: broad negative
-- claims are not derived from sparse samples, so absence of evidence stays `unknown`.
CREATE TABLE IF NOT EXISTS catalog_authors (
  id TEXT PRIMARY KEY,                 -- normalized primary author credit
  name TEXT NOT NULL,                  -- most complete observed credit, for display and notes
  aliases_json TEXT NOT NULL DEFAULT '[]',
  works_seen INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
-- Append-only: a new evidence set produces a new row, and the newest row for an
-- (author, field) pair is the current profile. Superseded rows are retained as an audit trail.
CREATE TABLE IF NOT EXISTS catalog_author_profiles (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES catalog_authors(id),
  field TEXT NOT NULL CHECK(field IN ('sexualized','explicit','harem')),
  verdict TEXT NOT NULL CHECK(verdict IN ('present','unknown')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  signal_source TEXT NOT NULL CHECK(signal_source IN ('publisher','jev','vision')),
  note TEXT NOT NULL,
  sample_size INTEGER NOT NULL CHECK(sample_size >= 0),
  positive_count INTEGER NOT NULL CHECK(positive_count >= 0),
  evidence_json TEXT NOT NULL,         -- sampled source IDs, coverage, reasons, raw model choice
  input_hash TEXT NOT NULL,            -- deterministic over evidence + rubric + model
  requested_model TEXT NOT NULL,
  model TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  UNIQUE(author_id, field, input_hash)
);
CREATE INDEX IF NOT EXISTS catalog_author_profiles_current ON catalog_author_profiles(author_id, field, evaluated_at);
