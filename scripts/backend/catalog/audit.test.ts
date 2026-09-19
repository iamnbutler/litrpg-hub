import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditCatalog } from './audit.js';
import { assessmentHash } from '../jev/assessment.js';
import { extractionHash, extractionInput, profileInput } from './inference.js';
import { audioProductUrl, audioWorkIdentity } from './audio.js';
import { hash } from './queue.js';
import type { Document, SeedSeries, WorkRow } from './types.js';

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
function document(id: string, url: string, fetchedAt = '2026-09-01T12:00:00.000Z', body='PRIVATE_RAW_PAGE'):Document {
  const content_hash=hash(body);
  db.prepare('INSERT INTO catalog_documents(id,url,content_hash,body,fetched_at) VALUES(?,?,?,?,?)').run(id, url, content_hash, body, fetchedAt);
  return {id,url,content_hash,body,fetched_at:fetchedAt};
}
function edition(id: string, workId: string, format: string, date: string | null, legacyId: string | null = null, verifiedDocument?: string) {
  const url = legacyId?`https://www.audible.com/pd/${legacyId}`:`https://soundbooththeater.com/shop/audiobooks/${id}/`;
  if (legacyId) db.prepare('INSERT INTO books(id,title,author,release_date) VALUES(?,?,?,?)').run(legacyId, id, seed.author, date ?? '');
  else document(id, url);
  const row=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
  db.prepare('INSERT INTO catalog_editions(id,work_id,legacy_book_id,format,title,source_url,source_name,release_date,identifiers_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, workId, legacyId, format, id, url, legacyId ? 'Audible' : 'Soundbooth Theater', date,
      JSON.stringify(verifiedDocument ? { verifiedDocument,asin:legacyId,marketplace:'US',workIdentityHash:audioWorkIdentity(row) } : {}), now.toISOString());
}
function exactProduct(workId:string,asin:string,changed:Record<string,unknown>={},id=`product-${asin}`,url=audioProductUrl(asin),fetchedAt='2026-09-01T12:00:00.000Z'):Document {
  const row=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
  const product={asin,title:row.title,language:'english',content_type:'Product',format_type:'unabridged',authors:[{name:row.author}],
    series:[{title:seed.title,sequence:String(row.number)}],release_date:'2025-01-01',publisher_summary:'PRIVATE_RAW_PAGE',...changed};
  const doc=document(id,url,fetchedAt,JSON.stringify({product}));
  db.prepare('INSERT OR REPLACE INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
    .run(url,id,fetchedAt,'2026-09-25T00:00:00.000Z');
  return doc;
}
function verifiedEdition(id:string,workId:string,date:string|null,asin:string):Document {
  const doc=exactProduct(workId,asin,{release_date:date??undefined});
  edition(id,workId,'audiobook',date,asin,doc.id);
  return doc;
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
    verifiedEdition('audio-3', three, null, 'B000000003');
    verifiedEdition('audio-4', four, '2026-12-01', 'B000000004');
    verifiedEdition('audio-5', five, '2025-01-01', 'B000000005');
    verifiedEdition('audio-5-new-performance', five, '2027-01-01', 'B000000015');
    const report = auditCatalog(db, now, [seed]).series[0];
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
    verifiedEdition('legacy-3',three,null,'B000000003');
    const report = auditCatalog(db, now, [seed]).series[0];
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

describe('current exact audio confirmation',()=>{
  it('uses reviewed series aliases, author identities, and publisher credits without weakening work authorship',()=>{
    const id=work(1),asin='B000000001';
    const selected:SeedSeries={...seed,author:'Test Author, Co Author',aliases:['Test Series Audio'],authorAliases:['Test Author','Pen Name','Co Author'],
      authorIdentities:[{name:'Test Author',aliases:['Test Author','Pen Name']},{name:'Co Author',aliases:['Co Author']}],publisherCredits:['Synthetic Press']};
    const doc=exactProduct(id,asin,{series:[{title:'Test Series Audio',sequence:'1'}],authors:[{name:'Pen Name'},{name:'Synthetic Press'}]});
    edition('verified',id,'audiobook','2025-01-01',asin,doc.id);
    db.pragma('query_only = ON');
    expect(auditCatalog(db,now,[selected]).totals.confirmedAudiobookWorks).toBe(1);
    expect(auditCatalog(db,now,[seed]).totals.confirmedAudiobookWorks).toBe(0);
  });

  it('requires one explicit registry identity; a DB-row fallback never grants audio confirmation',()=>{
    const id=work(1);verifiedEdition('verified',id,'2025-01-01','B000000001');
    expect(auditCatalog(db,now,[seed]).totals.confirmedAudiobookWorks).toBe(1);
    for(const registry of [[],[seed,seed],[{...seed,author:'Another Author',authorAliases:['Another Author']}]] ){
      expect(auditCatalog(db,now,registry).totals.confirmedAudiobookWorks).toBe(0);
    }
    // The synthetic ID deliberately is not in the production config. Other audit
    // sections still report it; tests must opt into their reviewed synthetic seed.
    expect(auditCatalog(db,now).series[0]).toMatchObject({id:seed.id,counts:{canonicalWorks:1,confirmedAudiobookWorks:0,unverifiedAudioWorks:1}});
  });

  it('does not accept a verifiedDocument pointer to a note, generic page, or another product URL',()=>{
    const id=work(1),asin='B000000001';
    document('only-a-note',audioProductUrl(asin),'2026-09-01T12:00:00.000Z',JSON.stringify({method:'curated-source-summary',asin}));
    edition('verified-pointer-only',id,'audiobook','2025-01-01',asin,'only-a-note');
    expect(auditCatalog(db,now,[seed]).totals.confirmedAudiobookWorks).toBe(0);
    const copied=exactProduct(id,asin,{},'copied-product',audioProductUrl('B000000002'));
    db.prepare("UPDATE catalog_editions SET identifiers_json=json_set(identifiers_json,'$.verifiedDocument',?)").run(copied.id);
    expect(auditCatalog(db,now,[seed]).totals.confirmedAudiobookWorks).toBe(0);
  });

  it.each([
    {title:'Volume 1: Side Quest'}, {authors:[{name:'Somebody Else'}]}, {series:[{title:seed.title,sequence:'2'}]},
    {series:[{title:'Another Series',sequence:'1'}]}, {language:'german'}, {format_type:'abridged'}
  ])('rechecks current exact product identity instead of trusting an old verified pointer: %j',change=>{
    const id=work(1),asin='B000000001';
    verifiedEdition('verified',id,'2025-01-01',asin);
    // A retained source-only audio row must not rescue the invalid exact product.
    edition('publisher-audio-row',id,'audiobook','2025-01-01');
    expect(auditCatalog(db,now,[seed]).totals.confirmedAudiobookWorks).toBe(1);
    exactProduct(id,asin,change,'new-current',`https://api.audible.com/1.0/catalog/products/${asin}?response_groups=series`,'2026-09-18T12:00:00.000Z');
    db.pragma('query_only = ON');
    const report=auditCatalog(db,now,[seed]);
    expect(report.series[0].counts).toMatchObject({audiobookWorks:1,confirmedAudiobookWorks:0,unverifiedAudioWorks:1,unverifiedLegacyAudioWorks:1,releasedAudioWorks:1});
    expect(report.series[0].gaps.find(gap=>gap.code==='audio-not-confirmed')?.works?.map(row=>row.id)).toEqual([id]);
    expect(report.definitions.audioDates).toContain('including unverified records');
  });

  it.each([
    {asin:'B000000002'}, {asin:null}, {marketplace:'UK'}, {marketplace:null},
    {workIdentityHash:'old-identity'}, {workIdentityHash:null}, {verifiedDocument:'missing-document'}
  ])('requires the edition binding and marketplace as well as current product identity: %j',change=>{
    const id=work(1);verifiedEdition('verified',id,'2025-01-01','B000000001');
    const row=db.prepare('SELECT identifiers_json FROM catalog_editions WHERE id=?').get('verified') as {identifiers_json:string};
    db.prepare('UPDATE catalog_editions SET identifiers_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.identifiers_json),...change}),'verified');
    expect(auditCatalog(db,now,[seed]).totals.confirmedAudiobookWorks).toBe(0);
  });

  it('rejects a changed canonical work even when normalized title matching would still accept the product',()=>{
    const id=work(1);verifiedEdition('verified',id,'2025-01-01','B000000001');
    db.prepare('UPDATE catalog_works SET title=? WHERE id=?').run('Volume 1: A LitRPG Adventure',id);
    expect(auditCatalog(db,now,[seed]).totals.confirmedAudiobookWorks).toBe(0);
  });

  it('rejects corrupt retained proof and a dramatized row labelled with full-audiobook metadata',()=>{
    const id=work(1),doc=verifiedEdition('verified',id,'2025-01-01','B000000001');
    db.prepare("UPDATE catalog_editions SET format='dramatized' WHERE id='verified'").run();
    expect(auditCatalog(db,now,[seed]).totals.confirmedAudiobookWorks).toBe(0);
    db.prepare("UPDATE catalog_editions SET format='audiobook' WHERE id='verified'").run();
    db.prepare('UPDATE catalog_documents SET body=body||? WHERE id=?').run(' ',doc.id);
    expect(auditCatalog(db,now,[seed]).totals.confirmedAudiobookWorks).toBe(0);
  });

  it.each([
    ['https://www.audible.com/pd/B000000001',JSON.stringify({method:'curated-source-summary',asin:'B000000001'})],
    ['https://books.apple.com/us/audiobook/example/id123',JSON.stringify({method:'curated-source-summary',title:'Volume 1'})],
    ['https://www.reddit.com/r/example/comments/fixture',JSON.stringify({method:'curated-source-summary',text:'PRIVATE_READER_TEXT'})],
    ['https://soundbooththeater.com/shop/audiobooks/example/','<html><h1>Volume 1 audiobook</h1><p>PRIVATE_RAW_PAGE</p></html>'],
    ['https://aethonbooks.com/book/example/',JSON.stringify({method:'curated-source-summary',title:'Volume 1',format:'audiobook'})]
  ])('never treats a retained source-only document at %s as publisher audio proof', (url,body)=>{
    const id=work(1);edition('source-only-audio',id,'audiobook','2025-01-01');
    document('source-only-proof',url,now.toISOString(),body);
    db.prepare('UPDATE catalog_editions SET source_url=?,identifiers_json=? WHERE id=?')
      .run(url,JSON.stringify({verifiedDocument:'source-only-proof'}),'source-only-audio');
    db.pragma('query_only = ON');
    const report=auditCatalog(db,now,[seed]);
    expect(report.series[0].counts).toMatchObject({audiobookWorks:1,confirmedAudiobookWorks:0,unverifiedAudioWorks:1,unverifiedLegacyAudioWorks:0});
    expect(report.series[0].gaps.find(gap=>gap.code==='audio-not-confirmed')?.works?.map(row=>row.id)).toEqual([id]);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_RAW_PAGE');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_READER_TEXT');
  });

  it('confirms exact products read-only and exposes neither raw payloads nor source text',()=>{
    const id=work(1);verifiedEdition('verified',id,'2025-01-01','B000000001');
    const before={editions:db.prepare('SELECT * FROM catalog_editions').all(),documents:db.prepare('SELECT * FROM catalog_documents').all()};
    const request=vi.fn();vi.stubGlobal('fetch',request);db.pragma('query_only = ON');
    const report=auditCatalog(db,now,[seed]);
    expect(report.totals.confirmedAudiobookWorks).toBe(1);
    for(const text of ['PRIVATE_RAW_PAGE','PRIVATE_SOURCE_COPY','publisher_summary'])expect(JSON.stringify(report)).not.toContain(text);
    expect(request).not.toHaveBeenCalled();
    expect({editions:db.prepare('SELECT * FROM catalog_editions').all(),documents:db.prepare('SELECT * FROM catalog_documents').all()}).toEqual(before);
  });
});
