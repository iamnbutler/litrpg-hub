import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_TAXONOMY_VERSION, tasteLabels } from '../../../src/lib/catalog.js';
import type { WorkHealth } from '../../../src/lib/catalog-health.js';
import { coverCacheKey, coverModel, COVER_RUBRIC_VERSION } from '../covers/vision.js';
import { assessmentHash } from '../jev/assessment.js';
import { exportHealth } from '../exporters/health.js';
import { audioProductUrl, audioWorkIdentity } from './audio.js';
import type { AudioManifestSpec } from './coverage-store.js';
import type { EditorialReview } from './editorial.js';
import { extractionHash, extractionInput, profileInput } from './inference.js';
import { buildCatalogHealth, type CatalogHealthOptions } from './health.js';
import { hash } from './queue.js';
import { observationInput, readerEvidenceFor, readerState, readerTraitHash, readerTraits, READER_RUBRIC_VERSION, traitInput } from './reader-evidence.js';
import type { SeedSeries, WorkRow } from './types.js';

const at = '2026-09-19T12:00:00.000Z';
const primaryUrl = 'https://publisher.example/series/test/';
const seed: SeedSeries = { id: 'test', title: 'Test Series', author: 'A. Writer', authorAliases: [], aliases: [], genres: ['litrpg'],
  priority: 1, sources: [{ url: primaryUrl, adapter: 'aethon-series' }] };
const privateDescription = 'PRIVATE_SOURCE_TEXT: The traveler and her companion venture into a dungeon, where they make equipment together and must cooperate to survive the changing traps.';
const synopsis = 'Two companions explore an unfamiliar underground complex. They make their equipment and cooperate to stay alive while finding a route through the traps.';
const imageUrl = 'https://images.example/test.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let db: Database.Database, directory: string;
const network = vi.fn(() => { throw new Error('Network calls are forbidden in health checks.'); });

function schema(database: Database.Database) {
  const folder = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) database.exec(readFileSync(new URL(name, folder), 'utf8'));
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'catalog-health-'));
  db = new Database(':memory:'); schema(db);
  db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id, seed.title, seed.author, at);
  network.mockClear(); vi.stubGlobal('fetch', network);
});
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); db.close(); rmSync(directory, { recursive: true, force: true }); });

