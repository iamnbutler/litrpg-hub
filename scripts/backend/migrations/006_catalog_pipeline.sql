-- The old books table retains edition IDs used by existing links and reading history.
-- Canonical works and series are independent of any retailer.
CREATE TABLE catalog_series (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  genres_json TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  metadata_json TEXT,
  status TEXT NOT NULL DEFAULT 'ongoing' CHECK(status IN ('ongoing','complete','unknown')),
  priority INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE catalog_works (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES catalog_series(id),
  number REAL NOT NULL CHECK(number > 0),
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_description TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL,
  cover_url TEXT,
  publication_status TEXT NOT NULL DEFAULT 'unknown' CHECK(publication_status IN ('released','announced','unknown')),
  first_release_date TEXT,
  metadata_json TEXT,
  assessment_json TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(series_id, number)
);
CREATE TABLE catalog_editions (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES catalog_works(id),
  legacy_book_id TEXT UNIQUE REFERENCES books(id),
  format TEXT NOT NULL CHECK(format IN ('ebook','print','audiobook','dramatized')),
  title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_name TEXT NOT NULL,
  release_date TEXT,
  cover_url TEXT,
  narrator TEXT,
  runtime_minutes INTEGER,
  identifiers_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE INDEX catalog_editions_work ON catalog_editions(work_id);
CREATE TABLE catalog_documents (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  body TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(url,content_hash)
);
CREATE TABLE catalog_urls (
  url TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES catalog_documents(id),
  etag TEXT,
  last_modified TEXT,
  checked_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL
);
CREATE TABLE catalog_candidates (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES catalog_documents(id),
  status TEXT NOT NULL DEFAULT 'discovered' CHECK(status IN ('discovered','selected','review')),
  discovered_at TEXT NOT NULL
);
CREATE TABLE catalog_claims (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value_json TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES catalog_documents(id),
  method TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX catalog_claims_entity ON catalog_claims(entity_type,entity_id,field);
CREATE TABLE catalog_inferences (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  actual_model TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
);
CREATE TABLE catalog_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','retry','completed','failed','review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  last_error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind,entity_id,input_hash)
);
CREATE INDEX catalog_jobs_ready ON catalog_jobs(status,available_at,priority);
-- Public comments can be attached later, without conflating reader opinion with publisher facts.
CREATE TABLE catalog_reader_evidence (
  id TEXT PRIMARY KEY,
  series_id TEXT REFERENCES catalog_series(id),
  work_id TEXT REFERENCES catalog_works(id),
  source_url TEXT NOT NULL,
  external_id TEXT NOT NULL,
  body TEXT NOT NULL,
  contains_spoilers INTEGER NOT NULL DEFAULT 1,
  observed_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE(source_url,external_id)
);
