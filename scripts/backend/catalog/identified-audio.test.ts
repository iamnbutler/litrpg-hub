import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioProductUrl, audioWorkIdentity, processAudio } from './audio.js';
import { runCatalogGrind } from './grind.js';
import { enqueueIdentifiedAudioLeads, processIdentifiedAudio, verifyIdentifiedAudioProduct } from './identified-audio.js';
import { processSource, seedCatalog } from './pipeline.js';
import { hash } from './queue.js';
import { robotsAllowed, sourceUrl } from './sources.js';
import { ReviewError, type Document, type IdentifiedAudioPayload, type SeedSeries, type WorkRow } from './types.js';

const AT = '2026-09-19T04:00:00.000Z';
const AUTHOR_URL = 'https://sarahlinauthor.blogspot.com/p/the-weirkey-chronicles.html?m=0';
const ASIN = 'B000000001';
const seed: SeedSeries = { id: 'the-weirkey-chronicles', title: 'The Weirkey Chronicles', author: 'Sarah Lin',
  authorAliases: ['Sarah Lin'], aliases: ['Weirkey Chronicles'], genres: ['progression', 'cultivation'], priority: 1,
  sources: [{ url: AUTHOR_URL, adapter: 'sarah-lin-author' }] };
// Entirely synthetic source structure and product text; no copied author/publisher bodies.
const page = `<html><head><link rel="canonical" href="http://sarahlinauthor.blogspot.com/p/the-weirkey-chronicles.html"></head>
  <body><h1 class="title">Sarah Lin's Books</h1><article class="post hentry">
  <h3 class="post-title entry-title">The Weirkey Chronicles</h3><div class="post-body entry-content">
  <p>Books: <a href="https://www.amazon.com/dp/B000000099">Unnumbered ebook lead</a></p><h4>Audiobooks</h4>
  <p>Book 1: <a href="https://www.audible.com/pd/Invented-URL-Title/${ASIN}">Audio</a></p>
  <p>Book 2: Will be recorded!</p><h4>Description:</h4><p>Synthetic author-page copy that must never become a work description.</p>
  </div></article></body></html>`;
const product = { asin: ASIN, title: 'Synthetic Product Title', language: 'english', content_type: 'Product', format_type: 'unabridged',
  authors: [{ name: 'Sarah Lin' }], narrators: [{ name: 'Synthetic Narrator' }], series: [{ title: seed.title, sequence: '1' }],
  release_date: '2025-05-06', publication_datetime: '2020-01-01T00:00:00Z', runtime_length_min: 777,
  publisher_summary: '<p>Synthetic product description.</p><p>Verified source text for an imaginary book.</p>',
  merchandising_summary: 'Short synthetic listing.', product_images: { '500': 'https://example.com/synthetic-cover.jpg' } };
let db: Database.Database;
let discovery: Document;

