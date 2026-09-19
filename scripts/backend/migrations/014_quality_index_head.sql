-- An unchanged report reuses its immutable snapshot, including on A -> B -> A.
-- Currentness therefore needs its own pointer, not MAX(snapshot.generated_at).
CREATE TABLE quality_index_head (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  run_id TEXT NOT NULL REFERENCES quality_index_runs(id),
  generated_at TEXT NOT NULL
);
INSERT INTO quality_index_head(singleton,run_id,generated_at)
  SELECT 1,id,generated_at FROM quality_index_runs
  ORDER BY julianday(generated_at) DESC,id DESC LIMIT 1;
