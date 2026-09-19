-- Preserve tags inherited by the old importer for product stubs that no longer exist.
-- They are historical observations, not tags on a real current audiobook identity.
CREATE TABLE catalog_orphaned_tags (
  book_id TEXT NOT NULL,
  subgenre TEXT NOT NULL,
  confidence REAL,
  source TEXT,
  reason TEXT NOT NULL DEFAULT 'No matching book at catalog migration',
  quarantined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(book_id,subgenre)
);
INSERT INTO catalog_orphaned_tags(book_id,subgenre,confidence,source)
SELECT book_id,subgenre,confidence,source FROM book_subgenres
WHERE book_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM books WHERE books.id=book_subgenres.book_id);
DELETE FROM book_subgenres
WHERE book_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM books WHERE books.id=book_subgenres.book_id);
