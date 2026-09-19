import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_TAXONOMY_VERSION, type CatalogBook } from '../../../src/lib/catalog.js';
import { classifyContent } from '../classifiers/content.js';
import { enrichCatalogSeries } from '../exporters/series.js';
import { reviewedMetadata, validateEditorialReviews, type EditorialReview } from './editorial.js';
import { extractionHash, extractionInput, saveInference } from './inference.js';
import { importWork } from './import.js';
import { seeds } from './pipeline.js';
import { hash } from './queue.js';
import type { Document, WorkRow } from './types.js';

const seed = seeds.find(s => s.id === 'dungeon-crawler-carl')!;
const stamp = '2026-09-19T04:00:00.000Z';
const source: Document = { id: 'editorial-source', url: 'https://soundbooththeater.com/shop/audiobooks/example/', content_hash: 'test', body: 'retained evidence', fetched_at: stamp };
const sourceDescription = 'A man and his cat enter a deadly dungeon after the destruction of their city. The two companions must overcome a series of challenges.';
const original = { synopsis: 'Two companions enter a dungeon after their city is destroyed. Their next task is to cooperate on the challenges they encounter.', features: [{ tag: 'dungeon', evidence: 'enter a deadly dungeon' }, { tag: 'team-adventure', evidence: 'The two companions must overcome' }] };
const correction = 'A man and his cat enter a dungeon after their city is destroyed. They must cooperate to overcome its challenges.';
let db: Database.Database, work: WorkRow, input: ReturnType<typeof extractionInput>, receiptHash: string, review: EditorialReview;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  for (const name of ['001_initial.sql', '006_catalog_pipeline.sql']) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id, seed.title, seed.author, stamp);
  db.prepare('INSERT INTO catalog_documents VALUES(?,?,?,?,?)').run(source.id, source.url, source.content_hash, source.body, source.fetched_at);
  const workId = importWork(db, seed, { title: seed.title, author: seed.author, series: seed.title, number: 1, description: sourceDescription,
    format: 'audiobook', releaseDate: '2024-01-01', audioReleaseDate: '2024-01-01', narrator: 'A Narrator', audioRuntimeMinutes: 720,
    coverUrl: null, publicationStatus: 'released', links: [] }, source);
  work = db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
  input = extractionInput(work);
  receiptHash = extractionHash(input);
  saveInference(db, 'work', work.id, 'extract', receiptHash, 'old-model', 'old-model', 'old-rubric', original, {});
  db.prepare('UPDATE catalog_works SET description=?,metadata_json=? WHERE id=?').run(original.synopsis, JSON.stringify({ ...original, inputHash: receiptHash }), work.id);
  review = { entityType: 'work', entityId: work.id, inputHash: receiptHash, evidenceHash: hash(input), taxonomyVersion: FEATURE_TAXONOMY_VERSION,
    reviewedAt: stamp, sourceUrl: source.url, allowedFeatures: ['dungeon'], reviewNote: 'Only the reviewed source-supported feature is approved.' };
});
afterEach(() => db.close());

