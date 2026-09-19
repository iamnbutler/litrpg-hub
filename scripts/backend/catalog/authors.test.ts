import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAuthorProfile, authorProfileHash, authorState, collectAuthorEvidence, confidenceCeiling,
  creditedIdentities, loadAuthorProfiles, planAuthorJobs, processAuthorProfile, summarizeAuthor
} from './authors.js';
import { applyAuthorRules } from '../classifiers/authors.js';
import { classifyContent } from '../classifiers/content.js';
import { COVER_RUBRIC_VERSION, coverCacheKey, coverModel, toCoverAssessment } from '../covers/vision.js';
import { contentAssessmentHash, type ContentAssessment } from '../covers/content.js';
import { buildCatalog } from '../exporters/catalog.js';
import { hash } from './queue.js';
import { defaultFilters, passesFilters, seriesIdentity, type CatalogBook, type ContentSignal } from '../../../src/lib/catalog.js';
import type { JevResponse } from '../jev/client.js';

const MIGRATIONS = ['001_initial.sql','002_cursor_results_found.sql','003_jev_assessments.sql','004_cover_assessments.sql','005_source_history.sql','006_catalog_pipeline.sql','007_author_profiles.sql'];
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  for (const name of MIGRATIONS) db.exec(readFileSync(join(import.meta.dirname, '../migrations', name), 'utf8'));
});
afterEach(() => db.close());

const NEUTRAL = 'A long-running dungeon crawl with levels, crafting and a loyal party exploring a ruined kingdom.';
const HAREM = 'A harem LitRPG with a growing party of companions. The hero levels up and clears dungeons.';
const NO_HAREM = 'No harem. A solo dungeon crawl with levels, crafting and one loyal companion.';

