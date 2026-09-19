import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catalogAudioCoverage, type AudioManifestSpec } from './coverage-store.js';
import { hash } from './queue.js';
import { audioWorkIdentity } from './audio.js';
import type { SeedSeries } from './types.js';

let db: Database.Database;
const at = '2026-09-19T04:00:00.000Z';
const seed: SeedSeries = { id: 'test', title: 'Test', author: 'A. Writer', authorAliases: ['A. Writer'], aliases: [], genres: ['litrpg'], priority: 1, sources: [] };
const primaryUrl = 'https://aethonbooks.com/book-series/test/';
const audioUrl = 'https://api.audible.com/1.0/catalog/products/B000000001?response_groups=series';
const spec: AudioManifestSpec = {
  id: 'test-reviewed-1', seriesId: seed.id, scope: 'numbered-mainline', language: 'English', marketplaces: ['US'],
  expectedNumbers: [1], reviewedAt: at, audioCatalogState: 'ongoing',
  bibliography: [{ documentId: 'primary', url: primaryUrl, sourceType: 'publisher' }]
};
const product = { product: { asin: 'B000000001', title: 'Test 1', language: 'english', content_type: 'Product', format_type: 'unabridged', authors: [{name: seed.author}], series: [{ title: seed.title, sequence: '1' }], release_date: '2026-08-01' } };
function document(id: string, url: string, body: string, observed = at) {
  db.prepare('INSERT OR REPLACE INTO catalog_documents VALUES(?,?,?,?,?)').run(id, url, hash(body), body, observed);
  db.prepare('INSERT OR REPLACE INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)').run(url, id, observed, '2026-10-01T00:00:00.000Z');
}
const assess = (now = at) => catalogAudioCoverage(db, seed, now, [spec]);
beforeEach(() => {
  db = new Database(':memory:');
  for (const file of ['001_initial.sql', '006_catalog_pipeline.sql']) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id, seed.title, seed.author, at);
  db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)').run('work-test-1', seed.id, 1, 'Test 1', seed.author, primaryUrl, at);
  db.prepare('INSERT INTO books(id,title,author,release_date) VALUES(?,?,?,?)').run('B000000001', 'Test 1', seed.author, '2025-01-01');
  db.prepare(`INSERT INTO catalog_editions(id,work_id,legacy_book_id,format,title,source_url,source_name,release_date,identifiers_json,updated_at) VALUES(?,?,?,'audiobook',?,?,'Audible',?,?,?)`)
    .run('edition-one', 'work-test-1', 'B000000001', 'Test 1', audioUrl, '2025-01-01', JSON.stringify({ asin: 'B000000001', marketplace: 'US', verifiedDocument: 'audio',workIdentityHash:audioWorkIdentity({id:'work-test-1',series_id:seed.id,number:1,title:'Test 1',author:seed.author}) }), at);
  document('primary', primaryUrl, '<html><h1>Test</h1><p>Book one</p></html>');
  document('audio', audioUrl, JSON.stringify(product));
});
afterEach(() => db.close());
describe('source-backed coverage export', () => {
  it('requires the retained exact audio product and uses its date rather than copied legacy dates', () => {
    expect(assess()).toMatchObject({ status: 'verified', verifiedAt: at, works: [{ releaseDate: '2026-08-01', editionIds: ['B000000001'] }] });
    db.prepare("UPDATE catalog_editions SET identifiers_json='{}'").run();
    expect(assess().issues.map(issue => issue.code)).toContain('missing-verified-audio');
  });
  it('does not publish an old good date when the verified product now has an unresolved date', () => {
    document('audio', audioUrl, JSON.stringify({ product: { ...product.product, release_date: '2200-01-01' } }));
    expect(assess().issues.map(issue => issue.code)).toContain('unknown-audio-date');
  });
  it('invalidates a reviewed bibliography when a different saved page has become the source head', () => {
    document('primary-new', primaryUrl, '<html><p>Now two books</p></html>');
    expect(assess().issues.map(issue => issue.code)).toContain('invalid-evidence');
  });
  it('accepts an unchanged observation but never refreshes evidence just because it was exported', () => {
    expect(assess('2026-09-27T04:00:00.000Z').status).toBe('stale');
    db.prepare('UPDATE catalog_urls SET checked_at=? WHERE url=?').run('2026-09-26T04:00:00.000Z', primaryUrl);
    expect(assess('2026-09-27T04:00:00.000Z')).toMatchObject({ status: 'verified', verifiedAt: '2026-09-26T04:00:00.000Z' });
  });
  it('rejects a changed author or corrupt evidence, and accepts a newer valid product head', () => {
    document('audio', audioUrl, JSON.stringify({ product: { ...product.product, authors: [{ name: 'Somebody Else' }] } }));
    expect(assess().status).toBe('incomplete');
    document('audio-new', audioUrl, JSON.stringify(product));
    expect(assess().status).toBe('verified');
    db.prepare("UPDATE catalog_documents SET body=body||'bad' WHERE id='primary'").run();
    expect(assess().issues.map(issue => issue.code)).toContain('invalid-evidence');
    document('primary', primaryUrl, JSON.stringify({ method: 'curated-source-summary', numbers: [1] }));
    expect(assess().issues.map(issue => issue.code)).toContain('invalid-evidence');
  });
  it('includes newly discovered later works rather than checking only the expected subset', () => {
    db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)').run('work-test-2', seed.id, 2, 'Test 2', seed.author, primaryUrl, at);
    expect(assess().issues.map(issue => issue.code)).toContain('unlisted-work');
  });
  it('uses the newest logical product across response-group URLs and never falls back to older good proof', () => {
    const newerUrl = 'https://api.audible.com/1.0/catalog/products/B000000001?response_groups=product_attrs,contributors,series';
    const later = '2026-09-19T05:00:00.000Z';
    document('new-product', newerUrl, JSON.stringify({ product: { ...product.product, series: [{ title: seed.title, sequence: '2' }] } }), later);
    expect(assess(later).issues.map(issue => issue.code)).toContain('missing-verified-audio');
    document('new-product', newerUrl, JSON.stringify({ product: { ...product.product, release_date: '2200-01-01' } }), later);
    expect(assess(later).issues.map(issue => issue.code)).toContain('unknown-audio-date');
    document('new-product', newerUrl, JSON.stringify({ product: { ...product.product, release_date: '2026-10-01' } }), later);
    expect(assess(later)).toMatchObject({ status: 'verified', releasedWorkIds: [], scheduledWorkIds: ['work-test-1'], works: [{ releaseDate: '2026-10-01' }] });
  });
  it('requires verification bound to the current canonical work identity',()=>{
    db.prepare("UPDATE catalog_works SET title='Different book with the same number'").run();
    expect(assess().issues.map(issue=>issue.code)).toContain('missing-verified-audio');
  });
});