describe('evidence-bound editorial decisions', () => {
  it('freezes the approved receipt across a model rerun, including prose with no manual correction', () => {
    saveInference(db, 'work', work.id, 'extract', hash('new-model-input'), 'new-model', 'new-model', 'new-rubric', { synopsis: correction, features: [] }, {});
    db.prepare('UPDATE catalog_works SET description=?,metadata_json=? WHERE id=?').run('An unreviewed replacement.', JSON.stringify({ inputHash: hash('new-model-input') }), work.id);
    expect(reviewedMetadata(db, 'work', work.id, input, source.url, [review])).toEqual({ synopsis: original.synopsis, features: ['dungeon'], evidence: { sourceUrl: source.url, reviewedAt: stamp, taxonomyVersion: FEATURE_TAXONOMY_VERSION } });
  });

  it('gives an explicit correction priority without overwriting the paid observation', () => {
    expect(reviewedMetadata(db, 'work', work.id, input, source.url, [{ ...review, correctedSynopsis: correction }])?.synopsis).toBe(correction);
    const retained = db.prepare("SELECT result_json FROM catalog_inferences WHERE kind='extract'").get() as { result_json: string };
    expect(JSON.parse(retained.result_json).synopsis).toBe(original.synopsis);
  });

  it.each(['description', 'title', 'author'] as const)('invalidates a review when the source %s changes', field => {
    expect(reviewedMetadata(db, 'work', work.id, { ...input, [field]: `${input[field]} Changed.` }, source.url, [review])).toBeNull();
  });

  it('does not transfer a review to another identity, citation or taxonomy', () => {
    expect(reviewedMetadata(db, 'work', 'another-work', input, source.url, [review])).toBeNull();
    expect(reviewedMetadata(db, 'series', work.id, input, source.url, [review])).toBeNull();
    expect(reviewedMetadata(db, 'work', work.id, input, 'https://aethonbooks.com/book/example/', [review])).toBeNull();
    expect(reviewedMetadata(db, 'work', work.id, input, source.url, [{ ...review, taxonomyVersion: 'old-taxonomy' }])).toBeNull();
  });

  it('requires the reviewed receipt and prevents an allowed tag without its supporting evidence', () => {
    expect(reviewedMetadata(db, 'work', work.id, input, source.url, [{ ...review, inputHash: hash('missing') }])).toBeNull();
    expect(() => reviewedMetadata(db, 'work', work.id, input, source.url, [{ ...review, allowedFeatures: ['solo-protagonist'] }])).toThrow(/source-supported receipt/);
  });

  it('orders decisions by actual time and rejects conflicting decisions at the same instant', () => {
    const later = { ...review, reviewedAt: '2026-09-19T00:30:00-04:00', allowedFeatures: [] };
    expect(reviewedMetadata(db, 'work', work.id, input, source.url, [review, later])?.features).toEqual([]);
    expect(validateEditorialReviews([later])[0].reviewedAt).toBe('2026-09-19T04:30:00.000Z');
    expect(() => validateEditorialReviews([review, { ...review, reviewedAt: '2026-09-19T00:00:00-04:00', allowedFeatures: [] }])).toThrow(/Duplicate/);
  });

  it('binds all contributing source URLs, even when moving a footer leaves its text unchanged', () => {
    const footer = 'https://aethonbooks.com/book/example-7/';
    const combined = { ...review, additionalSourceUrls: [footer] };
    const read = (urls: string[]) => reviewedMetadata(db, 'work', work.id, input, source.url, [combined], urls);
    expect(read([footer])?.evidence.additionalSourceUrls).toEqual([footer]);
    expect(read([])).toBeNull();
    expect(read(['https://aethonbooks.com/book/example-8/'])).toBeNull();
    expect(read([footer, 'https://aethonbooks.com/book/example-9/'])).toBeNull();
  });

  it('rejects accidental private fields, credential URLs, unknown tags and duplicate decisions', () => {
    expect(validateEditorialReviews([review])).toEqual([review]);
    for (const invalid of [{ ...review, rawSource: sourceDescription }, { ...review, sourceUrl: 'https://user:password@example.com/' }, { ...review, allowedFeatures: ['invented'] }]) {
      expect(() => validateEditorialReviews([invalid])).toThrow();
    }
    expect(() => validateEditorialReviews([review, review])).toThrow(/Duplicate/);
  });

  it('exports reviewed features and corrected prose, retaining unreviewed candidates only in private evidence', () => {
    const before: CatalogBook[] = [];
    enrichCatalogSeries(db, before, { editorialReviews: [] });
    expect(before).toHaveLength(1);
    expect(before[0].description).toBe(original.synopsis);
    expect(before[0].features).toBeUndefined();
    expect(before[0].featureEvidence).toBeUndefined();
    const after: CatalogBook[] = [];
    enrichCatalogSeries(db, after, { editorialReviews: [{ ...review, correctedSynopsis: correction }] });
    expect(after[0]).toMatchObject({ description: correction, features: ['dungeon'], featureEvidence: { sourceUrl: source.url, reviewedAt: stamp } });
    expect(JSON.stringify(after[0])).not.toContain('enter a deadly dungeon');
    expect(after[0].content).toEqual(classifyContent({ title: seed.title, subtitle: '', description: sourceDescription, narrator: 'A Narrator' }));
  });
});
