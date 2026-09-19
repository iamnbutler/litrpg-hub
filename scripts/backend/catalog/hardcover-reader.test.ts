import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicReviews, hardcoverClient, importHardcoverReviews, linkTarget, MAX_REVIEWS, RetryableError, snapshotKey, toEvidence, verifyIdentity, type GraphQL, type HardcoverBook, type HardcoverReview } from './hardcover-reader.js';
import { readerEvidenceFor, summarizeReaderEvidence } from './reader-evidence.js';

const MIGRATIONS = ['001_initial.sql','002_cursor_results_found.sql','003_jev_assessments.sql','004_cover_assessments.sql','005_source_history.sql','006_catalog_pipeline.sql','007_author_profiles.sql','008_reader_evidence.sql','010_reader_trait_honesty.sql'];
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  for (const name of MIGRATIONS) db.exec(readFileSync(join(import.meta.dirname, '../migrations', name), 'utf8'));
  db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run('dcc', 'Dungeon Crawler Carl', 'Matt Dinniman', '2026-09-01T00:00:00.000Z');
  db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('work-dcc-1', 'dcc', 1, 'Dungeon Crawler Carl', 'Matt Dinniman', 'https://example.com/dcc', '2026-09-01T00:00:00.000Z');
});
afterEach(() => db.close());

const book: HardcoverBook = { id: 446681, title: 'Dungeon Crawler Carl', slug: 'dungeon-crawler-carl', authors: ['Matt Dinniman'], reviewsCount: 448, ratingsCount: 3739 };
const hcReview = (id: number, over: Partial<HardcoverReview> = {}): HardcoverReview => ({
  id, review: `A substantive review number ${id} about the narration, pacing and humour.`, rating: 5,
  reviewed_at: '2026-02-01T00:00:00Z', review_has_spoilers: false, sponsored_review: false, privacy_setting_id: 1,
  user: { id: 1000 + id }, ...over
});
// `user_books(` contains `books(`, so route on the more specific match first.
const isReviewQuery = (query: string) => query.includes('user_books(');
const stubClient = (books: Record<string, unknown>[], reviews: HardcoverReview[]): GraphQL =>
  (async (query: string) => isReviewQuery(query) ? { user_books: reviews } : { books }) as GraphQL;
const raw = (over: Record<string, unknown> = {}) => ({ id: 446681, title: 'Dungeon Crawler Carl', slug: 'dungeon-crawler-carl',
  reviews_count: 448, ratings_count: 3739, cached_contributors: [{ author: { name: 'Matt Dinniman' } }, { author: { name: 'Will Staehle' } }], ...over });

