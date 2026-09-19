CREATE TABLE IF NOT EXISTS book_assessments (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  assessment_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assessments_hash ON book_assessments(input_hash);
