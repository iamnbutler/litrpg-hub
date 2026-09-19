-- Private, append-only paid response history. The exact wire text is retained
-- even when it is invalid JSON, refused, incomplete, or fails our current rubric.
-- A missing/invalid usage payload stays unknown; it is never invented as zero.
CREATE TABLE cover_vision_attempts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  cache_key TEXT NOT NULL,
  image_hash TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  model TEXT,
  response_text TEXT,
  legacy_observation_json TEXT,
  usage_json TEXT,
  evaluated_at TEXT NOT NULL,
  UNIQUE(cache_key, id),
  CHECK ((response_text IS NOT NULL AND legacy_observation_json IS NULL)
    OR (response_text IS NULL AND legacy_observation_json IS NOT NULL AND model IS NOT NULL))
);
CREATE INDEX cover_vision_attempts_cache ON cover_vision_attempts(cache_key, sequence DESC);

-- cover_observations remains the unchanged materialized valid head for existing
-- exporters. Its replacement and this pointer move in the same transaction.
CREATE TABLE cover_vision_heads (
  cache_key TEXT PRIMARY KEY REFERENCES cover_observations(cache_key),
  attempt_id TEXT NOT NULL UNIQUE,
  promoted_at TEXT NOT NULL,
  FOREIGN KEY(cache_key, attempt_id) REFERENCES cover_vision_attempts(cache_key, id)
);

-- A URL can serve different bytes while its latest response needs review. Keep
-- image freshness independently of whether those bytes have a valid assessment.
CREATE TABLE cover_image_sources (
  cover_url TEXT PRIMARY KEY,
  image_hash TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

-- Existing rows contain observations and usage, but not the original response.
-- Preserve that distinction instead of manufacturing a provider response.
INSERT INTO cover_vision_attempts
  (id,cache_key,image_hash,requested_model,rubric_version,model,legacy_observation_json,usage_json,evaluated_at)
SELECT 'legacy:' || cache_key,cache_key,image_hash,requested_model,rubric_version,model,observation_json,usage_json,evaluated_at
FROM cover_observations;
INSERT INTO cover_vision_heads (cache_key,attempt_id,promoted_at)
SELECT cache_key,'legacy:' || cache_key,evaluated_at FROM cover_observations;
INSERT INTO cover_image_sources (cover_url,image_hash,checked_at)
SELECT s.cover_url,o.image_hash,s.checked_at FROM cover_sources s
JOIN cover_observations o ON o.cache_key=s.cache_key;

CREATE TRIGGER cover_vision_attempts_no_update BEFORE UPDATE ON cover_vision_attempts
BEGIN SELECT RAISE(ABORT, 'Cover vision response history is immutable.'); END;
CREATE TRIGGER cover_vision_attempts_no_delete BEFORE DELETE ON cover_vision_attempts
BEGIN SELECT RAISE(ABORT, 'Cover vision response history is immutable.'); END;
