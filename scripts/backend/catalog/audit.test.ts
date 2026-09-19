import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditCatalog } from './audit.js';
import { assessmentHash } from '../jev/assessment.js';
import { extractionHash, extractionInput, profileInput } from './inference.js';
import { audioProductUrl } from './audio.js';
import type { SeedSeries, WorkRow } from './types.js';

let db: Database.Database;
const now = new Date('2026-09-19T12:00:00.000Z');
const seed: SeedSeries = { id: 'test-series', title: 'Test Series', author: 'Test Author', aliases: [], authorAliases: ['Test Author'], genres: ['litrpg'], priority: 1, sources: [] };
const sourceCopy = 'PRIVATE_SOURCE_COPY A healer and their companions explore an underground city, gathering supplies and learning dungeon skills while searching for a missing merchant.';

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  for (const file of ['001_initial.sql', '006_catalog_pipeline.sql']) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  db.prepare('INSERT INTO catalog_series(id,title,author,status,updated_at) VALUES(?,?,?,?,?)').run(seed.id, seed.title, seed.author, 'complete', now.toISOString());
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.close(); });

function work(number: number, sourceDescription = sourceCopy): string {
  const id = `work-${seed.id}-${number}`;
  db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_description,source_url,first_release_date,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, seed.id, number, `Volume ${number}`, seed.author, sourceDescription, `https://aethonbooks.com/book/test-${number}/`, '2020-01-01', now.toISOString());
  return id;
}
function document(id: string, url: string, fetchedAt = '2026-09-01T12:00:00.000Z') {
  db.prepare('INSERT INTO catalog_documents(id,url,content_hash,body,fetched_at) VALUES(?,?,?,?,?)').run(id, url, id, 'PRIVATE_RAW_PAGE', fetchedAt);
}
function edition(id: string, workId: string, format: string, date: string | null, legacyId: string | null = null, verifiedDocument?: string) {
  const url = `https://soundbooththeater.com/shop/audiobooks/${id}/`;
  if (legacyId) db.prepare('INSERT INTO books(id,title,author,release_date) VALUES(?,?,?,?)').run(legacyId, id, seed.author, date ?? '');
  else document(id, url);
  db.prepare('INSERT INTO catalog_editions(id,work_id,legacy_book_id,format,title,source_url,source_name,release_date,identifiers_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, workId, legacyId, format, id, url, legacyId ? 'Audible' : 'Soundbooth Theater', date, JSON.stringify(verifiedDocument ? { verifiedDocument } : {}), now.toISOString());
}
function job(id: string, kind: string, entity: string, status: string, payload: unknown) {
  db.prepare('INSERT INTO catalog_jobs(id,kind,entity_id,input_hash,payload_json,status,available_at,created_at,updated_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, kind, entity, id, JSON.stringify(payload), status, now.toISOString(), now.toISOString(), now.toISOString(), 'PRIVATE_ERROR sk-do-not-output');
}

describe('offline catalog coverage audit', () => {
  it('counts identified audio leads before a canonical work exists and audits their exact products', () => {
    job('identified-lead', 'identified-audio', `${seed.id}--1--B000000004`, 'review',
      { seriesId: seed.id, number: 1, asin: 'B000000004', sourceUrl: 'https://sarahlinauthor.blogspot.com/p/books.html' });
    job('ordinary-lead', 'audio-edition', 'unpromoted', 'pending', { seriesId: seed.id, asin: 'B000000005' });
    const report = auditCatalog(db, now).series[0];
    expect(report.counts.canonicalWorks).toBe(0);
    expect(report.jobs.audioVerification).toMatchObject({review: 1, pending: 1});
    expect(report.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({url:'https://api.audible.com/1.0/catalog/products/B000000004',state:'never-checked'}),
      expect.objectContaining({url:'https://api.audible.com/1.0/catalog/products/B000000005',state:'never-checked'}),
      expect.objectContaining({url:'https://sarahlinauthor.blogspot.com/p/books.html',state:'never-checked'})
    ]));
  });
  it('never treats ebook dates as audio and preserves missing volumes, undated audio, and scope uncertainty', () => {
    const one = work(1), three = work(3), four = work(4), five = work(5);
    edition('ebook-1', one, 'ebook', '2020-01-01');
    edition('ebook-3', three, 'ebook', '2020-01-01');
    edition('audio-3', three, 'audiobook', null);
    edition('audio-4', four, 'audiobook', '2026-12-01');
    edition('audio-5', five, 'audiobook', '2025-01-01');
    edition('audio-5-new-performance', five, 'audiobook', '2027-01-01');
    const report = auditCatalog(db, now).series[0];
    expect(report.counts).toMatchObject({ canonicalWorks: 4, audiobookWorks: 3, confirmedAudiobookWorks: 3, ebookOnlyWorks: 1,
      releasedAudioWorks: 1, upcomingAudioWorks: 1, undatedAudioWorks: 1 });
    expect(report.missingIntegerVolumes).toEqual([2]);
    expect(report.gaps.find(gap => gap.code === 'audio-date-missing')?.works?.map(row => row.id)).toEqual([three]);
    expect(report.gaps.find(gap => gap.code === 'audio-not-confirmed')?.works?.map(row => row.id)).toEqual([one]);
    expect(report.catalogCompleteness).toBe('unknown');
    expect(report.publicationStatus).toBe('complete');
  });

  it('invalidates full current-cache coverage when retained source evidence changes', () => {
    const id = work(1), row = db.prepare('SELECT * FROM catalog_works WHERE id=?').get(id) as WorkRow;
    const synopsis = 'An adventuring healer joins companions beneath a city to search for a missing merchant and learn dungeon skills.';
    db.prepare('UPDATE catalog_works SET description=?,metadata_json=?,assessment_json=? WHERE id=?').run(synopsis,
      JSON.stringify({ synopsis, features: [], inputHash: extractionHash(extractionInput(row)) }),
      JSON.stringify({ inputHash: assessmentHash(profileInput(row, seed)), genre: { value: 'litrpg', confidence: 0.9 } }), id);
    expect(auditCatalog(db, now).totals).toMatchObject({ currentOriginalSummaries: 1, currentJevAssessments: 1, fullCurrentCacheWorks: 1 });
    db.prepare('UPDATE catalog_works SET source_description=? WHERE id=?').run(`${sourceCopy} The publisher corrects the premise with a different destination.`, id);
    const report = auditCatalog(db, now);
    expect(report.totals).toMatchObject({ currentOriginalSummaries: 0, currentJevAssessments: 0, fullCurrentCacheWorks: 0 });
    expect(report.series[0].counts.originalSummaries.stale).toBe(1);
    expect(report.series[0].counts.jev.stale).toBe(1);
    expect(report.series[0].catalogCompleteness).toBe('unknown');
  });

  it('separates unverified legacy audio and queued identifiers from confirmed editions', () => {
    const one = work(1), two = work(2), three = work(3);
    edition('legacy-1', one, 'audiobook', '2025-01-01', 'B000000001');
    edition('ebook-2', two, 'ebook', '2024-01-01');
    job('audio-lead', 'audio-edition', `${two}--B000000002`, 'pending', { seriesId: seed.id, workId: two, asin: 'B000000002' });
    document('verified-product', audioProductUrl('B000000003'));
    edition('legacy-3', three, 'audiobook', null, 'B000000003', 'verified-product');
    const report = auditCatalog(db, now).series[0];
    expect(report.counts).toMatchObject({ audiobookWorks: 2, confirmedAudiobookWorks: 1, unverifiedLegacyAudioWorks: 1, ebookOnlyWorks: 1 });
    expect(report.jobs.audioVerification.pending).toBe(1);
    expect(report.gaps.find(gap => gap.code === 'audio-not-confirmed')?.works?.map(row => row.id)).toEqual([one, two]);
  });

  it('deduplicates exact US product request shapes and uses the newest checked schedule without rewriting history', () => {
    const id = work(1), base = 'https://api.audible.com/1.0/catalog/products/B000000001';
    const oldUrl = `${base}?response_groups=series`, newUrl = audioProductUrl('B000000001'), sameTimeUrl = `${base}?response_groups=media`;
    document('research-note', base, '2026-09-19T11:00:00.000Z');
    document('old-request', oldUrl);
    document('new-request', newUrl, '2026-09-18T03:00:00.000Z');
    document('same-time-request', sameTimeUrl);
    const saveCheck = db.prepare('INSERT INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)');
    saveCheck.run(oldUrl, 'old-request', '2026-09-18T04:00:00.000Z', '2999-01-01T00:00:00.000Z');
    saveCheck.run(newUrl, 'new-request', '2026-09-18T00:30:00-04:00', '2026-09-19T00:00:00.000Z');
    saveCheck.run(sameTimeUrl, 'same-time-request', '2026-09-18T04:30:00.000Z', '2026-12-01T00:00:00.000Z');
    job('base-lead', 'source', base, 'completed', { seriesId: seed.id, url: base });
    job('old-lead', 'source', oldUrl, 'completed', { seriesId: seed.id, url: oldUrl });
    job('audio-pending', 'audio-edition', `${id}--B000000001`, 'pending', { seriesId: seed.id, workId: id, asin: 'B000000001' });
    const before = db.prepare('SELECT * FROM catalog_urls ORDER BY url').all();
    db.pragma('query_only = ON');
    const report = auditCatalog(db, now).series[0];
    expect(report.sources.filter(source => source.url === base)).toEqual([{ url: base, state: 'due',
      lastFetchedAt: '2026-09-18T03:00:00.000Z', lastCheckedAt: '2026-09-18T04:30:00.000Z', nextCheckAt: '2026-09-19T00:00:00.000Z' }]);
    expect(report.sourceChecks).toMatchObject({ total: 2, due: 1, neverChecked: 1 });
    expect(report.gaps.find(gap => gap.code === 'source-never-checked')?.urls).not.toContain(base);
    expect(report.gaps.find(gap => gap.code === 'audio-not-confirmed')?.works?.map(row => row.id)).toEqual([id]);
    expect(report.jobs.audioVerification.pending).toBe(1);
    expect(db.prepare('SELECT * FROM catalog_urls ORDER BY url').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_documents').get()).toEqual({ count: 4 });
  });

  it('keeps research-only products, storefront leads and unchecked publisher pages visible', () => {
    work(1);
    const primary = 'https://aethonbooks.com/book/test-1/', storefront = 'https://www.audible.com/pd/B000000001';
    const base = 'https://api.audible.com/1.0/catalog/products/B000000001', researchOnly = 'https://api.audible.com/1.0/catalog/products/B000000002';
    const fetchedUrl = audioProductUrl('B000000001');
    for (const [key, url] of [['primary-note', primary], ['storefront-note', storefront], ['product-note', base], ['uncrawled-note', researchOnly]]) document(key, url, now.toISOString());
    document('network-product', fetchedUrl);
    db.prepare('INSERT INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
      .run(fetchedUrl, 'network-product', '2026-09-18T00:00:00.000Z', '2026-09-25T00:00:00.000Z');
    for (const [i, url] of [storefront, base, researchOnly].entries()) job(`source-${i}`, 'source', url, 'completed', { seriesId: seed.id, url });
    db.pragma('query_only = ON');
    const report = auditCatalog(db, now).series[0];
    expect(report.sources.find(source => source.url === base)?.state).toBe('current');
    for (const url of [primary, storefront, researchOnly]) expect(report.sources.find(source => source.url === url)?.state).toBe('never-checked');
    expect(report.sourceChecks).toMatchObject({ total: 4, current: 1, neverChecked: 3 });
    expect(report.gaps.find(gap => gap.code === 'source-never-checked')?.urls).toEqual(expect.arrayContaining([primary, storefront, researchOnly]));
  });

  it.each([
    ['another marketplace', 'https://api.audible.co.uk/1.0/catalog/products/B000000001', 'https://api.audible.co.uk/1.0/catalog/products/B000000001'],
    ['another ASIN', 'https://api.audible.com/1.0/catalog/products/B000000002', 'https://api.audible.com/1.0/catalog/products/B000000002'],
    ['an unknown selector', 'https://api.audible.com/1.0/catalog/products/B000000001?marketplace=UK', 'https://api.audible.com/1.0/catalog/products/B000000001?marketplace=UK'],
    ['a storefront page', 'https://www.audible.com/pd/B000000001', 'https://www.audible.com/pd/B000000001'],
    ['a mismatched head document', 'https://api.audible.com/1.0/catalog/products/B000000001', 'https://api.audible.com/1.0/catalog/products/B000000002']
  ])('does not borrow a successful check from %s', (_name, checkedUrl, documentUrl) => {
    work(1);
    const base = 'https://api.audible.com/1.0/catalog/products/B000000001';
    job('product-lead', 'source', base, 'completed', { seriesId: seed.id, url: base });
    document('other-document', documentUrl);
    db.prepare('INSERT INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
      .run(checkedUrl, 'other-document', '2026-09-18T00:00:00.000Z', '2026-09-25T00:00:00.000Z');
    db.pragma('query_only = ON');
    expect(auditCatalog(db, now).series[0].sources.find(source => source.url === base)?.state).toBe('never-checked');
  });

  it('does not collapse publisher pagination just because the public URL omits query parameters', () => {
    work(1);
    const base = 'https://aethonbooks.com/litrpg/', checked = `${base}?page=1`, unchecked = `${base}?page=2`;
    document('page-one', checked);
    db.prepare('INSERT INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
      .run(checked, 'page-one', '2026-09-18T00:00:00.000Z', '2026-09-25T00:00:00.000Z');
    job('first-page', 'source', checked, 'completed', { seriesId: seed.id, url: checked });
    job('second-page', 'source', unchecked, 'pending', { seriesId: seed.id, url: unchecked });
    const pages = auditCatalog(db, now).series[0].sources.filter(source => source.url === base);
    expect(pages).toHaveLength(2);
    expect(pages.map(page => page.state).sort()).toEqual(['current', 'never-checked']);
  });

  it('reports scoped queue and check freshness without writes, model calls, raw prose, or URL credentials', () => {
    const id = work(1, ''), sourceUrl = 'https://aethonbooks.com/book/test-1/';
    document('publisher', sourceUrl);
    db.prepare('INSERT INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
      .run(sourceUrl, 'publisher', '2026-09-18T00:00:00.000Z', '2026-09-25T00:00:00.000Z');
    const productUrl = audioProductUrl('B000000001'); document('product', productUrl);
    db.prepare('INSERT INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
      .run(productUrl, 'product', '2026-09-01T00:00:00.000Z', '2026-09-08T00:00:00.000Z');
    job('audio-pending', 'audio-edition', `${id}--B000000001`, 'pending', { workId: id, asin: 'B000000001', body: 'PRIVATE_READER_TEXT' });
    job('audio-review', 'audio-edition', `${id}--B000000002`, 'review', { seriesId: seed.id, workId: id, asin: 'B000000002' });
    job('extract-failed', 'extract', id, 'failed', {});
    job('summary-retry', 'describe-series', seed.id, 'retry', {});
    job('source-checked', 'source', sourceUrl, 'completed', { seriesId: seed.id, url: `${sourceUrl}?token=sk-do-not-output` });
    job('source-userinfo', 'source', 'credential-url', 'failed', { seriesId: seed.id, url: 'https://secret:sk-do-not-output@aethonbooks.com/private' });
    job('index-global', 'source', 'https://aethonbooks.com/litrpg/', 'pending', {});
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    db.pragma('query_only = ON');
    const report = auditCatalog(db, now), current = report.series[0];
    expect(current.jobs).toMatchObject({ pending: 1, review: 1, failed: 2, retry: 1, completed: 1, outstanding: 2 });
    expect(current.jobs.audioVerification).toMatchObject({ pending: 1, review: 1 });
    expect(report.unscopedJobs.pending).toBe(1);
    expect(current.sources.find(source => source.url === sourceUrl && source.lastCheckedAt)?.state).toBe('current');
    expect(current.sources.find(source => source.url?.includes('/products/B000000001'))).toMatchObject({ state: 'due', lastCheckedAt: '2026-09-01T00:00:00.000Z' });
    expect(current.sources.find(source => source.url?.includes('/products/B000000002'))?.state).toBe('never-checked');
    const json = JSON.stringify(report);
    for (const privateText of ['PRIVATE_SOURCE_COPY', 'PRIVATE_RAW_PAGE', 'PRIVATE_READER_TEXT', 'PRIVATE_ERROR', 'sk-do-not-output', 'token=', 'secret:']) expect(json).not.toContain(privateText);
    expect(request).not.toHaveBeenCalled();
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
