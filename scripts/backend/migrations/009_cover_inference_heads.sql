-- Cover-content runs remain append-only in catalog_inferences. A forced run gets
-- a new ID; this pointer selects the current result for one exact input.
-- Edition IDs intentionally do not reference books: publisher-only editions
-- have stable IDs of their own and need the same cache/history behavior.
CREATE TABLE cover_content_inference_heads (
  edition_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  inference_id TEXT NOT NULL UNIQUE REFERENCES catalog_inferences(id),
  promoted_at TEXT NOT NULL,
  PRIMARY KEY (edition_id, input_hash)
);

-- Preserve the full returned Jev payload, including probabilities and usage.
-- Token usage also stays on catalog_inferences for existing aggregate reports.
CREATE TABLE cover_content_inference_responses (
  inference_id TEXT PRIMARY KEY REFERENCES catalog_inferences(id),
  response_json TEXT NOT NULL
);

-- Legacy deterministic inference rows and book_content_assessments are not
-- rewritten. The cache loader can read either when no explicit head exists.