function work(number = 1, patch: Partial<WorkRow> = {}): WorkRow {
  const row: WorkRow = { id: `work-test-${number}`, series_id: seed.id, number, title: `Test Series ${number}`, author: seed.author,
    description: '', source_description: privateDescription, source_url: primaryUrl, cover_url: null,
    publication_status: 'released', first_release_date: '2025-01-01', metadata_json: null, assessment_json: null, updated_at: at, ...patch };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO catalog_works(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...Object.values(row));
  return row;
}
function document(id: string, url: string, body: string, observedAt = at, head = true) {
  db.prepare('INSERT OR REPLACE INTO catalog_documents(id,url,content_hash,body,fetched_at) VALUES(?,?,?,?,?)').run(id, url, hash(body), body, observedAt);
  if (head) db.prepare('INSERT OR REPLACE INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)').run(url, id, observedAt, '2026-10-01T00:00:00.000Z');
}
function edition(row: WorkRow, format: 'ebook' | 'print' | 'audiobook' | 'dramatized', patch: Record<string, unknown> = {}) {
  const fields = { id: `edition-${row.id}-${format}`, work_id: row.id, legacy_book_id: null, format, title: row.title,
    source_url: primaryUrl, source_name: 'Test publisher', release_date: '2025-01-01', cover_url: null, narrator: null,
    runtime_minutes: null, identifiers_json: '{}', updated_at: at, ...patch };
  db.prepare(`INSERT INTO catalog_editions(${Object.keys(fields).join(',')}) VALUES(${Object.keys(fields).map(() => '?').join(',')})`).run(...Object.values(fields));
}
function audio(row: WorkRow, patch: Record<string, unknown> = {}, observedAt = at, asin = `B${String(row.number).padStart(9, '0')}`) {
  const url = audioProductUrl(asin), id = `product-${asin}`;
  const product = { asin, title: row.title, language: 'english', content_type: 'Product', format_type: 'unabridged',
    authors: [{ name: row.author }], series: [{ title: seed.title, sequence: String(row.number) }],
    release_date: '2026-08-01', narrators: [{ name: 'A. Narrator' }], runtime_length_min: 600, publisher_summary: 'PRIVATE_RETAILER_RAW', ...patch };
  document(id, url, JSON.stringify({ product }), observedAt);
  db.prepare('INSERT INTO books(id,title,author,release_date) VALUES(?,?,?,?)').run(asin, row.title, row.author, '2020-01-01');
  edition(row, 'audiobook', { id: `edition-${asin}`, legacy_book_id: asin, source_url: `https://www.audible.com/pd/${asin}`, release_date: '2020-01-01',
    narrator: 'Copied narrator', runtime_minutes: 300,
    identifiers_json: JSON.stringify({ asin, marketplace: 'US', verifiedDocument: id, workIdentityHash: audioWorkIdentity(row) }) });
  return { asin, url, id, product };
}
function inference(entityType: string, id: string, kind: string, inputHash: string, result: unknown) {
  db.prepare('INSERT INTO catalog_inferences VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(hash([entityType, id, kind, inputHash]), entityType, id, kind,
    inputHash, 'fixture-model', 'fixture-model', 'fixture-rubric', JSON.stringify(result), '{}', at);
}
function extraction(row: WorkRow): EditorialReview {
  const input = extractionInput(row), inputHash = extractionHash(input);
  const result = { synopsis, features: [{ tag: 'dungeon', evidence: 'venture into a dungeon' }] };
  inference('work', row.id, 'extract', inputHash, result);
  db.prepare('UPDATE catalog_works SET description=?,metadata_json=? WHERE id=?').run(synopsis, JSON.stringify({ ...result, inputHash }), row.id);
  return { entityType: 'work', entityId: row.id, inputHash, evidenceHash: hash(input), taxonomyVersion: FEATURE_TAXONOMY_VERSION,
    reviewedAt: at, sourceUrl: row.source_url, allowedFeatures: ['dungeon'], reviewNote: 'Fixture source-bound review.' };
}
function readers(row: WorkRow, count: number, start = 0) {
  for (let index = start; index < start + count; index++) db.prepare(`INSERT INTO catalog_reader_evidence
    (id,series_id,work_id,source_url,external_id,body,contains_spoilers,observed_at,source_name,author_key)
    VALUES(?,?,?,?,?,?,0,?,'hardcover.app',?)`).run(`reader-${index}`, row.series_id, row.id, 'https://hardcover.app/books/test', String(index),
      `PRIVATE_READER_BODY_${index}: This discussion considers the pacing and character interactions in enough detail to meet the minimum sample length.`, at, `PRIVATE_READER_IDENTITY_${index}`);
}
function readerTraitsFor(row: WorkRow) {
  const selected = readerEvidenceFor(db, 'work', row.id), inputHash = readerTraitHash(readerState(selected));
  for (const trait of readerTraits) db.prepare(`INSERT INTO catalog_reader_traits
    (id,entity_type,entity_id,trait,value,confidence,model_confidence,consensus,summary,voices,samples,evidence_json,input_hash,requested_model,model,rubric_version,evaluated_at)
    VALUES(?,'work',?,?,'unknown',.5,.5,'mixed','PRIVATE_TRAIT_TEXT',5,5,?,?,?,'fixture-model',?,?)`)
    .run(`${row.id}-${trait}`, row.id, trait, JSON.stringify({ evidenceIds: traitInput(selected).map(row => row.id), consensus: 'mixed' }), inputHash, process.env.JEV_MODEL ?? 'jev-latest', READER_RUBRIC_VERSION, at);
}
function cover(bytes = png, observation = false) {
  const imageHash = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(directory, `${imageHash}.png`), bytes);
  db.prepare('INSERT OR REPLACE INTO cover_image_sources VALUES(?,?,?)').run(imageUrl, imageHash, at);
  if (observation) {
    const key = coverCacheKey(imageHash);
    db.prepare('INSERT INTO cover_observations VALUES(?,?,?,?,?,?,?,?)').run(key, imageHash, coverModel(), coverModel(), COVER_RUBRIC_VERSION,
      JSON.stringify({ level: 'none', confidence: .9, observations: ['PRIVATE_COVER_MODEL_PROSE'] }), '{}', at);
    db.prepare('INSERT INTO cover_sources VALUES(?,?,?)').run(imageUrl, key, at);
  }
  return imageHash;
}
const report = (options: CatalogHealthOptions = {}, now = at) => buildCatalogHealth(db, new Date(now), { registry: [seed], manifests: [], reviews: [], assetDirectory: directory, ...options });
const find = (row: WorkHealth, id: string) => row.checks.find(item => item.id === id)!;