function addCover(url: string, level: string, confidence: number) {
  const imageHash = `hash-${url}`, key = coverCacheKey(imageHash);
  const observation = { level, confidence, observations: ['Cleavage-focused fantasy pin-up composition.'] };
  db.prepare('INSERT OR IGNORE INTO cover_observations VALUES (?,?,?,?,?,?,?,?)').run(key, imageHash, coverModel(), 'gpt-4.1-mini-test',
    COVER_RUBRIC_VERSION, JSON.stringify(observation), '{}', '2026-09-01T00:00:00.000Z');
  db.prepare('INSERT OR IGNORE INTO cover_sources VALUES (?,?,?)').run(url, key, '2026-09-01T00:00:00.000Z');
  return toCoverAssessment(observation as never, { model: 'gpt-4.1-mini-test', evaluatedAt: '2026-09-01T00:00:00.000Z', imageHash, coverUrl: url });
}
/** Store a cover-content verdict the way the cover pipeline now does: an immutable edition inference. */
function addCoverContent(bookId: string, input: { title: string; subtitle: string; series: string; author: string; description: string },
  cover: ReturnType<typeof addCover>, verdicts: Partial<Record<'sexualized' | 'explicit' | 'harem', 'present' | 'absent' | 'unknown'>>) {
  const inputHash = contentAssessmentHash(input, cover);
  const signal = (v: 'present' | 'absent' | 'unknown'): ContentSignal => ({ verdict: v, confidence: 0.9, source: 'jev', note: 'Jev assessed the listing and cover observations.' });
  const assessment: ContentAssessment = { inputHash, model: 'jev-test', evaluatedAt: '2026-09-02T00:00:00.000Z',
    sexualized: signal(verdicts.sexualized ?? 'unknown'), explicit: signal(verdicts.explicit ?? 'unknown'), harem: signal(verdicts.harem ?? 'unknown') };
  db.prepare('INSERT OR IGNORE INTO catalog_inferences VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    hash(['edition', bookId, 'cover-content', inputHash]), 'edition', bookId, 'cover-content', inputHash,
    'jev-latest', 'jev-test', 'cover-content-v1', JSON.stringify(assessment), '{}', '2026-09-02T00:00:00.000Z');
}
function addBook(o: { id: string; author: string; title?: string; subtitle?: string; series?: string; number?: number; description?: string; cover?: string }) {
  const seriesId = o.series ? seriesIdentity(o.series, o.author) : null;
  if (o.series) db.prepare('INSERT OR IGNORE INTO series(id,title,author) VALUES(?,?,?)').run(seriesId, o.series, o.author);
  db.prepare(`INSERT INTO books(id,title,subtitle,series_id,series_number,author,narrator,release_date,cover_url,runtime_minutes,description,url,rating,rating_count)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(o.id, o.title ?? `Title ${o.id}`, o.subtitle ?? null, seriesId, o.number ?? null, o.author,
    'A Narrator', '2026-01-01', o.cover ?? null, 600, o.description ?? NEUTRAL, null, 4.5, 100);
}
const slug = (value: string, n: number) => value.replace(/\W/g, '').toUpperCase().slice(0, n).padEnd(n, 'X');
const bookId = (author: string, series: string, i: number) => `${slug(author, 4)}${slug(series, 4)}${i}`.padEnd(10, '0');
/** A series of `count` distinct works by one author. */
function addSeries(author: string, series: string, count: number, description = NEUTRAL, cover?: (i: number) => string | undefined) {
  for (let i = 1; i <= count; i++) {
    const url = cover?.(i);
    if (url) addCover(url, 'sexualized', 0.9);
    addBook({ id: bookId(author, series, i), author, series, number: i, title: `${series} ${i}`, description, cover: url });
  }
}
/** A body of work spread across two series, so evidence is never confined to a single one. */
function addCatalog(author: string, count: number, description = NEUTRAL, cover?: (i: number) => string | undefined) {
  const half = Math.ceil(count / 2);
  addSeries(author, 'Bound Company', half, description, cover);
  addSeries(author, 'Second Cycle', count - half, description, cover ? i => cover(i + half) : undefined);
}
const makeBook = (fields: Partial<CatalogBook> = {}): CatalogBook => ({
  id: 'NEW0000001', title: 'An unassessed title', subtitle: '', author: 'Ana Author', narrator: null,
  series: 'Later Books', seriesKey: 'laterbooks--anaauthor', seriesNumber: 1, releaseDate: '2027-01-01',
  coverUrl: null, runtimeMinutes: null, subgenres: ['litrpg'], description: NEUTRAL, url: null, rating: null,
  ratingCount: 0, edition: 'audiobook', scope: 'indexed', sources: [], issues: [], assessment: null,
  content: classifyContent({ title: 'An unassessed title', subtitle: '', description: NEUTRAL, narrator: null }), ...fields
});
const jevAnswer = (choice: string, confidence: number) => ({ type: 'choice' as const, choice, confidence,
  probabilities: { present: choice === 'present' ? 1 : 0, absent: choice === 'absent' ? 1 : 0, unknown: choice === 'unknown' ? 1 : 0 } });
const PRESENT_HAREM: Record<string, [string, number]> = { sexualized: ['unknown', 0.2], explicit: ['unknown', 0.2], harem: ['present', 0.95] };
const PRESENT_SEX: Record<string, [string, number]> = { sexualized: ['present', 0.95], explicit: ['unknown', 0.2], harem: ['unknown', 0.2] };
const jevStub = (choices: Record<string, [string, number]>): JevResponse => ({
  model: 'jev-test', usage: { input_tokens: 120, output_tokens: 30 },
  answers: Object.fromEntries(Object.entries(choices).map(([k, [c, n]]) => [k, jevAnswer(c, n)]))
});

/** A reviewed profile, the only kind that is ever persisted or applied. */
const reviewed = (authorId: string, choices = PRESENT_HAREM) =>
  processAuthorProfile(db, authorId, { evaluate: (async () => jevStub(choices)) as never });

describe('author evidence thresholds', () => {
  it('does not build a profile from one or two books, or from a mixed sample', () => {
    addSeries('Sparse Writer', 'Two Books', 2, HAREM);
    addCatalog('Mixed Writer', 3, HAREM);
    db.prepare('UPDATE books SET description=? WHERE id IN (SELECT id FROM books WHERE author=? ORDER BY id LIMIT 2)').run(NO_HAREM, 'Mixed Writer');
    const evidence = collectAuthorEvidence(db);
    expect(summarizeAuthor(evidence.get('sparsewriter')!).harem.eligible).toBe(false);
    const mixed = summarizeAuthor(evidence.get('mixedwriter')!).harem;
    expect(mixed).toMatchObject({ samples: 3, positives: 1, negatives: 2, eligible: false });
    expect(planAuthorJobs(db)).toBe(0);
  });

  it('never derives an author-wide negative from books that disclaim the trope', async () => {
    addCatalog('Clean Writer', 6, NO_HAREM);
    const summary = summarizeAuthor(collectAuthorEvidence(db).get('cleanwriter')!).harem;
    expect(summary).toMatchObject({ positives: 0, negatives: 6, eligible: false });
    const result = await processAuthorProfile(db, 'cleanwriter', { confirm: 'evidence' });
    expect(result.skipped).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_author_profiles').get()).toEqual({ n: 0 });
    expect(loadAuthorProfiles(db).size).toBe(0);
  });

  it('will not turn a single series into an author-wide default', () => {
    addSeries('Series Writer', 'Bound Company', 8, HAREM);
    const single = summarizeAuthor(collectAuthorEvidence(db).get('serieswriter')!).harem;
    expect(single).toMatchObject({ samples: 8, positives: 8, share: 1, positiveSeries: 1, eligible: false });
    expect(planAuthorJobs(db)).toBe(0);
    // The same disclosure in a second series is what makes it a fact about the author.
    addSeries('Series Writer', 'Second Cycle', 3, HAREM);
    expect(summarizeAuthor(collectAuthorEvidence(db).get('serieswriter')!).harem).toMatchObject({ positiveSeries: 2, eligible: true });
    expect(planAuthorJobs(db)).toBe(1);
  });

  it('does not treat one-off titles with no series metadata as independent evidence', () => {
    // Most legacy retailer rows carry no series at all; unique names are not proof of independence.
    for (const [i, title] of ['Affinity Network', 'Ancient Roots', 'Battle for the Frontier', 'Corebound'].entries())
      addBook({ id: `STANDALO${i}0`, author: 'Standalone Writer', title, description: HAREM });
    expect(summarizeAuthor(collectAuthorEvidence(db).get('standalonewriter')!).harem)
      .toMatchObject({ positives: 4, positiveSeries: 1, eligible: false });

    // A repeated title stem is visible evidence of a series, even with the metadata missing.
    for (const [i, title] of ['CyberRealm - Book 1', 'CyberRealm - Book 2', 'CyberRealm - Book 3',
      'Eternal Dungeon - Book 1', 'Eternal Dungeon - Book 2', 'Eternal Dungeon - Book 3'].entries())
      addBook({ id: `STEMWRIT${i}0`, author: 'Stem Writer', title, description: HAREM });
    expect(summarizeAuthor(collectAuthorEvidence(db).get('stemwriter')!).harem)
      .toMatchObject({ positives: 6, positiveSeries: 2, eligible: true });
  });

  it('counts a work once across editions and ignores box sets', () => {
    addBook({ id: 'EDITION001', author: 'Ana Author', series: 'One Work', number: 1, description: HAREM });
    addBook({ id: 'EDITION002', author: 'Ana Author', series: 'One Work', number: 1, title: 'One Work 1', subtitle: 'Dramatized Adaptation', description: HAREM });
    addBook({ id: 'EDITION003', author: 'Ana Author', series: 'One Work', number: 1, title: 'One Work 1', subtitle: 'Graphic Audio', description: HAREM });
    addBook({ id: 'BOXSET0001', author: 'Ana Author', series: 'One Work', number: 9, title: 'One Work Boxed Set: Books 1-3', description: HAREM });
    const evidence = collectAuthorEvidence(db).get('anaauthor')!;
    expect(evidence.works).toHaveLength(1);
    expect(summarizeAuthor(evidence).harem.eligible).toBe(false);
  });
});

describe('author profiles apply only where a book has no evidence', () => {
  it('inherits a consistent author pattern onto an unassessed title, and only for that author', async () => {
    addCatalog('Ana Author', 6, HAREM);
    addCatalog('Other Writer', 6, NEUTRAL);
    expect(planAuthorJobs(db)).toBe(1);
    const result = await reviewed('anaauthor');
    expect(result).toMatchObject({ recorded: ['harem'], present: ['harem'], works: 6 });

    const profiles = loadAuthorProfiles(db);
    const book = makeBook();
    expect(applyAuthorProfile(book, profiles)).toEqual(['harem']);
    // The per-book evidence was a publisher disclosure, but the author-wide claim is an inference
    // and must not be exported as something a publisher said about this book.
    expect(book.content.harem).toMatchObject({ verdict: 'present', source: 'jev', confidence: confidenceCeiling(1, 6) });
    expect(book.content.harem.note).toContain('6 of 6 assessed titles across 2 series by Ana Author');
    expect(book.content.harem.note).toContain('not a claim about this book');
    const stored = db.prepare("SELECT signal_source, evidence_json FROM catalog_author_profiles WHERE field='harem'").get() as { signal_source: string; evidence_json: string };
    expect(stored.signal_source).toBe('jev');
    expect(JSON.parse(stored.evidence_json).evidenceSources).toEqual({ publisher: 6 });
    expect(passesFilters(book, defaultFilters)).toBe(false);
    // The pattern is about this author's catalog; it says nothing about anyone else's books.
    const other = makeBook({ author: 'Other Writer' });
    expect(applyAuthorProfile(other, profiles)).toEqual([]);
    expect(other.content.harem.verdict).toBe('unknown');
    // And it never leaks across fields it has no evidence for.
    expect(book.content.explicit.verdict).toBe('unknown');
    expect(book.content.sexualized.verdict).toBe('unknown');
  });

  it('lets a book-level disclaimer and a book-level assessment outrank the author default', async () => {
    addCatalog('Ana Author', 6, HAREM);
    await reviewed('anaauthor');
    const profiles = loadAuthorProfiles(db);

    const disclaimed = makeBook({ description: NO_HAREM, content: classifyContent({ title: 'A later book', subtitle: '', description: NO_HAREM, narrator: null }) });
    expect(applyAuthorProfile(disclaimed, profiles)).toEqual([]);
    expect(disclaimed.content.harem).toMatchObject({ verdict: 'absent', source: 'publisher' });
    expect(passesFilters(disclaimed, defaultFilters)).toBe(true);

    const assessed = makeBook();
    assessed.content.harem = { verdict: 'absent', confidence: 0.55, source: 'jev', note: 'Jev found no harem evidence.' };
    expect(applyAuthorProfile(assessed, profiles)).toEqual([]);
    expect(assessed.content.harem.source).toBe('jev');
  });

  it('must run after book-level enrichment, or it shadows the work\'s own assessment', async () => {
    addCatalog('Ana Author', 6, HAREM);
    await reviewed('anaauthor');
    const profiles = loadAuthorProfiles(db);
    // enrichCatalogSeries fills a hash-valid work assessment into any field still unknown.
    const workAssessment: ContentSignal = { verdict: 'absent', confidence: 0.9, source: 'jev', note: 'Work-level Jev assessment of the publisher listing.' };
    const enrich = (b: CatalogBook) => { for (const f of ['explicit', 'harem'] as const) if (b.content[f].verdict === 'unknown') b.content[f] = workAssessment; };

    // Wrong order: the author-wide default claims the field first and the book's own evidence never lands.
    const early = makeBook();
    applyAuthorProfile(early, profiles); enrich(early);
    expect(early.content.harem).toMatchObject({ verdict: 'present', source: 'jev' });

    // Correct order: enrichment first, so a fact about this book outranks a pattern about its author.
    const late = makeBook();
    enrich(late); applyAuthorProfile(late, profiles);
    expect(late.content.harem).toMatchObject({ verdict: 'absent', source: 'jev' });
    expect(passesFilters(late, defaultFilters)).toBe(true);
  });

  it('keeps the manual reviewed author rule and per-book exceptions in charge, in either order', async () => {
    addCatalog('Bruce Sentar', 6, NEUTRAL, i => `https://example.com/bruce-${i}.jpg`);
    await reviewed('brucesentar', PRESENT_SEX);
    const profiles = loadAuthorProfiles(db);

    const first = makeBook({ author: 'Bruce Sentar', title: 'A future title' });
    applyAuthorProfile(first, profiles); applyAuthorRules(first);
    const second = makeBook({ author: 'Bruce Sentar', title: 'A future title' });
    applyAuthorRules(second); applyAuthorProfile(second, profiles);
    for (const book of [first, second]) {
      expect(book.content.sexualized).toMatchObject({ verdict: 'present', source: 'manual', confidence: 1 });
      expect(book.content.sexualized.note).toContain('reader review');
      expect(passesFilters(book, defaultFilters)).toBe(false);
    }
    // A reviewed per-book exception, applied last by the exporter, still wins outright.
    const exception: ContentSignal = { verdict: 'absent', confidence: 1, source: 'manual', note: 'Reviewed: this title is not sexualized.' };
    first.content.sexualized = exception;
    expect(passesFilters(first, defaultFilters)).toBe(true);
    // An unrelated author whose name merely starts the same is untouched by either mechanism.
    const unrelated = makeBook({ author: 'Bruce Sentarson' });
    applyAuthorProfile(unrelated, profiles); applyAuthorRules(unrelated);
    expect(unrelated.content.sexualized.verdict).toBe('unknown');
    expect(creditedIdentities('Bruce Sentar and Jane Coauthor')).toEqual(['brucesentar', 'janecoauthor']);
  });
});