function retain(url: string, body: string, cache = true): Document {
  const content_hash = hash(body), id = hash([url, content_hash]);
  const doc = { id, url, content_hash, body, fetched_at: AT };
  db.prepare('INSERT OR IGNORE INTO catalog_documents VALUES(?,?,?,?,?)').run(id, url, content_hash, body, AT);
  if (cache) db.prepare('INSERT OR REPLACE INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
    .run(url, id, AT, '2099-01-01T00:00:00.000Z');
  return doc;
}
function payload(): IdentifiedAudioPayload {
  enqueueIdentifiedAudioLeads(db, seed, discovery);
  const row = db.prepare("SELECT payload_json FROM catalog_jobs WHERE kind='identified-audio' ORDER BY id LIMIT 1").get() as { payload_json: string };
  return JSON.parse(row.payload_json) as IdentifiedAudioPayload;
}
function count(table: 'catalog_works' | 'catalog_editions' | 'books'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
const counts = () => [count('catalog_works'), count('catalog_editions'), count('books')];

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  for (const name of ['001_initial.sql', '006_catalog_pipeline.sql']) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id, seed.title, seed.author, AT);
  discovery = retain(AUTHOR_URL, page);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline tests must not make any live requests.'); }));
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('numbered author-link discovery dispatch', () => {
  it('finishes a cached source-to-identified-audio grind pass without any HTTP or paid handlers', async () => {
    seedCatalog(db, [seed], { includeIndexes: false });
    retain(audioProductUrl(ASIN), JSON.stringify({ product }));
    const report = await runCatalogGrind(db, { seriesId: seed.id, limits: { sources: 1, audio: 1 } }, { registry: [seed] });
    expect(report).toMatchObject({ completed: 2, errors: 0, tokens: { input_tokens: 0, output_tokens: 0 },
      stages: { sources: { completed: 1 }, audio: { completed: 1, remaining: { total: 0 } }, extract: { stopReason: 'disabled' }, assess: { stopReason: 'disabled' } } });
    expect(counts()).toEqual([1, 1, 1]);
    expect(db.prepare('SELECT kind,status FROM catalog_jobs ORDER BY kind').all()).toEqual([
      { kind: 'identified-audio', status: 'completed' }, { kind: 'source', status: 'completed' }
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('queues retained candidates through the source pipeline without creating a work or completeness claim', async () => {
    const source = { url: AUTHOR_URL, adapter: 'sarah-lin-author' as const, seriesId: seed.id };
    expect(seedCatalog(db, [seed], { includeIndexes: false })).toBe(1);
    expect(await processSource(db, source, [seed])).toEqual({ downloaded: false, leads: 1, queued: 1 });
    expect(await processSource(db, source, [seed])).toEqual({ downloaded: false, leads: 1, queued: 0 });
    expect(counts()).toEqual([0, 0, 0]);
    const lead = payload();
    expect(lead).toEqual({ adapter: 'sarah-lin-author', seriesId: seed.id, number: 1, asin: ASIN,
      url: `https://www.audible.com/pd/Invented-URL-Title/${ASIN}`, sourceUrl: AUTHOR_URL,
      sourceDocumentId: discovery.id, sourceContentHash: discovery.content_hash });
    expect(db.prepare('SELECT field,document_id,method FROM catalog_claims').all()).toEqual([
      { field: 'audioIdentifierCandidates', document_id: discovery.id, method: 'author-page' }
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('permits only the reviewed Sarah source paths while retaining ordinary robots enforcement', () => {
    expect(sourceUrl(AUTHOR_URL).href).toBe(AUTHOR_URL);
    expect(sourceUrl('https://sarahlinauthor.blogspot.com/p/street-cultivation.html').pathname).toBe('/p/street-cultivation.html');
    expect(sourceUrl('https://sarahlinauthor.blogspot.com/robots.txt').pathname).toBe('/robots.txt');
    for (const path of ['/search', '/p/other-series.html', '/p/street-cultivation.html?m=1', '/robots.txt?ignore=true']) {
      expect(() => sourceUrl(`https://sarahlinauthor.blogspot.com${path}`)).toThrow(ReviewError);
    }
    expect(() => sourceUrl(AUTHOR_URL.replace('sarahlinauthor', 'another-author'))).toThrow(ReviewError);
    const robots = 'User-agent: *\nDisallow: /search\nDisallow: /share-widget\nAllow: /\n';
    expect(robotsAllowed(robots, '/p/the-weirkey-chronicles.html?m=0')).toBe(true);
    expect(robotsAllowed(robots, '/search')).toBe(false);
  });

  it('does not accept an unretained or altered source as enqueue evidence', () => {
    expect(() => enqueueIdentifiedAudioLeads(db, seed, { ...discovery, id: 'missing' })).toThrow(ReviewError);
    expect(() => enqueueIdentifiedAudioLeads(db, seed, { ...discovery, content_hash: hash('other') })).toThrow(ReviewError);
    expect(() => enqueueIdentifiedAudioLeads(db, { ...seed, sources: [] }, discovery)).toThrow(ReviewError);
    expect(db.prepare('SELECT * FROM catalog_jobs').all()).toHaveLength(0);
  });
});

describe('identified audio promotion', () => {
  it('uses exact product title and description, retains both document proofs, and reuses its cached response', async () => {
    const lead = payload(), request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ product }), { headers: { 'content-type': 'application/json' } }));
    const first = await processIdentifiedAudio(db, lead, [seed], { request });
    expect(first).toMatchObject({ downloaded: true, work: `work-${seed.id}-1`, title: product.title, sourceDocumentId: discovery.id, sourceContentHash: discovery.content_hash });
    expect(await processIdentifiedAudio(db, lead, [seed], { request })).toMatchObject({ downloaded: false, work: first.work });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe(audioProductUrl(ASIN));
    expect(counts()).toEqual([1, 1, 1]);
    expect(db.prepare('SELECT title,author,description,source_description,source_url,first_release_date FROM catalog_works').get()).toEqual({
      title: product.title, author: 'Sarah Lin', description: '',
      source_description: 'Synthetic product description. Verified source text for an imaginary book.',
      source_url: audioProductUrl(ASIN), first_release_date: '2025-05-06'
    });
    const edition = db.prepare('SELECT identifiers_json,release_date,narrator,runtime_minutes FROM catalog_editions').get() as { identifiers_json: string };
    expect(edition).toMatchObject({ release_date: '2025-05-06', narrator: 'Synthetic Narrator', runtime_minutes: 777 });
    expect(JSON.parse(edition.identifiers_json)).toMatchObject({ asin: ASIN, marketplace: 'US', verifiedDocument: first.productDocumentId });
    const claim = db.prepare("SELECT value_json,document_id,observed_at,method FROM catalog_claims WHERE field='audioDiscovery'").get() as { value_json: string };
    expect(claim).toMatchObject({ document_id: discovery.id, observed_at: AT, method: 'author-page' });
    expect(JSON.parse(claim.value_json)).toMatchObject({ asin: ASIN, number: 1, sourceDocumentId: discovery.id, sourceContentHash: discovery.content_hash });
    expect(db.prepare("SELECT DISTINCT document_id,method FROM catalog_claims WHERE entity_type='work' AND field IN ('title','description','author')").all())
      .toEqual([{ document_id: first.productDocumentId, method: 'retailer-api' }]);
    expect(db.prepare("SELECT * FROM catalog_jobs WHERE kind='audio-edition'").all()).toHaveLength(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { number: 2 }, { asin: 'B000000002' }, { url: `https://www.audible.co.uk/pd/${ASIN}` },
    { url: `https://www.audible.com/pd/Other-Unobserved-Slug/${ASIN}` }, { sourceDocumentId: 'missing' },
    { sourceContentHash: hash('wrong') }, { adapter: 'aethon-series' }, { seriesId: 'other-series' }
  ])('rejects changed queued identity before any product request: %j', async changed => {
    const lead = { ...payload(), ...changed } as IdentifiedAudioPayload;
    await expect(processIdentifiedAudio(db, lead, [seed])).rejects.toThrow(ReviewError);
    expect(counts()).toEqual([0, 0, 0]); expect(fetch).not.toHaveBeenCalled();
  });

  it('rechecks source configuration and retained body integrity before any product request', async () => {
    const lead = payload();
    await expect(processIdentifiedAudio(db, lead, [{ ...seed, sources: [] }])).rejects.toThrow(/configured/);
    db.prepare('UPDATE catalog_documents SET body=? WHERE id=?').run(page.replace('Book 1:', 'Book 4:'), discovery.id);
    await expect(processIdentifiedAudio(db, lead, [seed])).rejects.toThrow(/content hash/);
    expect(counts()).toEqual([0, 0, 0]); expect(fetch).not.toHaveBeenCalled();
  });

  it('retains a wrong-volume exact response for review without creating canonical or edition rows', async () => {
    const lead = payload(), invalid = { ...product, series: [{ title: seed.title, sequence: '3' }] };
    const proof = retain(audioProductUrl(ASIN), JSON.stringify({ product: invalid }));
    await expect(processIdentifiedAudio(db, lead, [seed])).rejects.toThrow(ReviewError);
    expect(db.prepare('SELECT id FROM catalog_documents WHERE id=?').get(proof.id)).toEqual({ id: proof.id });
    expect(counts()).toEqual([0, 0, 0]); expect(fetch).not.toHaveBeenCalled();
  });

  it('does not use a cached product document belonging to another endpoint', async () => {
    const lead = payload(), proof = retain(audioProductUrl('B000000002'), JSON.stringify({ product }));
    db.prepare('INSERT OR REPLACE INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
      .run(audioProductUrl(ASIN), proof.id, AT, '2099-01-01T00:00:00.000Z');
    await expect(processIdentifiedAudio(db, lead, [seed])).rejects.toThrow(/US endpoint evidence/);
    expect(counts()).toEqual([0, 0, 0]); expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves unknown recording details null and does not borrow ebook or blog dates', async () => {
    const lead = payload();
    retain(audioProductUrl(ASIN), JSON.stringify({ product: { ...product, release_date: '2200-01-01', runtime_length_min: 0,
      narrators: [{ name: 'TBD' }, { name: ' ' }], publisher_summary: undefined, merchandising_summary: undefined } }));
    const result = await processIdentifiedAudio(db, lead, [seed]);
    await processAudio(db, { seriesId: seed.id, workId: result.work, asin: ASIN, sourceUrl: AUTHOR_URL }, [seed]);
    expect(db.prepare('SELECT first_release_date,publication_status,source_description FROM catalog_works').get())
      .toEqual({ first_release_date: null, publication_status: 'unknown', source_description: '' });
    expect(db.prepare('SELECT release_date,narrator,runtime_minutes FROM catalog_editions').get())
      .toEqual({ release_date: null, narrator: null, runtime_minutes: null });
    expect(db.prepare('SELECT release_date,narrator,runtime_minutes FROM books').get())
      .toEqual({ release_date: '', narrator: null, runtime_minutes: null });
    expect(db.prepare('SELECT next_check_at FROM catalog_urls WHERE url=?').get(audioProductUrl(ASIN)))
      .toEqual({ next_check_at: '2026-09-26T04:00:00.000Z' });
    const wire = db.prepare('SELECT raw_data FROM book_sources WHERE book_id=?').get(ASIN) as { raw_data: string };
    expect(JSON.parse(wire.raw_data)).toMatchObject({ release_date: '2200-01-01', runtime_length_min: 0, narrators: [{ name: 'TBD' }, { name: ' ' }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks a preorder by release day without making a cached observation newer', async () => {
    const lead = payload();
    retain(audioProductUrl(ASIN), JSON.stringify({ product: { ...product, release_date: '2026-09-21' } }));
    await processIdentifiedAudio(db, lead, [seed]);
    const due = () => db.prepare('SELECT next_check_at FROM catalog_urls WHERE url=?').get(audioProductUrl(ASIN));
    expect(due()).toEqual({ next_check_at: '2026-09-21T00:00:00.000Z' });
    vi.setSystemTime(new Date('2026-09-20T04:00:00Z'));
    await processIdentifiedAudio(db, lead, [seed]);
    expect(due()).toEqual({ next_check_at: '2026-09-21T00:00:00.000Z' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes old recording placeholders on a matched legacy edition while keeping valid earlier credits', async () => {
    const lead = payload();
    retain(audioProductUrl(ASIN), JSON.stringify({ product: { ...product, release_date: undefined, runtime_length_min: undefined, narrators: [] } }));
    db.prepare('INSERT INTO series(id,title,author) VALUES(?,?,?)').run('old-series', seed.title, seed.author);
    db.prepare('INSERT INTO books(id,title,author,series_id,series_number,release_date,narrator,runtime_minutes) VALUES(?,?,?,?,?,?,?,?)')
      .run(ASIN, product.title, seed.author, 'old-series', 1, '2200-01-01', 'TBD', 0);
    await processIdentifiedAudio(db, lead, [seed]);
    expect(db.prepare('SELECT release_date,narrator,runtime_minutes FROM catalog_editions').get())
      .toEqual({ release_date: null, narrator: null, runtime_minutes: null });
    expect(db.prepare('SELECT release_date,narrator,runtime_minutes FROM books').get())
      .toEqual({ release_date: '', narrator: null, runtime_minutes: null });
    db.prepare('UPDATE books SET release_date=?,narrator=?,runtime_minutes=? WHERE id=?').run('2025-01-01', 'Earlier Known Narrator', 500, ASIN);
    db.prepare('UPDATE catalog_editions SET release_date=?,narrator=?,runtime_minutes=? WHERE legacy_book_id=?').run('2025-01-01', 'Earlier Known Narrator', 500, ASIN);
    await processIdentifiedAudio(db, lead, [seed]);
    await processAudio(db, { seriesId: seed.id, workId: `work-${seed.id}-1`, asin: ASIN, sourceUrl: AUTHOR_URL }, [seed]);
    expect(db.prepare('SELECT release_date,narrator,runtime_minutes FROM catalog_editions').get())
      .toEqual({ release_date: '2025-01-01', narrator: 'Earlier Known Narrator', runtime_minutes: 500 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the actual product work credit distinct from the canonical series author name', async () => {
    const reviewed = { ...seed, authorAliases: ['Sarah Lin', 'S. Lin'], publisherCredits: ['Reviewed Publisher'] };
    const lead = payload();
    retain(audioProductUrl(ASIN), JSON.stringify({ product: { ...product, authors: [{ name: 'S. Lin' }, { name: 'Reviewed Publisher' }] } }));
    await processIdentifiedAudio(db, lead, [reviewed]);
    expect(db.prepare('SELECT author FROM catalog_works').get()).toEqual({ author: 'S. Lin' });
    expect(db.prepare('SELECT author FROM books').get()).toEqual({ author: 'S. Lin' });
    expect(db.prepare('SELECT author FROM series').get()).toEqual({ author: 'Sarah Lin' });
    expect(db.prepare('SELECT author FROM catalog_series').get()).toEqual({ author: 'Sarah Lin' });
  });

  it('does not replace an existing canonical title or author credit', async () => {
    const lead = payload(), workId = `work-${seed.id}-1`;
    retain(audioProductUrl(ASIN), JSON.stringify({ product }));
    db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,source_description,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(workId, seed.id, 1, 'An Incompatible Canonical Title', seed.author, AUTHOR_URL, 'Prior text.', AT);
    const before = db.prepare('SELECT * FROM catalog_works').get();
    await expect(processIdentifiedAudio(db, lead, [seed])).rejects.toThrow(/different titles/);
    expect(db.prepare('SELECT * FROM catalog_works').get()).toEqual(before);
    db.prepare('UPDATE catalog_works SET title=?,author=? WHERE id=?').run(product.title, 'Sarah Lin, Another Person', workId);
    const credited = db.prepare('SELECT * FROM catalog_works').get();
    await expect(processIdentifiedAudio(db, lead, [seed])).rejects.toThrow(ReviewError);
    expect(db.prepare('SELECT * FROM catalog_works').get()).toEqual(credited);
    expect(counts()).toEqual([1, 0, 0]);
  });

  it('rolls back work creation when an exact ASIN is already bound to another work', async () => {
    const lead = payload(), otherId = `work-${seed.id}-8`;
    retain(audioProductUrl(ASIN), JSON.stringify({ product }));
    db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(otherId, seed.id, 8, 'Other Canonical Work', seed.author, AUTHOR_URL, AT);
    db.prepare('INSERT INTO books(id,title,author,release_date) VALUES(?,?,?,?)').run(ASIN, 'Other Canonical Work', seed.author, '');
    db.prepare("INSERT INTO catalog_editions(id,work_id,legacy_book_id,format,title,source_url,source_name,updated_at) VALUES(?,?,?,'audiobook',?,?,'Audible',?)")
      .run(`edition-${ASIN}`, otherId, ASIN, 'Other Canonical Work', `https://www.audible.com/pd/${ASIN}`, AT);
    const prior = db.prepare('SELECT * FROM catalog_editions').all();
    await expect(processIdentifiedAudio(db, lead, [seed])).rejects.toThrow(/already attached/);
    expect(db.prepare('SELECT * FROM catalog_editions').all()).toEqual(prior);
    expect(db.prepare('SELECT id FROM catalog_works').all()).toEqual([{ id: otherId }]);
    expect(db.prepare("SELECT * FROM catalog_claims WHERE entity_type='work'").all()).toHaveLength(0);
  });

  it.each([
    {suffix:'Changed Canonical Credit',message:/Two different titles/},
    {suffix:'A Fantasy LitRPG Adventure',message:/binding needs an explicit review/}
  ])('preserves verified binding history after the canonical suffix changes to $suffix', async ({suffix,message}) => {
    const lead = payload(); retain(audioProductUrl(ASIN), JSON.stringify({ product }));
    const result = await processIdentifiedAudio(db, lead, [seed]);
    const prior = db.prepare('SELECT identifiers_json FROM catalog_editions').get() as { identifiers_json: string };
    const work = db.prepare('SELECT * FROM catalog_works').get() as WorkRow;
    expect(JSON.parse(prior.identifiers_json).workIdentityHash).toBe(audioWorkIdentity(work));
    db.prepare('UPDATE catalog_works SET title=? WHERE id=?').run(`${product.title}: ${suffix}`, result.work);
    await expect(processIdentifiedAudio(db, lead, [seed])).rejects.toThrow(message);
    expect(db.prepare('SELECT identifiers_json FROM catalog_editions').get()).toEqual(prior);
  });
});

describe('exact product identity requirements before canonical creation', () => {
  it.each([
    { asin: 'B000000002' }, { title: '' }, { language: 'german' }, { format_type: 'abridged' }, { content_type: 'Episode' },
    { authors: [{ name: 'Other Author' }] }, { authors: [{ name: 'Sarah Lin' }, { name: 'Other Author' }] }, { authors: [] },
    { series: [{ title: 'Other Series', sequence: '1' }] }, { series: [{ title: seed.title, sequence: '1-2' }] },
    { series: [{ title: seed.title, sequence: '1' }, { title: 'Weirkey Chronicles', sequence: '2' }] },
    { title: 'Synthetic Books 1–3' }, { title: 'Synthetic Collection' }, { subtitle: 'Dramatized Adaptation' },
    { subtitle: 'A GraphicAudio Production' }, { subtitle: 'Audio Drama' }, { subtitle: 'Short Stories' },
    { authors: 'Sarah Lin' }, { series: [{ title: seed.title, sequence: 1 }] }, { publisher_summary: { wrong: 'shape' } }
  ])('requires exact identity and a standard full audiobook: %j', changed => {
    expect(() => verifyIdentifiedAudioProduct({ product: { ...product, ...changed } }, ASIN, seed, 1)).toThrow(ReviewError);
  });

  it('uses a full person set rather than allowing a coauthor subset or conflating distinct names', () => {
    const joint = { ...seed, author: 'Sarah Lin, Co Author', authorAliases: ['Sarah Lin', 'Co Author'],
      authorIdentities: [{ name: 'Sarah Lin', aliases: [] }, { name: 'Co Author', aliases: [] }] };
    expect(() => verifyIdentifiedAudioProduct({ product }, ASIN, joint, 1)).toThrow(/author credits/);
    expect(() => verifyIdentifiedAudioProduct({ product: { ...product, authors: [{ name: 'Co Author' }] } }, ASIN, joint, 1)).toThrow(/author credits/);
    expect(() => verifyIdentifiedAudioProduct({ product: { ...product, authors: [{ name: 'Co Author' }, { name: 'Sarah Lin' }] } }, ASIN, joint, 1)).not.toThrow();
    // This bounded discovery adapter still refuses other series/coauthor rosters.
    expect(() => enqueueIdentifiedAudioLeads(db, joint, discovery)).toThrow(ReviewError);
  });

  it('accepts reviewed person aliases and series aliases without treating publishers as people', () => {
    const reviewed = { ...seed, authorAliases: ['Sarah Lin', 'S. Lin'], publisherCredits: ['Reviewed Publisher'] };
    const productWithAliases = { ...product, authors: [{ name: 'S. Lin' }, { name: 'Reviewed Publisher' }], series: [{ title: 'Weirkey Chronicles', sequence: '1' }] };
    expect(() => verifyIdentifiedAudioProduct({ product: productWithAliases }, ASIN, reviewed, 1)).not.toThrow();
    expect(() => verifyIdentifiedAudioProduct({ product: productWithAliases }, ASIN, { ...reviewed, publisherCredits: [] }, 1)).toThrow(ReviewError);
  });
});