describe('public catalog data health', () => {
  it('includes every canonical work and series even with no audio, and never borrows print dates or cover URLs as assets', () => {
    const first = work(1, { cover_url: imageUrl }); edition(first, 'ebook');
    work(3, { source_description: '' });
    db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run('empty', 'An Empty Series', 'B. Writer', at);
    const result = report();
    expect(result.totals).toMatchObject({ works: 2, series: 2, confirmedAudioWorks: 0, verifiedAudioDates: 0, coverAssets: 0 });
    const row = result.works[0];
    expect(row.audio).toEqual({ retainedEditionCount: 0, confirmedEditionCount: 0, state: 'none', releaseDate: null });
    expect(row.flags).toMatchObject({ audiobook: false, audioVerified: false, coverAsset: false });
    expect(find(row, 'audio-date')).toMatchObject({ status: 'missing', available: false });
    expect(find(row, 'cover-url').status).toBe('present');
    expect(find(row, 'cover-asset').status).toBe('missing');
    expect(result.series.find(row => row.id === 'test')!.missingVolumes).toEqual([expect.objectContaining({ number: 2, evidence: 'observed-numbering', status: 'unknown' })]);
    expect(result.series.every(row => row.bibliography.status === 'unknown')).toBe(true);
    expect(result.series.find(row => row.id === 'empty')!.knownWorks).toBe(0);
  });

  it('uses current exact-product facts without requiring a complete bibliography and rejects a newer conflicting title', () => {
    const first = work(), product = audio(first);
    let row = report().works[0];
    expect(row.audio).toMatchObject({ confirmedEditionCount: 1, state: 'released', releaseDate: '2026-08-01' });
    expect(find(row, 'narrator').status).toBe('present');
    expect(find(row, 'runtime').status).toBe('present');
    expect(report().series[0].bibliography.audioCoverageStatus).toBe('unknown');
    const newUrl = `https://api.audible.com/1.0/catalog/products/${product.asin}?response_groups=series`;
    document('new-product', newUrl, JSON.stringify({ product: { ...product.product, title: 'A Different Adventure' } }), '2026-09-19T12:30:00.000Z');
    row = report({}, '2026-09-19T13:00:00.000Z').works[0];
    expect(row.audio).toMatchObject({ confirmedEditionCount: 0, state: 'unverified', releaseDate: null });
    expect(find(row, 'audio-date').status).toBe('unknown');
  });

  it('keeps old released observations durable but expires preorders independently from bibliography freshness', () => {
    const first = work(1), second = work(2), third = work(3);
    audio(first, { release_date: '2026-01-01' }, '2026-02-01T00:00:00.000Z');
    audio(second, { release_date: '2026-10-01' }, '2026-09-01T00:00:00.000Z');
    audio(third, { release_date: '2026-09-18' }, '2026-09-17T00:00:00.000Z');
    const result = report();
    expect(result.works[0].audio).toMatchObject({ state: 'released', releaseDate: '2026-01-01' });
    for (const row of result.works.slice(1)) {
      expect(row.audio).toMatchObject({ confirmedEditionCount: 1, state: 'undated', releaseDate: null });
      expect(find(row, 'audio-date').status).toBe('stale');
    }
    expect(result.totals.verifiedAudioDates).toBe(1);
  });

  it('keeps unknown audio dates and placeholder credits visible even when copied rows contain old values', () => {
    const first = work(); audio(first, { release_date: '2200-01-01', narrators: [{ name: 'TBA' }], runtime_length_min: 0 });
    const row = report().works[0];
    expect(row.audio).toMatchObject({ state: 'undated', releaseDate: null, confirmedEditionCount: 1 });
    expect(find(row, 'audio-date').status).toBe('missing');
    expect(find(row, 'narrator').status).toBe('unknown');
    expect(find(row, 'runtime').status).toBe('unknown');
  });

  it('does not let a fresh alternate preorder hide an undated recording, while a proven released recording remains sufficient', () => {
    const first = work(); audio(first, { release_date: '2026-10-01' });
    const alternate = audio(first, { release_date: '2200-01-01' }, at, 'B000000099');
    let row = report().works[0];
    expect(row.audio).toMatchObject({ confirmedEditionCount: 2, state: 'undated', releaseDate: null });
    expect(find(row, 'audio-date').status).toBe('missing');
    document(alternate.id, alternate.url, JSON.stringify({ product: { ...alternate.product, release_date: '2025-01-01' } }));
    row = report().works[0];
    expect(row.audio).toMatchObject({ confirmedEditionCount: 2, state: 'released', releaseDate: '2025-01-01' });
  });

  it('requires a selected identity and current canonical binding, not a generic publisher edition or duplicate seed', () => {
    const first = work(); audio(first);
    expect(report({ registry: [] }).totals.confirmedAudioWorks).toBe(0);
    expect(report({ registry: [seed, seed] }).totals.confirmedAudioWorks).toBe(0);
    db.prepare("UPDATE catalog_works SET author='An Unmapped Coauthor'").run();
    expect(report().totals.confirmedAudioWorks).toBe(0);
    const second = work(2); edition(second, 'audiobook');
    document('publisher', primaryUrl, '<html><h1>Audio bibliography</h1></html>');
    expect(report().totals.confirmedAudioWorks).toBe(0);
  });

  it('separates extracted candidates from reviewed metadata and preserves source-bound review across model-only cache changes', () => {
    const first = work(), review = extraction(first);
    let row = report().works[0];
    expect(row.flags).toMatchObject({ summary: true, metadataExtracted: true, metadataReviewed: false });
    expect(find(row, 'reviewed-metadata').status).toBe('missing');
    vi.stubEnv('CATALOG_OPENAI_MODEL', 'a-future-fixture-model');
    try {
      row = report({ reviews: [review] }).works[0];
      expect(row.flags).toMatchObject({ summary: true, metadataExtracted: true, metadataReviewed: true });
      expect(find(row, 'extracted-metadata').explanation).toContain('does not require another purchase');
      db.prepare("UPDATE catalog_works SET source_description=source_description||' New source facts.'").run();
      row = report({ reviews: [review] }).works[0];
      expect(find(row, 'reviewed-metadata').status).toBe('stale');
      expect(row.flags.metadataReviewed).toBe(false);
      expect(find(row, 'extracted-metadata').status).toBe('stale');
    } finally { vi.unstubAllEnvs(); }
  });

  it('treats a current Jev result as cached metadata, never book quality, and invalidates changed inputs', () => {
    const first = work();
    const signal = { verdict: 'unknown', confidence: .2, source: 'jev', note: 'PRIVATE_JEV_NOTES' };
    const assessment = { model: 'fixture-model', inputHash: assessmentHash(profileInput(first, seed)), evaluatedAt: at,
      genre: { value: 'litrpg', confidence: .9 }, taste: Object.fromEntries(Object.keys(tasteLabels).map(key => [key, { value: .5, confidence: .8 }])),
      explicit: signal, harem: signal, quality: { ...signal, verdict: 'present', confidence: .99 } };
    db.prepare('UPDATE catalog_works SET assessment_json=?').run(JSON.stringify(assessment));
    const before = report().works[0];
    expect(find(before, 'jev-assessment').status).toBe('present');
    db.prepare("UPDATE catalog_works SET source_description=source_description||' New evidence.'").run();
    const after = report().works[0];
    expect(find(after, 'jev-assessment').status).toBe('stale');
    expect(after.evidenceQuality.percent).toBe(before.evidenceQuality.percent);
    expect(JSON.stringify(report())).not.toContain('PRIVATE_JEV_NOTES');
  });

  it('counts the exact selected reader sample and keeps per-volume coverage separate from series comments', () => {
    const first = work(1); work(2); readers(first, 8);
    db.prepare("UPDATE catalog_reader_evidence SET author_key='PRIVATE_READER_IDENTITY_0' WHERE id='reader-1'").run();
    db.prepare("UPDATE catalog_reader_evidence SET contains_spoilers=1 WHERE id='reader-2'").run();
    db.prepare("UPDATE catalog_reader_evidence SET body='<span class=spoiler>A detailed hidden plot event that should not be selected for this sample.</span>' WHERE id='reader-3'").run();
    db.prepare("UPDATE catalog_reader_evidence SET body=(SELECT body FROM catalog_reader_evidence WHERE id='reader-0') WHERE id='reader-4'").run();
    const result = report(), row = result.works[0];
    expect(row.reader).toMatchObject({ retainedCount: 8, selectedCount: 4, eligible: false, currentTraits: false });
    expect(find(row, 'reader-adequacy').status).toBe('unknown');
    expect(result.works[1].reader.selectedCount).toBe(0);
    expect(result.series[0].checks.find(item => item.id === 'reader-sample')!.explanation).toContain('1/2 works');
    expect(result.series[0].issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'reader-sample:missing' }), expect.objectContaining({ code: 'reader-adequacy:unknown' })]));
  });

  it('uses the selected cap, current trait hashes, and original publishable observation status without exposing prose', () => {
    const first = work(); readers(first, 5); readerTraitsFor(first);
    const rows = readerEvidenceFor(db, 'work', first.id);
    const inputHash = observationInput(db, 'work', first.id, rows).inputHash;
    const original = 'Character exchanges drew praise in these comments, while the deliberate scene transitions prompted reservations about the pace.';
    inference('reader', `work:${first.id}`, 'reader-observation', inputHash, { observation: original, grounded: true });
    let row = report().works[0];
    expect(row.reader).toMatchObject({ selectedCount: 5, eligible: true, currentTraits: true, observation: 'published' });
    expect(find(row, 'reader-observation')).toMatchObject({ status: 'present', available: true });
    expect(JSON.stringify(report())).not.toContain(original);
    readers(first, 60, 5);
    row = report().works[0];
    expect(row.reader).toMatchObject({ retainedCount: 65, selectedCount: 60, currentTraits: false, observation: 'missing' });
    expect(find(row, 'reader-observation').status).toBe('stale');
  });

  it.each([
    "value='invented'", "confidence=2", "model_confidence=-1", "consensus='invented'", "voices=500", "samples=500", "evidence_json='{}'", "summary=''"
  ])('does not award current evidence for a malformed reader-trait projection: %s', mutation => {
    const first = work(); readers(first, 5); readerTraitsFor(first);
    expect(report().works[0].reader.currentTraits).toBe(true);
    // Simulate a retained corrupt/migrated cache; normal SQL constraints prevent some of these.
    db.pragma('ignore_check_constraints=ON');
    db.exec(`UPDATE catalog_reader_traits SET ${mutation} WHERE trait='pacing-slow'`);
    const row = report().works[0];
    expect(row.reader.currentTraits).toBe(false);
    expect(find(row, 'reader-traits').status).toBe('unknown');
  });

  it('requires actual matching image bytes and a current observation rather than an image link or stale image head', () => {
    work(1, { cover_url: imageUrl });
    expect(report().works[0].cover.cached).toBe(false);
    const imageHash = cover(png, true);
    let row = report().works[0];
    expect(row.cover).toMatchObject({ cached: true, hashVerified: true, bytes: png.length, observationCurrent: true });
    expect(find(row, 'cover-observation').status).toBe('present');
    db.prepare('UPDATE cover_image_sources SET image_hash=?').run('a'.repeat(64));
    row = report().works[0];
    expect(row.cover).toMatchObject({ cached: false, observationCurrent: false });
    expect(find(row, 'cover-observation').status).toBe('stale');
    db.prepare('UPDATE cover_image_sources SET image_hash=?').run(imageHash);
    writeFileSync(join(directory, `${imageHash}.png`), Buffer.from('corrupted'));
    expect(find(report().works[0], 'cover-asset').status).toBe('unknown');
  });

  it('rejects HTML bytes with an image extension even if their checksum is correct, and marks old observations stale', () => {
    work(1, { cover_url: imageUrl }); cover(Buffer.from('<html>This is an error response, not a cover image.</html>'));
    expect(report().works[0].cover.cached).toBe(false);
    expect(find(report().works[0], 'cover-asset').status).toBe('unknown');
    cover(png, true);
    const later = report({}, '2026-10-21T12:00:00.000Z').works[0];
    expect(later.cover.cached).toBe(true);
    expect(later.cover.observationCurrent).toBe(false);
    expect(find(later, 'cover-observation').status).toBe('stale');
  });

  it('can use a cached verified recording cover without borrowing one from an unverified edition', () => {
    const first = work(1, { cover_url: 'https://publisher.example/uncached.jpg' });
    cover(); edition(first, 'audiobook', { cover_url: imageUrl });
    expect(report().works[0].cover.cached).toBe(false);
    db.prepare('DELETE FROM catalog_editions').run();
    audio(first, { product_images: { '500': imageUrl } });
    expect(report().works[0].cover).toMatchObject({ cached: true, url: imageUrl });
  });

  it('proves expected missing slots only from a retained reviewed bibliography, and invalidates a changed page head', () => {
    work(1); work(3);
    document('primary', primaryUrl, '<html><h1>Test Series</h1><p>Volumes 1, 2, 3</p></html>');
    const manifest: AudioManifestSpec = { id: 'test-manifest', seriesId: seed.id, scope: 'numbered-mainline', language: 'English', marketplaces: ['US'],
      expectedNumbers: [1, 2, 3], reviewedAt: at, audioCatalogState: 'ongoing', bibliography: [{ documentId: 'primary', url: primaryUrl, sourceType: 'publisher' }] };
    let result = report({ manifests: [manifest] }).series[0];
    expect(result.bibliography).toMatchObject({ status: 'present', audioCoverageStatus: 'incomplete', expectedNumbers: [1, 2, 3], missingWorkNumbers: [2] });
    expect(result.missingVolumes[0]).toMatchObject({ number: 2, evidence: 'reviewed-bibliography', status: 'missing' });
    result = report({ manifests: [manifest] }, '2026-09-27T12:00:00.000Z').series[0];
    expect(result.missingVolumes[0].status).toBe('stale');
    document('new-primary', primaryUrl, '<html><p>A revised bibliography requires another review.</p></html>');
    result = report({ manifests: [manifest] }).series[0];
    expect(result.bibliography).toMatchObject({ status: 'unknown', expectedNumbers: [], missingWorkNumbers: [] });
    expect(result.missingVolumes[0]).toMatchObject({ evidence: 'observed-numbering', status: 'unknown' });
  });

  it('does not count retained curated notes as fetched primary pages, but shares exact audio query variants', () => {
    const first = work(1, { source_url: 'https://api.audible.com/1.0/catalog/products/B000000001' });
    audio(first);
    document('note', primaryUrl, JSON.stringify({ method: 'curated-source-summary', privateNote: 'PRIVATE_RESEARCH_NOTE' }), at, false);
    const result = report();
    expect(result.works[0].sources).toEqual([expect.objectContaining({ url: first.source_url, status: 'present', checkedAt: at })]);
    expect(result.series[0].sources.find(item => item.url === primaryUrl)!.status).toBe('unknown');
  });

  it('exports only closed safe summaries, never source text, reader identities, model payloads, secrets in URLs, or private paths', () => {
    const secretSource = 'https://publisher.example/book?token=PRIVATE_QUERY_SECRET#PRIVATE_FRAGMENT';
    const first = work(1, { source_url: secretSource }); extraction(first); readers(first, 5); readerTraitsFor(first);
    document('raw-source', secretSource, '<html>PRIVATE_DOCUMENT_CONTAINER</html>');
    db.prepare("UPDATE catalog_works SET cover_url='file:///Users/private-person/secret-cover.png'").run();
    const serialized = JSON.stringify(report());
    for (const forbidden of ['PRIVATE_', '/Users/', 'author_key', 'result_json', 'source_description', 'observation_json', 'external_id', 'inputHash', 'content_hash', 'response_text', 'token=']) expect(serialized).not.toContain(forbidden);
    expect(serialized).toContain('https://publisher.example/book');
    expect(report().works[0].cover.url).toBeNull();
  });

  it('keeps scoring reproducible and rolls up all canonical members rather than only the verified audio subset', () => {
    const first = work(1); audio(first); work(2, { source_description: '' });
    const result = report();
    for (const row of result.works) for (const score of [row.completeness, row.evidenceQuality]) {
      expect(score.percent).toBe(Math.round(100 * score.earned / score.possible));
      expect(Number.isFinite(score.percent)).toBe(true);
    }
    expect(result.series[0].workIds).toEqual(['work-test-1', 'work-test-2']);
    expect(result.series[0].completeness.possible).toBe(23);
    expect(result.series[0].evidenceQuality.possible).toBe(20);
    expect(result.series[0].checks.find(item => item.id === 'audio-verified')!.explanation).toContain('1/2 works');
  });

  it('reads an existing database without changing it and exports safe JSON without migrations or fetching', () => {
    const databasePath = join(directory, 'fixture.db'), outputPath = join(directory, 'health.json');
    const fileDb = new Database(databasePath); schema(fileDb);
    fileDb.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id, seed.title, seed.author, at);
    fileDb.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,1,?,?,?,?)').run('test-1', seed.id, 'Test Series 1', seed.author, primaryUrl, at);
    fileDb.close();
    const bytes = readFileSync(databasePath);
    const result = exportHealth({ databasePath, outputPath, now: new Date(at), registry: [], manifests: [], reviews: [], assetDirectory: directory });
    expect(result.totals).toMatchObject({ series: 1, works: 1 });
    expect(JSON.parse(readFileSync(outputPath, 'utf8')).schemaVersion).toBe(1);
    expect(readFileSync(databasePath).equals(bytes)).toBe(true);
    expect(() => exportHealth({ databasePath, outputPath: databasePath })).toThrow(/separate/);
    expect(readFileSync(databasePath).equals(bytes)).toBe(true);
  });

  it.each([false, true])('preserves the known-good output for an empty canonical database (series row present: %s)', withSeries => {
    const databasePath = join(directory, 'empty.db'), outputPath = join(directory, 'health.json');
    const fileDb = new Database(databasePath); schema(fileDb);
    if (withSeries) fileDb.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id, seed.title, seed.author, at);
    fileDb.close();
    const previous = '{"previous":"known-good-report"}\n'; writeFileSync(outputPath, previous);
    expect(() => exportHealth({ databasePath, outputPath, now: new Date(at) })).toThrow(/empty canonical catalog/);
    expect(readFileSync(outputPath, 'utf8')).toBe(previous);
    expect(readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(false);
  });
});