describe('cover evidence stays marketing evidence', () => {
  it('builds a sexualized profile from covers but never an explicit or harem one', async () => {
    addCatalog('Cover Writer', 6, NEUTRAL, i => `https://example.com/cover-${i}.jpg`);
    const evidence = collectAuthorEvidence(db).get('coverwriter')!;
    const summaries = summarizeAuthor(evidence);
    expect(summaries.sexualized).toMatchObject({ positives: 6, eligible: true, evidenceSource: 'vision', positiveSeries: 2 });
    expect(summaries.explicit).toMatchObject({ samples: 0, eligible: false });
    expect(summaries.harem).toMatchObject({ samples: 0, eligible: false });

    const result = await reviewed('coverwriter', PRESENT_SEX);
    expect(result.recorded).toEqual(['sexualized']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_author_profiles WHERE field IN ('explicit','harem')").get()).toEqual({ n: 0 });

    const state = JSON.stringify(authorState(evidence));
    expect(state).toContain('"sexualized":{');
    expect(state).toContain('"explicit":null');
    expect(state).toContain('"harem":null');
  });

  it('withholds the author identity from the evidence sent for review', () => {
    addCatalog('Ana Author', 6, HAREM);
    const evidence = collectAuthorEvidence(db).get('anaauthor')!;
    expect(JSON.stringify(authorState(evidence))).not.toContain('Ana Author');
  });
});

describe('confidence reflects consistency and breadth', () => {
  it('records a narrow pattern without giving it filtering strength', async () => {
    addCatalog('Narrow Writer', 3, HAREM);
    await reviewed('narrowwriter');
    const narrow = makeBook({ author: 'Narrow Writer' });
    expect(applyAuthorProfile(narrow, loadAuthorProfiles(db))).toEqual(['harem']);
    expect(narrow.content.harem.confidence).toBeCloseTo(0.7, 3);
    expect(passesFilters(narrow, defaultFilters)).toBe(true);

    addSeries('Narrow Writer', 'Third Cycle', 5, HAREM);
    await reviewed('narrowwriter');
    const broad = makeBook({ author: 'Narrow Writer' });
    applyAuthorProfile(broad, loadAuthorProfiles(db));
    expect(broad.content.harem.confidence).toBeCloseTo(0.95, 3);
    expect(passesFilters(broad, defaultFilters)).toBe(false);
  });
});

describe('a stored profile stops applying once it stops being true', () => {
  it('lets a newer review revoke an older pattern', async () => {
    addCatalog('Ana Author', 6, HAREM);
    await reviewed('anaauthor');
    expect(loadAuthorProfiles(db, { verify: false }).size).toBeGreaterThan(0);
    // Evidence moves and the fresh review no longer finds an author-wide pattern.
    db.prepare('UPDATE books SET description=? WHERE id=?').run(NO_HAREM, bookId('Ana Author', 'Bound Company', 2));
    await reviewed('anaauthor', { ...PRESENT_HAREM, harem: ['unknown', 0.3] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_author_profiles WHERE field='harem'").get()).toEqual({ n: 2 });
    // The table is append-only, so the newest row has to win before any verdict filtering,
    // or the superseded 'present' would keep hiding books forever.
    expect(loadAuthorProfiles(db, { verify: false }).size).toBe(0);
    expect(loadAuthorProfiles(db).size).toBe(0);
  });

  it('drops a profile whose evidence has changed since it was written', async () => {
    addCatalog('Ana Author', 6, HAREM);
    await reviewed('anaauthor');
    expect(loadAuthorProfiles(db).size).toBeGreaterThan(0);
    db.prepare('UPDATE books SET description=? WHERE id=?').run(NO_HAREM, bookId('Ana Author', 'Bound Company', 2));
    // The pattern no longer describes the catalog, so it stops applying until re-reviewed.
    expect(loadAuthorProfiles(db).size).toBe(0);
    expect(applyAuthorProfile(makeBook(), loadAuthorProfiles(db))).toEqual([]);
    // It is only skipping the freshness check that would still apply it, which is why
    // verification is the default rather than something a caller has to remember.
    expect(loadAuthorProfiles(db, { verify: false }).size).toBeGreaterThan(0);
  });

  it('ignores a profile written under a different rubric', async () => {
    addCatalog('Ana Author', 6, HAREM);
    await reviewed('anaauthor');
    db.prepare("UPDATE catalog_author_profiles SET rubric_version='author-content-v0'").run();
    expect(loadAuthorProfiles(db).size).toBe(0);
  });

  it('a dry run reports a verdict without writing one', async () => {
    addCatalog('Ana Author', 6, HAREM);
    const result = await processAuthorProfile(db, 'anaauthor', { confirm: 'evidence' });
    expect(result).toMatchObject({ dryRun: true, eligible: ['harem'], recorded: [], present: ['harem'] });
    expect(result.profiles?.[0]).toMatchObject({ field: 'harem', verdict: 'present' });
    // Nothing persisted: no profile row, and no reservation of the paid cache key.
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_author_profiles').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_inferences WHERE kind='author-profile'").get()).toEqual({ n: 0 });
    expect(loadAuthorProfiles(db).size).toBe(0);
  });
});

describe('durable, cached author review', () => {
  it('reuses a cached verdict for unchanged evidence and re-reviews when the evidence changes', async () => {
    addCatalog('Ana Author', 6, HAREM);
    const evaluateStub = vi.fn(async () => jevStub({ sexualized: ['unknown', 0.4], explicit: ['unknown', 0.3], harem: ['present', 0.9] }));

    const first = await processAuthorProfile(db, 'anaauthor', { evaluate: evaluateStub as never });
    expect(first).toMatchObject({ present: ['harem'], cached: false, input_tokens: 120 });
    expect(evaluateStub).toHaveBeenCalledTimes(1);

    const second = await processAuthorProfile(db, 'anaauthor', { evaluate: evaluateStub as never });
    expect(second).toMatchObject({ present: ['harem'], cached: true, input_tokens: 0 });
    expect(evaluateStub).toHaveBeenCalledTimes(1);

    // The cache key is the evidence, not the raw blurb: a cosmetic edit must not buy a new review.
    const before = authorProfileHash(authorState(collectAuthorEvidence(db).get('anaauthor')!));
    db.prepare('UPDATE books SET description=? WHERE id=?').run(`${HAREM} A newly revised publisher blurb.`, bookId('Ana Author', 'Bound Company', 1));
    expect(authorProfileHash(authorState(collectAuthorEvidence(db).get('anaauthor')!))).toBe(before);
    await processAuthorProfile(db, 'anaauthor', { evaluate: evaluateStub as never });
    expect(evaluateStub).toHaveBeenCalledTimes(1);

    // Evidence that actually changes does force a fresh review.
    db.prepare('UPDATE books SET description=? WHERE id=?').run(NO_HAREM, bookId('Ana Author', 'Bound Company', 2));
    const after = authorProfileHash(authorState(collectAuthorEvidence(db).get('anaauthor')!));
    expect(after).not.toBe(before);
    await processAuthorProfile(db, 'anaauthor', { evaluate: evaluateStub as never });
    expect(evaluateStub).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_author_profiles WHERE field='harem'").get()).toEqual({ n: 2 });
    // The newest evidence supersedes the old row without deleting the audit trail.
    expect(loadAuthorProfiles(db).get('anaauthor')!.filter(p => p.field === 'harem')).toHaveLength(1);
    expect(loadAuthorProfiles(db).get('anaauthor')![0].inputHash).toBe(after);
  });

  it('records an eligible field that review declines as unknown, and applies nothing', async () => {
    addCatalog('Ana Author', 6, HAREM);
    const evaluateStub = vi.fn(async () => jevStub({ sexualized: ['unknown', 0.2], explicit: ['unknown', 0.2], harem: ['absent', 0.9] }));
    const result = await processAuthorProfile(db, 'anaauthor', { evaluate: evaluateStub as never });
    expect(result).toMatchObject({ eligible: ['harem'], recorded: ['harem'], present: [] });
    const row = db.prepare("SELECT verdict, evidence_json FROM catalog_author_profiles WHERE field='harem'").get() as { verdict: string; evidence_json: string };
    expect(row.verdict).toBe('unknown');
    // The model's own answer is retained even though no author-wide negative is derived from it.
    expect(JSON.parse(row.evidence_json).modelChoice).toBe('absent');
    expect(loadAuthorProfiles(db).size).toBe(0);
    const book = makeBook();
    expect(applyAuthorProfile(book, loadAuthorProfiles(db))).toEqual([]);
  });

  it('takes the lower of the evidence ceiling and the reviewer confidence', async () => {
    addCatalog('Ana Author', 6, HAREM);
    const evaluateStub = vi.fn(async () => jevStub({ sexualized: ['unknown', 0.2], explicit: ['unknown', 0.2], harem: ['present', 0.62] }));
    await processAuthorProfile(db, 'anaauthor', { evaluate: evaluateStub as never });
    const book = makeBook();
    applyAuthorProfile(book, loadAuthorProfiles(db));
    expect(book.content.harem.confidence).toBe(0.62);
    expect(passesFilters(book, defaultFilters)).toBe(true);
  });
});

/**
 * Author evidence deliberately rebuilds what the exporter computes. That duplication is only
 * safe while the two agree, so compare them directly: if the exporter's inputs, caches or
 * precedence change again, this fails instead of the evidence quietly going empty.
 */
describe('author evidence tracks the exporter', () => {
  const exported = (id: string) => buildCatalog(db).books.find(b => b.id === id)!;
  const evidenceFor = (authorId: string, title: string) =>
    collectAuthorEvidence(db).get(authorId)!.works.find(w => w.title === title)!;

  it('reads the same cover-content edition inference the exporter reads', () => {
    const url = 'https://example.com/drift.jpg';
    const cover = addCover(url, 'suggestive', 0.6);
    addBook({ id: 'DRIFT00001', author: 'Drift Writer', title: 'A drifting title', series: 'Drift Cycle', number: 1, cover: url });
    const input = { title: 'A drifting title', subtitle: '', series: 'Drift Cycle', author: 'Drift Writer', description: NEUTRAL };
    addCoverContent('DRIFT00001', input, cover, { sexualized: 'present', harem: 'present' });

    const book = exported('DRIFT00001'), work = evidenceFor('driftwriter', 'A drifting title');
    for (const field of ['sexualized', 'explicit', 'harem'] as const) {
      expect(work.signals[field], field).toEqual(book.content[field]);
    }
    // And the cache is genuinely being consumed, not matching because both sides found nothing.
    expect(work.signals.harem).toMatchObject({ verdict: 'present', source: 'jev' });
  });

  it('preserves an explicit publisher negative against a cover-derived claim, on both sides', () => {
    const url = 'https://example.com/disclaimed.jpg';
    const cover = addCover(url, 'sexualized', 0.9);
    addBook({ id: 'DISCLAIM01', author: 'Drift Writer', title: 'A disclaimed title', series: 'Drift Cycle', number: 2, description: NO_HAREM, cover: url });
    const input = { title: 'A disclaimed title', subtitle: '', series: 'Drift Cycle', author: 'Drift Writer', description: NO_HAREM };
    addCoverContent('DISCLAIM01', input, cover, { harem: 'present' });

    const book = exported('DISCLAIM01'), work = evidenceFor('driftwriter', 'A disclaimed title');
    expect(book.content.harem).toMatchObject({ verdict: 'absent', source: 'publisher' });
    expect(work.signals.harem).toEqual(book.content.harem);
    for (const field of ['sexualized', 'explicit', 'harem'] as const) {
      expect(work.signals[field], field).toEqual(book.content[field]);
    }
  });
});
