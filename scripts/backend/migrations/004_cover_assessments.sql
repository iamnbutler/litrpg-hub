CREATE TABLE IF NOT EXISTS cover_observations (
  cache_key TEXT PRIMARY KEY,
  image_hash TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  model TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  observation_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cover_sources (
  cover_url TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL REFERENCES cover_observations(cache_key),
  checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_content_assessments (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  assessment_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
);