describe('identity is verified before any review is attached', () => {
  it('requires the exact title and a credited author', () => {
    expect(verifyIdentity([raw()], { title: 'Dungeon Crawler Carl', author: 'Matt Dinniman' })?.id).toBe(446681);
    // A real duplicate on Hardcover credits the same book to a split name.
    const split = raw({ id: 2878723, ratings_count: 0, reviews_count: 0, cached_contributors: [{ author: { name: 'Dinniman' } }, { author: { name: 'Matt' } }] });
    expect(verifyIdentity([split], { title: 'Dungeon Crawler Carl', author: 'Matt Dinniman' })).toBeNull();
    // Given both, the record readers actually used wins.
    expect(verifyIdentity([split, raw()], { title: 'Dungeon Crawler Carl', author: 'Matt Dinniman' })?.id).toBe(446681);
    // A different author, or a near-miss title, is never accepted.
    expect(verifyIdentity([raw()], { title: 'Dungeon Crawler Carl', author: 'Someone Else' })).toBeNull();
    expect(verifyIdentity([raw()], { title: 'Dungeon Crawler Carl 2', author: 'Matt Dinniman' })).toBeNull();
  });

  it('reports an unresolved target instead of importing against a guess', async () => {
    const result = await importHardcoverReviews(db, [{ title: 'Dungeon Crawler Carl', author: 'Nobody At All' }],
      { client: stubClient([raw()], [hcReview(1)]) });
    expect(result[0]).toMatchObject({ resolved: false, stored: 0, bookId: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_reader_evidence').get()).toEqual({ n: 0 });
  });
});

describe('only public, independent, attributable reviews are retained', () => {
  it('drops private, sponsored, empty and unattributed rows even if the API returns them', () => {
    const kept = toEvidence(book, [
      hcReview(1),
      hcReview(2, { privacy_setting_id: 3 }),
      hcReview(3, { sponsored_review: true }),
      hcReview(4, { review: '   ' }),
      hcReview(5, { review: null }),
      hcReview(6, { user: null })
    ]);
    expect(kept).toHaveLength(1);
    // The surviving row is the public, unsponsored one, keyed by a digest rather than the raw id.
    expect(kept[0].externalId).toMatch(/^[0-9a-f]{32}$/);
    // The raw Hardcover row id never survives into storage in any recognisable form.
    expect(kept[0].externalId).not.toBe('user_book:1');
    expect(toEvidence(book, [hcReview(1)])[0].externalId).toBe(kept[0].externalId); // stable
    expect(kept[0].body).toContain('review number 1 ');
  });

  it('stores a one-way digest and never the reviewer account', () => {
    const [item] = toEvidence(book, [hcReview(7, { user: { id: 424242 } })]);
    expect(item.authorKey).toHaveLength(32);
    expect(JSON.stringify(item)).not.toContain('424242');
    // Two reviews by one account are one voice; two accounts are two.
    const same = toEvidence(book, [hcReview(8, { user: { id: 9 } }), hcReview(9, { user: { id: 9 } })]);
    expect(new Set(same.map(i => i.authorKey)).size).toBe(1);
  });

  it('uses the source spoiler flag rather than assuming', () => {
    expect(toEvidence(book, [hcReview(1, { review_has_spoilers: true })])[0].containsSpoilers).toBe(true);
    expect(toEvidence(book, [hcReview(2, { review_has_spoilers: false })])[0].containsSpoilers).toBe(false);
  });

  it('asks the API only for public, unsponsored reviews and never more than one bounded page', async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const client: GraphQL = (async (query: string, variables: Record<string, unknown> = {}) => {
      calls.push({ query, variables });
      return isReviewQuery(query) ? { user_books: [hcReview(1)] } : { books: [raw()] };
    }) as GraphQL;
    await importHardcoverReviews(db, [{ title: 'Dungeon Crawler Carl', author: 'Matt Dinniman' }], { client, limit: 9999 });
    const reviewCall = calls.find(c => isReviewQuery(c.query))!;
    expect(reviewCall.query).toContain('privacy_setting_id: {_eq: 1}');
    expect(reviewCall.query).toContain('sponsored_review: {_eq: false}');
    expect(reviewCall.variables.limit).toBe(MAX_REVIEWS);
    expect(await fetchPublicReviews(client, 1, 0)).toHaveLength(1);
    expect(calls.at(-1)!.variables.limit).toBe(1);
  });
});

const noSleep = { sleep: async () => {}, gapMs: 0 };
describe('the client is polite and failures stay contained', () => {
  it('backs off on a 429 and honours retry-after instead of hammering', async () => {
    process.env.HARDCOVER_API_TOKEN = 'test-token';
    const waits: number[] = [];
    let calls = 0;
    const request = (async () => {
      calls++;
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
        : new Response(JSON.stringify({ data: { books: [raw()] } }), { status: 200 });
    }) as typeof fetch;
    const client = hardcoverClient(request, { sleep: async (ms) => { waits.push(ms); }, gapMs: 0 });
    expect(await client('{ books { id } }')).toMatchObject({ books: expect.any(Array) });
    expect(calls).toBe(2);
    expect(waits).toContain(2000);
  });

  it('gives up after bounded retries rather than retrying forever', async () => {
    process.env.HARDCOVER_API_TOKEN = 'test-token';
    let calls = 0;
    const request = (async () => { calls++; return new Response('nope', { status: 429 }); }) as typeof fetch;
    await expect(hardcoverClient(request, noSleep)('{ books { id } }')).rejects.toThrow(RetryableError);
    expect(calls).toBe(3);
  });

  it('keeps a target that imported cleanly when a later one is blocked', async () => {
    let seen = 0;
    const client: GraphQL = (async (query: string, variables: Record<string, unknown> = {}) => {
      if (!isReviewQuery(query)) {
        seen++;
        return { books: [raw({ title: variables.title, slug: String(variables.title).toLowerCase().replace(/\W+/g, '-') })] };
      }
      if (seen > 1) throw new Error('Hardcover returned HTTP 429.');
      return { user_books: [hcReview(1)] };
    }) as GraphQL;
    const results = await importHardcoverReviews(db, [
      { title: 'Dungeon Crawler Carl', author: 'Matt Dinniman' },
      { title: "Carl's Doomsday Scenario", author: 'Matt Dinniman', workId: 'work-dcc-1' }
    ], { client });
    expect(results[0]).toMatchObject({ resolved: true, stored: 1 });
    expect(results[1]).toMatchObject({ resolved: false, stored: 0 });
    expect(results[1].note).toContain('429');
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_reader_evidence').get()).toEqual({ n: 1 });
  });
});

describe('imported reviews land as linked, deduplicated evidence', () => {
  it('links to the catalog work and is idempotent', async () => {
    const reviews = [1, 2, 3, 4, 5, 6].map(i => hcReview(i));
    const client = stubClient([raw()], reviews);
    const target = { title: 'Dungeon Crawler Carl', author: 'Matt Dinniman' };
    const first = await importHardcoverReviews(db, [target], { client });
    expect(first[0]).toMatchObject({ resolved: true, cached: false, fetched: 6, kept: 6, stored: 6, workId: 'work-dcc-1', url: 'https://hardcover.app/books/dungeon-crawler-carl' });
    expect((await importHardcoverReviews(db, [target], { client }))[0].stored).toBe(0);

    const rows = readerEvidenceFor(db, 'work', 'work-dcc-1');
    expect(rows).toHaveLength(6);
    expect(summarizeReaderEvidence('work-dcc-1', rows)).toMatchObject({ voices: 6, substantiveVoices: 6, eligible: true });
    expect(db.prepare('SELECT source_name FROM catalog_reader_evidence LIMIT 1').get()).toEqual({ source_name: 'hardcover.app' });
  });

  it('never sends a request without a token and never puts one in an error', async () => {
    const previous = process.env.HARDCOVER_API_TOKEN;
    delete process.env.HARDCOVER_API_TOKEN;
    const request = vi.fn();
    await expect(hardcoverClient(request as never, noSleep)('{ books { id } }')).rejects.toThrow('HARDCOVER_API_TOKEN');
    expect(request).not.toHaveBeenCalled();

    process.env.HARDCOVER_API_TOKEN = 'secret-token-value';
    const failing = (async () => new Response('Bearer secret-token-value echoed back', { status: 500 })) as typeof fetch;
    await expect(hardcoverClient(failing, noSleep)('{ books { id } }')).rejects.toThrow(/HTTP 500/);
    await hardcoverClient(failing, noSleep)('{ books { id } }').catch((error: Error) => {
      expect(error.message).not.toContain('secret-token-value');
    });
    if (previous === undefined) delete process.env.HARDCOVER_API_TOKEN; else process.env.HARDCOVER_API_TOKEN = previous;
  });
});


describe('acquisition is durable', () => {
  const target = { title: 'Dungeon Crawler Carl', author: 'Matt Dinniman' };
  const countingClient = (counter: { http: number }): GraphQL => (async (query: string) => {
    counter.http++;
    return isReviewQuery(query) ? { user_books: [1, 2, 3, 4, 5, 6].map(i => hcReview(i)) } : { books: [raw()] };
  }) as GraphQL;

  it('repeats with zero HTTP, including the lookup request', async () => {
    const counter = { http: 0 };
    const client = countingClient(counter);
    const first = await importHardcoverReviews(db, [target], { client });
    expect(first[0]).toMatchObject({ cached: false, stored: 6 });
    expect(counter.http).toBe(2); // one identity lookup, one bounded review page

    const again = await importHardcoverReviews(db, [target], { client });
    expect(again[0]).toMatchObject({ cached: true, stored: 0, fetched: 0, workId: 'work-dcc-1' });
    expect(again[0].note).toContain('no request was made');
    expect(counter.http).toBe(2); // nothing further, not even the lookup
  });

  it('refetches once the snapshot expires, and immediately with --force', async () => {
    const counter = { http: 0 };
    const client = countingClient(counter);
    const captured = new Date('2026-01-01T00:00:00Z');
    await importHardcoverReviews(db, [target], { client, now: captured });
    expect(counter.http).toBe(2);
    // Inside the 30-day window: still cached.
    await importHardcoverReviews(db, [target], { client, now: new Date('2026-01-20T00:00:00Z') });
    expect(counter.http).toBe(2);
    // Past it: refetched.
    await importHardcoverReviews(db, [target], { client, now: new Date('2026-03-01T00:00:00Z') });
    expect(counter.http).toBe(4);
    // And force bypasses a fresh snapshot.
    await importHardcoverReviews(db, [target], { client, now: new Date('2026-03-01T01:00:00Z'), force: true });
    expect(counter.http).toBe(6);
  });

  it('retains provenance and no raw account identifier in the snapshot', async () => {
    const counter = { http: 0 };
    await importHardcoverReviews(db, [target], { client: countingClient(counter) });
    const snapshot = db.prepare('SELECT body FROM catalog_documents WHERE url=?').get(snapshotKey(target, MAX_REVIEWS)) as { body: string };
    const parsed = JSON.parse(snapshot.body);
    expect(parsed).toMatchObject({ source: 'hardcover.app', workId: 'work-dcc-1', available: 448, fetched: 6, method: 'earliest-by-review-id' });
    // The reviewer account ids used by the fixture are 1001..1006; none may survive.
    for (const id of [1001, 1002, 1003, 1004, 1005, 1006]) expect(snapshot.body).not.toContain(String(id));
    expect(snapshot.body).not.toContain('"user"');
    // Evidence rows point back at the snapshot they came from.
    expect(db.prepare('SELECT DISTINCT document_id FROM catalog_reader_evidence').all()).toHaveLength(1);
  });

  it('a cached repeat does not overwrite a corrected link or a manual edit', async () => {
    const counter = { http: 0 };
    const client = countingClient(counter);
    await importHardcoverReviews(db, [target], { client });
    // Someone re-links a row by hand and flags it as a spoiler.
    db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('work-corrected', 'dcc', 2, 'Corrected', 'Matt Dinniman', 'https://example.com/c', '2026-09-01T00:00:00.000Z');
    db.prepare("UPDATE catalog_reader_evidence SET work_id='work-corrected', contains_spoilers=1 WHERE id IN (SELECT id FROM catalog_reader_evidence LIMIT 1)").run();
    const before = db.prepare('SELECT id, work_id, contains_spoilers FROM catalog_reader_evidence ORDER BY id').all();
    await importHardcoverReviews(db, [target], { client });
    expect(db.prepare('SELECT id, work_id, contains_spoilers FROM catalog_reader_evidence ORDER BY id').all()).toEqual(before);
    expect(counter.http).toBe(2);
  });
});


describe('an explicit workId is verified, not trusted', () => {
  const base = { title: 'Dungeon Crawler Carl', author: 'Matt Dinniman' };
  beforeEach(() => {
    db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run('other', 'Another Series', 'Someone Else', '2026-09-01T00:00:00.000Z');
    db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('work-other-1', 'other', 1, 'Another Book', 'Someone Else', 'https://example.com/o', '2026-09-01T00:00:00.000Z');
  });

  it('binds when the named work is credited to the same author with the same title', () => {
    expect(linkTarget(db, { ...base, workId: 'work-dcc-1' })).toEqual({ workId: 'work-dcc-1', seriesId: 'dcc' });
  });

  it('refuses a work credited to a different author rather than attaching readers to it', () => {
    const link = linkTarget(db, { ...base, workId: 'work-other-1' });
    expect(link).toMatchObject({ workId: null, seriesId: null });
    expect(link.note).toContain('credited to Someone Else');
  });

  it('refuses a title mismatch until a person has reviewed the alias', () => {
    const target = { title: 'Azarinth Healer', author: 'Matt Dinniman', catalogTitle: 'Azarinth Healer Book One', workId: 'work-dcc-1' };
    const refused = linkTarget(db, target);
    expect(refused.workId).toBeNull();
    expect(refused.note).toContain('aliasReviewed');
    // With the alias explicitly reviewed, the same binding is allowed.
    expect(linkTarget(db, { ...target, aliasReviewed: true })).toEqual({ workId: 'work-dcc-1', seriesId: 'dcc' });
  });

  it('refuses a workId that does not exist', () => {
    expect(linkTarget(db, { ...base, workId: 'work-imaginary' }).note).toContain('no catalog work');
  });

  it('stores evidence unlinked, with the reason, rather than binding it wrongly', async () => {
    const client = stubClient([raw()], [hcReview(1)]);
    const [result] = await importHardcoverReviews(db, [{ ...base, workId: 'work-other-1' }], { client });
    expect(result).toMatchObject({ resolved: true, stored: 1, workId: null });
    expect(result.note).toContain('credited to Someone Else');
    expect(db.prepare('SELECT work_id FROM catalog_reader_evidence').get()).toEqual({ work_id: null });
  });

  it('matches a source title to a differently titled catalog work through catalogTitle', () => {
    expect(linkTarget(db, { title: 'Dungeon Crawler Carl: Book One', author: 'Matt Dinniman', catalogTitle: 'Dungeon Crawler Carl' }))
      .toEqual({ workId: 'work-dcc-1', seriesId: 'dcc' });
  });
});
