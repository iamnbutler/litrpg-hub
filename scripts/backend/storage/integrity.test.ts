import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupCatalog } from './backup.js';

let db: Database.Database;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'catalog-integrity-'));
  db = new Database(':memory:');
  db.exec(readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO books(id,title,author,release_date) VALUES(?,?,?,?)').run('real', 'Real book', 'Writer', '2025-01-01');
  db.prepare('INSERT INTO book_subgenres VALUES(?,?,?,?)').run('real', 'litrpg', 1, 'curated');
  // Reproduce legacy imports made with SQLite foreign-key enforcement disabled.
  db.pragma('foreign_keys = OFF');
  db.prepare('INSERT INTO book_subgenres VALUES(?,?,?,?)').run('missing', 'litrpg', .7, 'series-inheritance');
});
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
describe('catalog restore integrity', () => {
  it('retains orphaned observations in quarantine and keeps valid tags intact', () => {
    db.exec(readFileSync(new URL('../migrations/011_quarantine_orphaned_tags.sql', import.meta.url), 'utf8'));
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare('SELECT book_id,source FROM book_subgenres').all()).toEqual([{ book_id: 'real', source: 'curated' }]);
    expect(db.prepare('SELECT book_id,confidence,source FROM catalog_orphaned_tags').all()).toEqual([{ book_id: 'missing', confidence: .7, source: 'series-inheritance' }]);
  });
  it('refuses to label a structurally broken snapshot verified', async () => {
    await expect(backupCatalog(db, directory, join(directory, 'no-assets'))).rejects.toThrow('broken references');
  });
});
