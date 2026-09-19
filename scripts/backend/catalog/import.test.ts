import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importWork, matchesCanonicalTitle, matchesLegacy } from './import.js';
import { audioProductUrl, audioWorkIdentity, importAudioProduct } from './audio.js';
import type { AudioTitleAliasReview } from './audio-title-aliases.js';
import { hash } from './queue.js';
import type { Document, ExtractedBook, SeedSeries, WorkRow } from './types.js';

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
afterEach(() => {vi.unstubAllGlobals();db.close();});

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

describe('shared canonical title matching',()=>{
  it.each(['Credit Review: ','Credit Review 1: ','Credit Review, Book 1: '])('preserves distinctive titles behind %s',prefix=>{
    expect(matchesCanonicalTitle(`${prefix}First Tale`,'First Tale',seed,1)).toBe(true);
    expect(matchesCanonicalTitle(`${prefix}Second Tale`,`${prefix}First Tale`,seed,1)).toBe(false);
  });
  it.each(['Credit Review 1','Credit Review Book 1','Credit Review, Book 1'])('matches the bare volume label %s only against another matching series/volume title',title=>{
    const row={id:'B000000001',title,subtitle:null,series_title:seed.title,series_number:1,author:seed.author,
      release_date:'2025-01-01',cover_url:null,narrator:null,runtime_minutes:null,url:null};
    const generic={...book,title:'Credit Review Book One'};
    expect(matchesCanonicalTitle(title,book.title,seed,1)).toBe(false);
    expect(matchesLegacy(row,seed,book)).toBe(false);
    expect(matchesLegacy(row,seed,generic)).toBe(true);
    expect(matchesLegacy({...row,series_number:2},seed,generic)).toBe(false);
    expect(matchesLegacy({...row,author:'Another Writer'},seed,generic)).toBe(false);
    expect(matchesLegacy({...row,series_title:'Another Series'},seed,generic)).toBe(false);
  });
  it('does not regard wrong volume labels or empty normalized titles as matching titles',()=>{
    expect(matchesCanonicalTitle('Credit Review Book 2',book.title,seed,1)).toBe(false);
    expect(matchesCanonicalTitle('Credit Review 2: First Tale',book.title,seed,1)).toBe(false);
    expect(matchesCanonicalTitle('(!!!)','[???]',seed,1)).toBe(false);
    expect(matchesCanonicalTitle('','',seed,1)).toBe(false);
  });
  it.each([
    ['A Shared Prefix: Other Story','A Shared Prefix: Expected Story'],
    ['A Shared Prefix - Other Story','A Shared Prefix - Expected Story'],
    ['First Tale (Other Story)','First Tale (Expected Story)'],
    ['First Tale [Other Story]','First Tale [Expected Story]'],
    ['First Tale (Other Story)','First Tale'],
    ['First Tale: Other Story','First Tale'],
    ['First Tale: A Fantasy LitRPG Adventure About Another Story','First Tale'],
    ['Credit Review Book One','An Entirely Different Story']
  ])('retains distinctive words in %s / %s', (left,right)=>{
    expect(matchesCanonicalTitle(left,right,seed,1)).toBe(false);
    expect(matchesCanonicalTitle(right,left,seed,1)).toBe(false);
  });
  it.each(['II','Two','Second','2','Book II','Book Two','Volume 2'])('normalizes %s only in a matching series volume slot',label=>{
    expect(matchesCanonicalTitle(`Credit Review ${label}: Second Tale`,'Second Tale',seed,2)).toBe(true);
    expect(matchesCanonicalTitle(`Credit Review ${label}: First Tale`,'First Tale',seed,1)).toBe(false);
    expect(matchesCanonicalTitle(`Credit Review ${label}`,'Credit Review 2',seed,2)).toBe(true);
  });
  it('does not turn ordinary numeric story words into volume aliases',()=>{
    expect(matchesCanonicalTitle('One Dark Road','1 Dark Road',seed,1)).toBe(false);
    expect(matchesCanonicalTitle('First Steps','1 Steps',seed,1)).toBe(false);
    expect(matchesCanonicalTitle('12 Miles Below','Twelve Miles Below',seed,12)).toBe(false);
    expect(matchesCanonicalTitle('Credit Review 1.5','Credit Review 15',seed,15)).toBe(false);
  });
  it('allows only an initial The while preserving internal articles and part distinctions',()=>{
    expect(matchesCanonicalTitle('World Nexus','The World Nexus',seed,3)).toBe(true);
    expect(matchesCanonicalTitle('The Sixth Realm Part 1','Sixth Realm Part 1',seed,6)).toBe(true);
    expect(matchesCanonicalTitle('The Sixth Realm Part 1','Sixth Realm Part 2',seed,6)).toBe(false);
    expect(matchesCanonicalTitle('The Sixth Realm Part 1','Sixth Realm',seed,6)).toBe(false);
    expect(matchesCanonicalTitle('The Road to the Valley','Road to Valley',seed,1)).toBe(false);
    expect(matchesCanonicalTitle('The Two Realms','The Second Realm',seed,2)).toBe(false);
  });
  it('uses a distinctive subtitle only after an independently matching bare series/volume title',()=>{
    const subtitle='First Tale: A LitRPG Adventure';
    expect(matchesCanonicalTitle('Credit Review Book 1','First Tale',seed,1,subtitle)).toBe(true);
    expect(matchesCanonicalTitle('Credit Review Book 1','First Tale',seed,1,'Second Tale: A LitRPG Adventure')).toBe(false);
    expect(matchesCanonicalTitle('Credit Review Book 2','First Tale',seed,1,subtitle)).toBe(false);
    expect(matchesCanonicalTitle('Second Tale','First Tale',seed,1,subtitle)).toBe(false);
    expect(matchesCanonicalTitle('Credit Review: Second Tale','First Tale',seed,1,subtitle)).toBe(false);
    expect(matchesCanonicalTitle('Credit Review Book 1','First Tale',seed,1,'A LitRPG Adventure')).toBe(false);
    const row={id:'B000000001',title:'Credit Review Book 1',subtitle,series_title:seed.title,series_number:1,author:seed.author,
      release_date:'2025-01-01',cover_url:null,narrator:null,runtime_minutes:null,url:null};
    expect(matchesLegacy(row,seed,book)).toBe(true);
    expect(matchesLegacy({...row,subtitle:'Second Tale'},seed,book)).toBe(false);
  });
  it('removes only a matching explicit final volume label, preserving the distinctive Rhine title',()=>{
    const nova={...seed,id:'portal-to-nova-roma',title:'Portal to Nova Roma'};
    expect(matchesCanonicalTitle('Portal to Nova Roma: The Rhine, Book 3','Portal to Nova Roma, The Rhine',nova,3)).toBe(true);
    expect(matchesCanonicalTitle('Portal to Nova Roma: Another River, Book 3','Portal to Nova Roma, The Rhine',nova,3)).toBe(false);
    expect(matchesCanonicalTitle('Portal to Nova Roma: The Rhine, Book 4','Portal to Nova Roma, The Rhine',nova,3)).toBe(false);
    expect(matchesCanonicalTitle('First Tale (Book 1)','First Tale',seed,1)).toBe(true);
    expect(matchesCanonicalTitle('First Tale (Book 2)','First Tale',seed,1)).toBe(false);
  });
  it.each(['A Fantasy LitRPG Adventure','A GameLit/LitRPG Adventure','A Xianxia Cultivation Novel','A Slice-of-Life LitRPG'])('supports the bounded format subtitle %s without discarding story titles',subtitle=>{
    expect(matchesCanonicalTitle(`First Tale: ${subtitle}`,'First Tale',seed,1)).toBe(true);
    expect(matchesCanonicalTitle(`Second Tale: ${subtitle}`,'First Tale',seed,1)).toBe(false);
    expect(matchesCanonicalTitle(`${seed.title}: ${subtitle}`,seed.title,seed,1)).toBe(true);
    expect(matchesCanonicalTitle(`${seed.title}: ${subtitle}`,'First Tale',seed,1)).toBe(false);
  });
  it('scopes a reviewed long marketing subtitle to its exact phrase and series',()=>{
    const fishing={...seed,id:'heretical-fishing',title:'Heretical Fishing'};
    const subtitle='A Cozy Guide to Annoying the Cults, Outsmarting the Fish, and Alienating Oneself';
    expect(matchesCanonicalTitle(`Heretical Fishing 2: ${subtitle}`,'Heretical Fishing 2',fishing,2)).toBe(true);
    expect(matchesCanonicalTitle('Heretical Fishing 2: A Cozy Guide to a Different Story','Heretical Fishing 2',fishing,2)).toBe(false);
    expect(matchesCanonicalTitle(`First Tale: ${subtitle}`,'First Tale',seed,1)).toBe(false);
  });
  it('rejects a later conflicting title refresh and rolls back its projection',()=>{
    const first=source('first-title'),workId=importWork(db,seed,{...book,title:'A Shared Prefix: Expected Story'},first);
    const next=source('different-title'),before=projectedState();
    expect(()=>importWork(db,seed,{...book,title:'A Shared Prefix: Other Story'},next)).toThrow(/Two different titles/);
    expect(projectedState()).toEqual(before);
    expect(db.prepare('SELECT title FROM catalog_works WHERE id=?').get(workId)).toEqual({title:'A Shared Prefix: Expected Story'});
    expect(db.prepare('SELECT * FROM catalog_claims WHERE document_id=?').all(next.id)).toHaveLength(0);
  });
});

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

