-- Derived, versioned quality snapshots. Source evidence and paid model receipts remain
-- in their existing append-only stores; these rows never replace catalog facts.
CREATE TABLE quality_index_runs (
  id TEXT PRIMARY KEY,
  policy_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  report_json TEXT NOT NULL
);
CREATE TABLE quality_index_scores (
  run_id TEXT NOT NULL REFERENCES quality_index_runs(id),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('book','series','author')),
  entity_id TEXT NOT NULL,
  craft_score REAL,
  index_score REAL,
  confidence REAL NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY(run_id,entity_type,entity_id)
);
CREATE INDEX quality_index_entity ON quality_index_scores(entity_type,entity_id);
