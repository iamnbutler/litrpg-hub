-- Rebuild catalog_reader_traits with columns that mean what they are named.
--
-- 008 stored `agreement` (the model's probability mass on its own chosen answer) and `dissent`
-- (a 0/1 flag). Both read like reader statistics — "how many readers agreed", "how many
-- dissented" — and neither is one. Nothing classifies each commenter individually, so no
-- supporting/dissenting reader count can be derived, and a column that invites one will
-- eventually be exported as a percentage.
--
-- Replaced by `model_confidence`, which is plainly the model's own certainty, and `consensus`,
-- a qualitative judgement over the sampled comments. `voices` remains the only count, and it
-- counts sampled voices, not agreeing ones.
--
-- The feature has never emitted a row (the gate has refused every corpus so far), so this
-- rebuild drops nothing.
DROP TABLE IF EXISTS catalog_reader_traits;
CREATE TABLE catalog_reader_traits (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('series','work')),
  entity_id TEXT NOT NULL,
  trait TEXT NOT NULL,
  value TEXT NOT NULL CHECK(value IN ('present','absent','unknown')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  model_confidence REAL NOT NULL CHECK(model_confidence >= 0 AND model_confidence <= 1),
  consensus TEXT NOT NULL CHECK(consensus IN ('consistent','mixed','insufficient')),
  summary TEXT NOT NULL,
  voices INTEGER NOT NULL CHECK(voices >= 0),
  samples INTEGER NOT NULL CHECK(samples >= 0),
  evidence_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  model TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, trait, input_hash)
);
CREATE INDEX IF NOT EXISTS catalog_reader_traits_current ON catalog_reader_traits(entity_type, entity_id, evaluated_at);
