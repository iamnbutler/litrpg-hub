-- Reader evidence is opinion, kept strictly separate from publisher facts.
-- 006 created catalog_reader_evidence with body/source/series/work/spoiler/removed_at.
-- These columns add provenance, an independence key, and the structured rating, so an
-- aggregate can say how many DISTINCT people said something and which cached document
-- it came from. Commenter names are never stored: author_key is a one-way digest, which
-- is enough to count independent voices and nothing else.
ALTER TABLE catalog_reader_evidence ADD COLUMN document_id TEXT REFERENCES catalog_documents(id);
ALTER TABLE catalog_reader_evidence ADD COLUMN source_name TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_reader_evidence ADD COLUMN author_key TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_reader_evidence ADD COLUMN rating REAL;
ALTER TABLE catalog_reader_evidence ADD COLUMN rating_best REAL;
ALTER TABLE catalog_reader_evidence ADD COLUMN published_at TEXT;
ALTER TABLE catalog_reader_evidence ADD COLUMN kind TEXT NOT NULL DEFAULT 'review';
CREATE INDEX IF NOT EXISTS catalog_reader_evidence_entity ON catalog_reader_evidence(series_id, work_id);
CREATE INDEX IF NOT EXISTS catalog_reader_evidence_voice ON catalog_reader_evidence(author_key);

-- An aggregate trait, never a verdict copied from one comment. `summary` is original
-- context written for the catalog; raw review bodies stay in catalog_reader_evidence and
-- are never exported. A trait records how many independent voices it rests on and how much
-- they agreed, so non-consensus stays visible instead of collapsing into a single claim.
CREATE TABLE IF NOT EXISTS catalog_reader_traits (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('series','work')),
  entity_id TEXT NOT NULL,
  trait TEXT NOT NULL,
  value TEXT NOT NULL CHECK(value IN ('present','absent','unknown')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  summary TEXT NOT NULL,
  voices INTEGER NOT NULL CHECK(voices >= 0),
  samples INTEGER NOT NULL CHECK(samples >= 0),
  agreement REAL NOT NULL CHECK(agreement >= 0 AND agreement <= 1),
  dissent INTEGER NOT NULL DEFAULT 0 CHECK(dissent >= 0),
  evidence_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  model TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, trait, input_hash)
);
CREATE INDEX IF NOT EXISTS catalog_reader_traits_current ON catalog_reader_traits(entity_type, entity_id, evaluated_at);
