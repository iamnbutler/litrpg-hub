import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seriesIdentity, type CatalogBook } from '../../../src/lib/catalog.js';
import { classifyContent } from '../classifiers/content.js';
import { seeds } from '../catalog/pipeline.js';
import type { SeedSeries } from '../catalog/types.js';
import { enrichCatalogSeries } from './series.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  for (const name of ['001_initial.sql', '006_catalog_pipeline.sql']) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
});
afterEach(() => db.close());

function register(seed: SeedSeries, credits: string[]) {
  const aliases = ['retained-follow-key', ...seed.aliases, ...seed.authorAliases.map(author => seriesIdentity(seed.title, author))];
  db.prepare('INSERT INTO catalog_series(id,title,author,aliases_json,updated_at) VALUES(?,?,?,?,?)')
    .run(seed.id, seed.title, seed.author, JSON.stringify(aliases), '2026-09-19T00:00:00Z');
  for (const [index, author] of credits.entries()) {
    const number = index + 1;
    db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(`work-${seed.id}-${number}`, seed.id, number, `${seed.title} ${number}`, author,
        `https://podiumentertainment.com/titles/fixture-${number}/`, '2026-09-19T00:00:00Z');
  }
  return aliases;
}

function legacyBook(seed: SeedSeries, id: string, author: string, number: number): CatalogBook {
  return {
    id, title: `${seed.title} ${number}`, subtitle: '', author, series: seed.title,
    seriesKey: seriesIdentity(seed.title, author), seriesNumber: number, narrator: null,
    releaseDate: '2025-01-01', coverUrl: null, runtimeMinutes: null, description: '', url: null,
    rating: null, ratingCount: 0, subgenres: [], edition: 'audiobook', scope: 'indexed',
    content: classifyContent({ title: seed.title, subtitle: '', description: '', narrator: null }),
    assessment: null, sources: [], issues: []
  };
}

describe('legacy series export author identity', () => {
  it.each(['unmapped-coauthor', 'missing-coauthor', 'different-roster-member'])('keeps a %s book separate without dropping its saved ID', kind => {
    const seed = seeds.find(s => s.id === 'rune-seeker')!;
    const aliases = register(seed, [seed.author, seed.authorAliases[0]]);
    const author = kind === 'unmapped-coauthor' ? `${seed.authorAliases[0]}, Unrelated Writer`
      : kind === 'missing-coauthor' ? seed.authorAliases[0] : seed.authorAliases[1];
    const rejected = legacyBook(seed, 'B000000001', author, kind === 'different-roster-member' ? 2 : 1);
    const originalKey = rejected.seriesKey;
    const accepted = legacyBook(seed, 'B000000002', [...seed.authorAliases].reverse().join(', '), 1);
    const books = [rejected, accepted];

    const catalog = enrichCatalogSeries(db, books, { editorialReviews: [] });
    expect(books.map(book => book.id)).toEqual(['B000000001', 'B000000002']);
    expect(rejected.seriesKey).toBe(originalKey);
    expect(rejected.workId).toBeUndefined();
    expect(accepted.seriesKey).toBe(seed.id);
    const canonical = catalog.find(series => series.id === seed.id)!;
    expect(canonical.aliases).toEqual(aliases);
    expect(canonical.works.flatMap(work => work.editionIds)).toEqual([accepted.id]);
    const separate = catalog.find(series => series.id === originalKey)!;
    expect(separate.works.flatMap(work => work.editionIds)).toEqual([rejected.id]);
    expect(separate.curated).toBe(false);
  });

  it('allows mapped credits for a volume whose canonical work has not yet been discovered', () => {
    const seed = seeds.find(s => s.id === 'rune-seeker')!;
    register(seed, [seed.author]);
    const book = legacyBook(seed, 'B000000003', seed.authorAliases[1], 3);

    const catalog = enrichCatalogSeries(db, [book], { editorialReviews: [] });
    expect(book.seriesKey).toBe(seed.id);
    expect(catalog[0].works[0]).toMatchObject({ number: 3, editionIds: [book.id], verified: false });
  });

  it('accepts repeated legal and pen-name credits for the same canonical author', () => {
    const seed = seeds.find(s => s.id === 'the-perfect-run')!;
    const aliases = register(seed, [seed.author]);
    const book = legacyBook(seed, 'B000000004', 'Void Herald, Maxime J. Durand', 1);

    const catalog = enrichCatalogSeries(db, [book], { editorialReviews: [] });
    expect(book.seriesKey).toBe(seed.id);
    expect(catalog[0].aliases).toEqual(aliases);
    expect(catalog[0].works[0].editionIds).toEqual([book.id]);
  });
});
