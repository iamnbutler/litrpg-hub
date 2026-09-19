-- Self-attested age, stored only to decide whether sexual-content filters can be unlocked.
-- GitHub exposes no date of birth, so this is the reader's own claim and nothing else.
-- The date is kept (rather than just a derived flag) so a reader who confirms while under
-- 18 gains the option on their birthday without being asked to enter it again.
ALTER TABLE users ADD COLUMN birth_date TEXT;
ALTER TABLE users ADD COLUMN birth_attested_at TEXT;
ALTER TABLE users ADD COLUMN allow_adult INTEGER NOT NULL DEFAULT 0;
