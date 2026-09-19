import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importWork } from './import.js';
import type { Document, ExtractedBook, SeedSeries } from './types.js';

const seed: SeedSeries = {
  id: 'credit-review', title: 'Credit Review', author: 'Writer One, Writer Two',
  authorAliases: ['Writer One', 'Writer Two'], aliases: [], genres: ['litrpg'], priority: 1, sources: []
};
const book: ExtractedBook = {
  title: 'First Tale', series: seed.title, number: 1, author: seed.author,
  description: 'Two travelers discover a lost city beneath the forest. Together they search for its missing inhabitants and learn how to survive its dangerous passages.',
  format: 'audiobook', publicationStatus: 'released', releaseDate: '2025-03-01', audioReleaseDate: '2025-03-01',
  coverUrl: null, narrator: 'First Narrator', audioRuntimeMinutes: 600, links: []
};
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  for (const name of ['001_initial.sql', '006_catalog_pipeline.sql']) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)')
    .run(seed.id, seed.title, seed.author, '2026-09-19T00:00:00Z');
});
afterEach(() => db.close());

function source(id: string, url = 'https://podiumentertainment.com/titles/first-tale/'): Document {
  const doc = { id, url, content_hash: id, body: `Retained fixture ${id}`, fetched_at: '2026-09-19T00:00:00Z' };
  db.prepare('INSERT INTO catalog_documents VALUES(?,?,?,?,?)').run(doc.id, doc.url, doc.content_hash, doc.body, doc.fetched_at);
  return doc;
}

function legacy(id: string, author: string) {
  db.prepare('INSERT OR IGNORE INTO series(id,title,author) VALUES(?,?,?)').run('legacy', seed.title, seed.author);
  db.prepare('INSERT INTO books(id,title,author,series_id,series_number,release_date,narrator,runtime_minutes) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, book.title, author, 'legacy', 1, '2025-05-01', 'Retained Narrator', 700);
}

function projectedState() {
  return {
    works: db.prepare('SELECT * FROM catalog_works ORDER BY id').all(),
    editions: db.prepare('SELECT * FROM catalog_editions ORDER BY id').all(),
    books: db.prepare('SELECT * FROM books ORDER BY id').all(),
    genres: db.prepare('SELECT * FROM book_subgenres ORDER BY book_id,subgenre').all(),
    jobs: db.prepare("SELECT * FROM catalog_jobs WHERE kind!='review-author' ORDER BY id").all()
  };
}

describe('author-conflict quarantine', () => {
  it.each(['same-source', 'different-source', 'different-title'])('retains %s evidence without changing the work or its editions', kind => {
    const firstSource = source('first');
    legacy('B000000001', seed.author);
    const workId = importWork(db, seed, {
      ...book, links: [{ format: 'audiobook', asin: 'B000000001', url: 'https://www.audible.com/pd/B000000001' }]
    }, firstSource);
    db.prepare('UPDATE catalog_works SET description=?,metadata_json=?,assessment_json=? WHERE id=?')
      .run('Retained editorial synopsis.', '{"inputHash":"retained"}', '{"inputHash":"retained-assessment"}', workId);
    legacy('B000000002', 'Writer One');
    const before = projectedState();
    const disputedSource = source('disputed', kind === 'same-source' ? firstSource.url : 'https://aethonbooks.com/book/first-tale/');
    const disputed: ExtractedBook = {
      ...book, author: 'Writer One', title: kind === 'different-title' ? 'Another First Tale' : book.title,
      description: 'A later source offers a different account of the journey and credits only one of the two writers. '.repeat(4),
      coverUrl: 'https://podiumentertainment.com/different-cover.jpg', releaseDate: '2024-01-01', audioReleaseDate: '2024-01-01',
      narrator: 'Different Narrator', audioRuntimeMinutes: 900,
      links: [{ format: 'audiobook', asin: 'B000000002', url: 'https://www.audible.com/pd/B000000002' }]
    };

    expect(importWork(db, seed, disputed, disputedSource)).toBe(workId);
    expect(importWork(db, seed, disputed, disputedSource)).toBe(workId);
    expect(projectedState()).toEqual(before);
    expect(db.prepare('SELECT field FROM catalog_claims WHERE entity_id=? AND document_id=?').all(workId, disputedSource.id)).toHaveLength(11);
    expect(db.prepare("SELECT value_json FROM catalog_claims WHERE entity_id=? AND document_id=? AND field='author'")
      .get(workId, disputedSource.id)).toEqual({ value_json: JSON.stringify(disputed.author) });
    const reviews = db.prepare("SELECT status,payload_json FROM catalog_jobs WHERE kind='review-author'").all() as { status: string; payload_json: string }[];
    expect(reviews).toHaveLength(1);
    expect(reviews[0].status).toBe('review');
    expect(JSON.parse(reviews[0].payload_json)).toEqual({
      seriesId: seed.id, sourceUrl: disputedSource.url, previousAuthor: book.author, observedAuthor: disputed.author
    });
  });

  it.each(['pen-name-expansion', 'credit-order'])('still applies a corroborating refresh with only a %s change', kind => {
    const selected = kind === 'pen-name-expansion'
      ? { ...seed, author: 'Writer One', authorAliases: ['Writer One', 'Pen One'] }
      : seed;
    const firstSource = source('first');
    const workId = importWork(db, selected, { ...book, author: selected.author }, firstSource);
    const nextSource = source('corroborating', 'https://aethonbooks.com/book/first-tale/');
    const next = {
      ...book, author: kind === 'pen-name-expansion' ? 'Pen One, Writer One' : 'Writer Two, Writer One',
      description: 'The travelers find new clues beneath the city and discover why its inhabitants vanished. '.repeat(4)
    };

    importWork(db, selected, next, nextSource);
    expect(db.prepare('SELECT author,source_description,source_url FROM catalog_works WHERE id=?').get(workId)).toEqual({
      author: selected.author, source_description: next.description, source_url: nextSource.url
    });
    expect(db.prepare("SELECT id FROM catalog_jobs WHERE kind='review-author'").all()).toHaveLength(0);
  });
});