describe('replaying a reviewed audiobook title alias',()=>{
  const asin='B000000001',at='2026-09-01T00:00:00.000Z';
  const ref=(doc:Document)=>({documentId:doc.id,url:doc.url,contentHash:doc.content_hash});
  function retain(url:string,body:string,fetched_at=at):Document {
    const content_hash=hash(body),id=hash([url,content_hash]);
    db.prepare('INSERT OR IGNORE INTO catalog_documents VALUES(?,?,?,?,?)').run(id,url,content_hash,body,fetched_at);
    db.prepare('INSERT OR REPLACE INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
      .run(url,id,fetched_at,'2099-01-01T00:00:00Z');
    return {id,url,content_hash,body,fetched_at};
  }
  function fixture(title=book.title,retailerTitle=seed.title,number=1){
    vi.stubGlobal('fetch',()=>{throw new Error('No network in alias replay tests.');});
    const selected:SeedSeries={...seed,sources:[{url:'https://aethonbooks.com/book-series/synthetic/',adapter:'aethon-series'}]};
    const primary=retain('https://aethonbooks.com/book/synthetic/',`<html><h1>${title}</h1><p>${book.description}</p><a href="https://www.audible.com/pd/${asin}">Buy the audiobook</a></html>`);
    const sourceBook:ExtractedBook={...book,title,number,format:'unknown',links:[{url:`https://www.audible.com/pd/${asin}`,format:'audiobook',asin}]};
    legacy(asin,seed.author);
    db.prepare('UPDATE books SET title=?,series_number=? WHERE id=?').run(retailerTitle,number,asin);
    const workId=importWork(db,selected,sourceBook,primary),work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    const product={asin,title:retailerTitle,subtitle:'Synthetic edition subtitle',language:'english',content_type:'Product',format_type:'unabridged',
      authors:[{name:'Writer One'},{name:'Writer Two'}],series:[{title:seed.title,sequence:String(number)}],release_date:'2025-05-01',
      narrators:[{name:'Verified Narrator'}],runtime_length_min:720};
    const exact=retain(audioProductUrl(asin),JSON.stringify({product}));
    const review:AudioTitleAliasReview={id:'synthetic-audio-alias',workId,workIdentityHash:audioWorkIdentity(work),asin,
      canonicalTitle:title,retailerTitle,reviewedAt:'2026-09-02T00:00:00.000Z',reviewedBy:'Synthetic source reviewer',
      primary:{...ref(primary),sourceType:'publisher'},product:ref(exact)};
    importAudioProduct(db,selected,work,product,exact,{titleAliases:[review]});
    db.prepare("UPDATE catalog_jobs SET status='completed',result_json=? WHERE kind='audio-edition'")
      .run(JSON.stringify({workId,asin,documentId:exact.id}));
    return {selected,primary,sourceBook,workId,product,exact,review};
  }
  const reviewStatus=()=>db.prepare("SELECT status FROM catalog_jobs WHERE kind='review-edition' ORDER BY created_at,id").all();
  const recording=()=>({books:db.prepare('SELECT * FROM books ORDER BY id').all(),editions:db.prepare('SELECT * FROM catalog_editions WHERE legacy_book_id IS NOT NULL ORDER BY id').all()});

  it.each([
    [book.title,seed.title,1],
    ['First Tale – EvP','First Tale: EvP (Environment vs. Player)',2]
  ] as const)('does not reopen an accepted %s / %s alias or alter recording facts on unchanged source replay', (title,retailerTitle,number)=>{
    const f=fixture(title,retailerTitle,number),before=recording();
    const jobs=db.prepare('SELECT * FROM catalog_jobs ORDER BY id').all();
    expect(reviewStatus()).toEqual([{status:'completed'}]);
    // A superficially compatible legacy row still is not a new title match. The
    // current exact proof suppresses only its already-resolved conflict.
    const row=db.prepare('SELECT b.*,s.title series_title FROM books b JOIN series s ON s.id=b.series_id WHERE b.id=?').get(asin) as Parameters<typeof matchesLegacy>[0];
    expect(matchesLegacy(row,f.selected,f.sourceBook)).toBe(false);
    for(let i=0;i<2;i++)importWork(db,f.selected,{...f.sourceBook,audioReleaseDate:'2027-01-01',narrator:'Unapplied source credit',audioRuntimeMinutes:999},f.primary,{titleAliases:[f.review]});
    expect(db.prepare('SELECT * FROM catalog_jobs ORDER BY id').all()).toEqual(jobs);
    expect(recording()).toEqual(before);
    expect(db.prepare('SELECT title FROM catalog_works WHERE id=?').get(f.workId)).toEqual({title});
  });

  it('requires the active review and an existing verified binding, not merely an observed primary link',()=>{
    const f=fixture();
    db.prepare('DELETE FROM catalog_editions WHERE legacy_book_id=?').run(asin);
    importWork(db,f.selected,f.sourceBook,f.primary,{titleAliases:[f.review]});
    expect(reviewStatus()).toEqual([{status:'review'}]);
    expect(db.prepare('SELECT * FROM catalog_editions WHERE legacy_book_id=?').all(asin)).toHaveLength(0);
  });
  it('does not reuse a withdrawn review even though the earlier exact import remains retained',()=>{
    const f=fixture(),before=recording();
    importWork(db,f.selected,f.sourceBook,f.primary,{titleAliases:[]});
    expect(reviewStatus()).toEqual([{status:'review'}]);expect(recording()).toEqual(before);
  });
  it.each([
    {marketplace:'UK'}, {asin:'B000000002'}, {verifiedDocument:'missing'}, {workIdentityHash:'old-work'}
  ])('does not suppress a conflict for a stale edition binding: %j',change=>{
    const f=fixture(),row=db.prepare('SELECT identifiers_json FROM catalog_editions WHERE legacy_book_id=?').get(asin) as {identifiers_json:string};
    db.prepare('UPDATE catalog_editions SET identifiers_json=? WHERE legacy_book_id=?').run(JSON.stringify({...JSON.parse(row.identifiers_json),...change}),asin);
    const before=recording();importWork(db,f.selected,f.sourceBook,f.primary,{titleAliases:[f.review]});
    expect(reviewStatus()).toEqual([{status:'review'}]);expect(recording()).toEqual(before);
  });
  it('does not reuse proof bound to an earlier canonical identity, even for a formatting-only title change',()=>{
    const f=fixture();
    db.prepare('UPDATE catalog_works SET title=? WHERE id=?').run(`${f.sourceBook.title}: A LitRPG Adventure`,f.workId);
    const before=recording();importWork(db,f.selected,f.sourceBook,f.primary,{titleAliases:[f.review]});
    expect(reviewStatus()).toEqual([{status:'review'}]);expect(recording()).toEqual(before);
  });
  it('does not suppress a conflict when the ASIN is attached to another canonical work',()=>{
    const f=fixture(),other='work-another-owner';
    db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(other,seed.id,8,'Another Work',seed.author,f.primary.url,at);
    db.prepare('UPDATE catalog_editions SET work_id=? WHERE legacy_book_id=?').run(other,asin);
    const before=recording();importWork(db,f.selected,f.sourceBook,f.primary,{titleAliases:[f.review]});
    expect(reviewStatus()).toEqual([{status:'review'}]);expect(recording()).toEqual(before);
  });
  it.each(['author','number','series','subtitle'] as const)('keeps the independent legacy %s identity check',field=>{
    const f=fixture();
    if(field==='author')db.prepare('UPDATE books SET author=? WHERE id=?').run('Another Writer',asin);
    else if(field==='number')db.prepare('UPDATE books SET series_number=2 WHERE id=?').run(asin);
    else if(field==='series')db.prepare('UPDATE series SET title=? WHERE id=(SELECT series_id FROM books WHERE id=?)').run('Another Series',asin);
    else db.prepare('UPDATE books SET subtitle=? WHERE id=?').run('Different distinctive subtitle',asin);
    const before=recording();importWork(db,f.selected,f.sourceBook,f.primary,{titleAliases:[f.review]});
    expect(reviewStatus()).toContainEqual({status:'review'});expect(recording()).toEqual(before);
  });
  it('does not suppress a conflict after the reviewed primary source changes',()=>{
    const f=fixture(),newer=retain(f.primary.url,`${f.primary.body}<p>Changed primary source.</p>`,'2026-09-03T00:00:00.000Z');
    const before=recording();importWork(db,f.selected,f.sourceBook,newer,{titleAliases:[f.review]});
    expect(reviewStatus().some(row=>(row as {status:string}).status==='review')).toBe(true);expect(recording()).toEqual(before);
  });
  it.each([
    {authors:[{name:'Writer One'}]}, {series:[{title:seed.title,sequence:'2'}]}, {series:[{title:'Another Series',sequence:'1'}]},
    {language:'german'}, {content_type:'Episode'}, {format_type:'abridged'}, {subtitle:'A dramatized adaptation'}
  ])('revalidates full current recording identity even with newly reviewed raw hashes: %j',change=>{
    const f=fixture(),newer=retain(`https://api.audible.com/1.0/catalog/products/${asin}?response_groups=series`,JSON.stringify({product:{...f.product,...change}}),'2026-09-03T00:00:00.000Z');
    const reviewed={...f.review,product:ref(newer),reviewedAt:'2026-09-04T00:00:00.000Z'},before=recording();
    importWork(db,f.selected,f.sourceBook,f.primary,{titleAliases:[reviewed]});
    expect(reviewStatus()).toEqual([{status:'review'}]);expect(recording()).toEqual(before);
  });
  it('does not reuse the old alias when a newer same-title product body is unreviewed',()=>{
    const f=fixture();
    retain(`https://api.audible.com/1.0/catalog/products/${asin}?response_groups=series`,JSON.stringify({product:{...f.product,release_date:'2026-01-01'}}),'2026-09-03T00:00:00.000Z');
    const before=recording();importWork(db,f.selected,f.sourceBook,f.primary,{titleAliases:[f.review]});
    expect(reviewStatus()).toEqual([{status:'review'}]);expect(recording()).toEqual(before);
  });
});
