import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { claim, enqueue, fail, finish, hash } from './queue.js';
import { importWork } from './import.js';
import { seedCatalog } from './pipeline.js';
import { parseAethonBook, parseSbtBook, verifyIdentity } from './adapters.js';
import { getDocument, robotsAllowed, sourceUrl } from './sources.js';
import { extractionHash, extractionInput, processExtraction, seriesExtractionInput, validateExtraction } from './inference.js';
import { ReviewError, type Document, type ExtractedBook, type SeedSeries, type WorkRow } from './types.js';

let db: Database.Database;
const seed: SeedSeries = { id:'test-series',title:'Test Series',author:'Test Author',authorAliases:['Test Author'],aliases:['Test Series Alias'],genres:['litrpg'],priority:10,sources:[] };
const source: Document = { id:'source-1',url:'https://aethonbooks.com/book/test-series-1/',content_hash:'abc',body:'saved source',fetched_at:'2026-09-19T00:00:00Z' };
const book: ExtractedBook = { title:'Test Series 1',series:seed.title,number:1,author:seed.author,description:'A healer wakes in a world of dungeons and joins a party to explore an underground city. Their first goal is to rescue a missing merchant.',coverUrl:null,releaseDate:'2025-01-01',publicationStatus:'released',format:'ebook',narrator:'Test Narrator',audioReleaseDate:null,audioRuntimeMinutes:null,links:[] };
const result = { synopsis:'A healer joins a party exploring an underground city. Their search for a missing merchant leads them into a dungeon.',features:[{tag:'dungeon',evidence:'a world of dungeons'}] };

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  for (const name of ['001_initial.sql','006_catalog_pipeline.sql']) db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id,seed.title,seed.author,source.fetched_at);
  db.prepare('INSERT INTO catalog_documents(id,url,content_hash,body,fetched_at) VALUES(?,?,?,?,?)').run(source.id,source.url,source.content_hash,source.body,source.fetched_at);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.close(); });

function legacy(id: string, number: number, title=`Test Series ${number}`) {
  db.prepare('INSERT OR IGNORE INTO series(id,title,author) VALUES(?,?,?)').run('legacy',seed.title,seed.author);
  db.prepare('INSERT INTO books(id,title,author,series_id,series_number,release_date) VALUES(?,?,?,?,?,?)').run(id,title,seed.author,'legacy',number,'2025-05-01');
}

describe('publisher ingestion', () => {
  it('does not mistake a pen-name expansion for a changed author or attach a different coauthor’s legacy edition',()=>{
    const pen={...seed,authorAliases:['Test Author','Test Pen Name']};
    const id=importWork(db,pen,book,source);
    importWork(db,pen,{...book,author:'Test Author, Test Pen Name'},source);
    expect(db.prepare("SELECT id FROM catalog_jobs WHERE kind='review-author'").all()).toHaveLength(0);
    legacy('COAUTHOR01',2,'Test Series 2');
    db.prepare("UPDATE books SET author='Co Author' WHERE id='COAUTHOR01'").run();
    const collaboration={...seed,author:'Test Author, Co Author',authorAliases:['Test Author','Co Author']};
    importWork(db,collaboration,{...book,title:'Test Series 2',number:2},source);
    expect(db.prepare("SELECT id FROM catalog_editions WHERE legacy_book_id='COAUTHOR01'").all()).toHaveLength(0);
    expect(db.prepare('SELECT author FROM catalog_works WHERE id=?').get(id)).toEqual({author:'Test Author'});
  });
  it('keeps work-specific coauthor credits rather than copying the series roster to every volume',()=>{
    const collaboration={...seed,author:'Test Author, Co Author',authorAliases:['Test Author','Co Author']};
    const first=importWork(db,collaboration,{...book,author:'Test Author, Co Author'},source);
    const second=importWork(db,collaboration,{...book,title:'Test Series 2',number:2,author:'Test Author'},source);
    expect(db.prepare('SELECT author FROM catalog_works WHERE id=?').get(first)).toEqual({author:'Test Author, Co Author'});
    expect(db.prepare('SELECT author FROM catalog_works WHERE id=?').get(second)).toEqual({author:'Test Author'});
    importWork(db,collaboration,{...book,author:'Test Author'},source);
    expect(db.prepare('SELECT author FROM catalog_works WHERE id=?').get(first)).toEqual({author:'Test Author, Co Author'});
    expect(db.prepare("SELECT status FROM catalog_jobs WHERE kind='review-author'").get()).toEqual({status:'review'});
    expect(db.prepare("SELECT value_json FROM catalog_claims WHERE entity_id=? AND field='author' ORDER BY value_json").all(first)).toHaveLength(2);
  });
  it('registers one selected series without scheduling unrelated publisher indexes',()=>{
    const url='https://aethonbooks.com/book-series/test-series/';
    seedCatalog(db,[{...seed,sources:[{url,adapter:'aethon-series'}]}],{includeIndexes:false});
    const jobs=db.prepare("SELECT entity_id,payload_json FROM catalog_jobs WHERE kind='source'").all() as {entity_id:string;payload_json:string}[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].entity_id).toBe(url);
    expect(JSON.parse(jobs[0].payload_json).seriesId).toBe(seed.id);
  });
  it('keeps identity-only bibliography evidence without inventing a physical edition',()=>{
    const id=importWork(db,seed,{...book,format:'unknown',releaseDate:null,narrator:null},source);
    expect(db.prepare('SELECT id FROM catalog_works').get()).toEqual({id});
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_editions').get()).toEqual({n:0});
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_claims WHERE entity_id=?").get(id)).toMatchObject({n:11});
  });
  it('selects a newly curated series from a saved index without crawling the index again', () => {
    const url='https://aethonbooks.com/book-series/test-series/';
    db.prepare('INSERT INTO catalog_candidates(url,title,source_name,document_id,status,discovered_at) VALUES(?,?,?,?,?,?)').run(url,seed.title,'Aethon Books',source.id,'discovered',source.fetched_at);
    const request=vi.fn();vi.stubGlobal('fetch',request);
    seedCatalog(db,[seed]);
    expect(db.prepare("SELECT status FROM catalog_candidates WHERE url=?").get(url)).toEqual({status:'selected'});
    expect(db.prepare("SELECT payload_json FROM catalog_jobs WHERE entity_id=?").get(url)).toEqual({payload_json:JSON.stringify({url,adapter:'aethon-series',seriesId:seed.id})});
    expect(seedCatalog(db,[seed])).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });
  it('retains every published identity alias through seed refreshes and retitles',()=>{
    db.prepare('UPDATE catalog_series SET aliases_json=? WHERE id=?').run(JSON.stringify(['retired-series-key']),seed.id);
    seedCatalog(db,[seed]);
    seedCatalog(db,[{...seed,title:'Retitled Series',aliases:[]}]);
    const row=db.prepare('SELECT aliases_json FROM catalog_series WHERE id=?').get(seed.id) as {aliases_json:string};
    const aliases=JSON.parse(row.aliases_json);
    expect(aliases).toContain('retired-series-key');
    expect(aliases).toContain('Test Series');
    expect(aliases).toContain('Test Series Alias');
    expect(new Set(aliases).size).toBe(aliases.length);
  });
  it('keeps print publication separate and queues a new audio identifier before promotion', () => {
    const input={...book,links:[{format:'audiobook' as const,asin:'B000000001',url:'https://www.audible.com/pd/B000000001'}]};
    importWork(db,seed,input,source); importWork(db,seed,input,source);
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_works').get()).toEqual({n:1});
    expect(db.prepare("SELECT release_date FROM catalog_editions WHERE format='ebook'").get()).toEqual({release_date:'2025-01-01'});
    expect(db.prepare("SELECT release_date FROM catalog_editions WHERE format='audiobook'").get()).toBeUndefined();
    expect(db.prepare('SELECT release_date FROM books').get()).toBeUndefined();
    expect(db.prepare('SELECT kind,status FROM catalog_jobs').all()).toEqual([{kind:'audio-edition',status:'pending'}]);
    const claims=db.prepare('SELECT field FROM catalog_claims').all();
    expect(new Set(claims.map((r:any)=>r.field)).size).toBe(claims.length);
  });
  it('quarantines a publisher link pointing to another book while retaining valid work facts', () => {
    legacy('B000000006',6);
    const wrong={...book,title:'Test Series 12',number:12,audioReleaseDate:'2026-12-01',links:[{format:'audiobook' as const,asin:'B000000006',url:'https://www.audible.com/pd/B000000006'}]};
    const id=importWork(db,seed,wrong,source);
    expect(db.prepare('SELECT title FROM catalog_works WHERE id=?').get(id)).toEqual({title:'Test Series 12'});
    expect(db.prepare('SELECT series_number,release_date FROM books WHERE id=?').get('B000000006')).toEqual({series_number:6,release_date:'2025-05-01'});
    expect(db.prepare('SELECT * FROM catalog_editions WHERE legacy_book_id IS NOT NULL').all()).toHaveLength(0);
    expect(db.prepare("SELECT status FROM catalog_jobs WHERE kind='review-edition'").get()).toEqual({status:'review'});
    expect(db.prepare("SELECT status FROM catalog_jobs WHERE kind='audio-edition'").get()).toEqual({status:'pending'});
    expect(db.prepare("SELECT field FROM catalog_claims WHERE field='rejectedAudioIdentifier'").get()).toBeTruthy();
  });
  it('queues exact verification when an observed audio link already has an incomplete legacy row',()=>{
    legacy('B000000001',1);
    db.prepare("UPDATE books SET series_number=NULL,series_id=NULL WHERE id='B000000001'").run();
    importWork(db,seed,{...book,links:[{format:'audiobook',asin:'B000000001',url:'https://www.audible.com/pd/B000000001'}]},source);
    expect(db.prepare("SELECT status FROM catalog_jobs WHERE kind='audio-edition'").get()).toEqual({status:'pending'});
    expect(db.prepare("SELECT work_id FROM catalog_editions WHERE legacy_book_id='B000000001'").get()).toBeUndefined();
    expect(db.prepare("SELECT series_number FROM books WHERE id='B000000001'").get()).toEqual({series_number:null});
  });
  it('does not attach a same-number title from another author or a boxed collection', () => {
    legacy('B000000001',1); legacy('B000000002',1,'Test Series: Books 1–3');
    db.prepare("UPDATE books SET author='Unrelated Author' WHERE id='B000000001'").run();
    importWork(db,seed,book,source);
    expect(db.prepare('SELECT * FROM catalog_editions WHERE legacy_book_id IS NOT NULL').all()).toHaveLength(0);
  });
  it('keeps the previous work intact when a different title claims its number', () => {
    importWork(db,seed,book,source);
    expect(()=>importWork(db,seed,{...book,title:'Entirely Different Story'},source)).toThrow(ReviewError);
    expect(db.prepare('SELECT title FROM catalog_works').get()).toEqual({title:book.title});
  });
  it.each(['Test Series: ', 'Test Series 1: ', 'Test Series, Book 1: '])('does not merge distinct story titles behind the prefix %s', prefix => {
    importWork(db,seed,{...book,title:`${prefix}First Tale`},source);
    expect(()=>importWork(db,seed,{...book,title:`${prefix}Second Tale`},source)).toThrow(ReviewError);
    legacy('B000000001',1,`${prefix}Second Tale`);
    importWork(db,seed,{...book,title:'First Tale'},source);
    expect(db.prepare('SELECT * FROM catalog_editions WHERE legacy_book_id IS NOT NULL').all()).toHaveLength(0);
  });
  it('matches distinctive titles across series prefixes and tolerates format subtitles', () => {
    importWork(db,seed,{...book,title:'Test Series, Book 1: First Tale'},source);
    expect(()=>importWork(db,seed,{...book,title:'First Tale'},source)).not.toThrow();
    const second={...book,number:2,title:'Test Series 2'};
    importWork(db,seed,second,source);
    expect(()=>importWork(db,seed,{...second,title:'Test Series 2: A Fantasy LitRPG Adventure'},source)).not.toThrow();
  });
  it('preserves good descriptions when a refreshed page becomes empty and updates corrected links', () => {
    const initial={...book,links:[{format:'audiobook' as const,asin:'B000000001',url:'https://www.audible.com/pd/B000000001'}]};
    const id=importWork(db,seed,initial,source);
    const next={...source,id:'source-2',content_hash:'def',body:'changed source'};
    db.prepare('INSERT INTO catalog_documents VALUES(?,?,?,?,?)').run(next.id,next.url,next.content_hash,next.body,next.fetched_at);
    importWork(db,seed,{...initial,description:'',links:[{format:'audiobook',asin:'B000000002',url:'https://www.audible.com/pd/B000000002'}]},next);
    expect(db.prepare('SELECT source_description FROM catalog_works WHERE id=?').get(id)).toEqual({source_description:book.description});
    expect(db.prepare("SELECT status FROM catalog_jobs WHERE kind='review-description'").get()).toEqual({status:'review'});
    expect(JSON.parse((db.prepare("SELECT identifiers_json FROM catalog_editions WHERE format='ebook'").get() as any).identifiers_json).links[0].asin).toBe('B000000002');
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_claims WHERE field='links'").get()).toEqual({n:2});
  });
  it('rejects an unexpected coauthor instead of matching the first name only', () => {
    legacy('B000000001',1);
    db.prepare("UPDATE books SET author='Test Author, Unrelated Author'").run();
    importWork(db,seed,book,source);
    expect(db.prepare('SELECT * FROM catalog_editions WHERE legacy_book_id IS NOT NULL').all()).toHaveLength(0);
  });
  it('accepts comic tone in a description but rejects an actual graphic adaptation', () => {
    expect(()=>verifyIdentity({...book,description:'A comic adventure through a dungeon.'},seed)).not.toThrow();
    expect(()=>verifyIdentity({...book,title:'Test Series Graphic Novel'},seed)).toThrow(ReviewError);
  });
  it('parses audio-specific dates and runtimes instead of borrowing the ebook date', () => {
    const row=(label:string,value:string)=>`<div class="mfb-details__row"><b class="mfb-details__label">${label}</b><span class="mfb-details__value">${value}</span></div>`;
    const html=`<h1>Test Series 6: A New Path</h1><div class="book-series"><strong>Test Series</strong></div><div class="mfs-author-credit-entry"><span class="mfs-author-name">Test Author</span></div><div class="book-page-description"><p>${book.description}</p></div>${row('Publication Date','02/01/2026')}${row('Audiobook Publication Date','April 3, 2026')}${row('Audiobook Duration','14 hrs and 12 mins')}`;
    expect(parseAethonBook(html)).toMatchObject({number:6,releaseDate:'2026-02-01',audioReleaseDate:'2026-04-03',audioRuntimeMinutes:852});
    expect(parseAethonBook(html.replace(row('Audiobook Publication Date','April 3, 2026'),'')).audioReleaseDate).toBeNull();
  });
  it('does not mistake episodic audio productions for numbered full books', () => {
    expect(()=>parseSbtBook('<h1>Test Series, Season 1: Episode 4</h1>')).toThrow(ReviewError);
  });
});

describe('durable job recovery', () => {
  it('serializes input versions for one entity while allowing other entities to run', () => {
    const now=new Date('2026-09-19T00:00:00Z');
    enqueue(db,'extract','same-work','old',{},20,now);
    const first=claim(db,['extract'],now)!;
    enqueue(db,'extract','same-work','new',{},30,now);
    enqueue(db,'extract','other-work','other',{},10,now);
    const other=claim(db,['extract'],now)!;
    expect(other.entity_id).toBe('other-work');
    expect(claim(db,['extract'],now)).toBeNull();
    finish(db,first,{cached:false});
    expect(claim(db,['extract'],now)?.input_hash).toBe('new');
    finish(db,other,{cached:false});
  });
  it('deduplicates jobs, respects series selection, and protects a reclaimed lease', () => {
    const work=importWork(db,seed,book,source), start=new Date('2026-09-19T00:00:00Z');
    expect(enqueue(db,'extract',work,'input',{workId:work},10,start)).toBe(true);
    expect(enqueue(db,'extract',work,'input',{workId:work},10,start)).toBe(false);
    enqueue(db,'source','other','input',{seriesId:'other'},100,start);
    const first=claim(db,['source','extract'],start,seed.id)!;
    expect(first.entity_id).toBe(work);
    expect(claim(db,['extract'],new Date(start.getTime()+1000),seed.id)).toBeNull();
    const resumed=claim(db,['extract'],new Date(start.getTime()+181000),seed.id)!;
    expect(resumed.attempts).toBe(2);
    expect(()=>finish(db,first,{wrong:true})).toThrow(/lease/);
    finish(db,resumed,{ok:true});
    expect(claim(db,['extract'],new Date(start.getTime()+182000),seed.id)).toBeNull();
    expect(claim(db,['source'],new Date(start.getTime()+182000))?.entity_id).toBe('other');
  });
  it('delays transient failures and leaves reviewed failures out of automatic retry', () => {
    const time=new Date('2026-09-19T00:00:00Z');enqueue(db,'source','page','input',{},0,time);
    const job=claim(db,['source'],time)!;fail(db,job,'Temporary failure',false,time);
    expect(claim(db,['source'],new Date(time.getTime()+29000))).toBeNull();
    const retry=claim(db,['source'],new Date(time.getTime()+30000))!;
    fail(db,retry,'Wrong author',true,new Date(time.getTime()+30000));
    expect(claim(db,['source'],new Date(time.getTime()+3600000))).toBeNull();
  });
});

describe('source cache and access policy', () => {
  it('uses the most specific robots group and longest matching path rule', () => {
    expect(robotsAllowed('User-agent: *\nDisallow: /\nUser-agent: LitRPGHub\nAllow: /books/\nDisallow: /books/private/', '/books/a')).toBe(true);
    expect(robotsAllowed('User-agent: *\nDisallow: /\nAllow: /books/', '/books/a')).toBe(true);
    expect(robotsAllowed('User-agent: *\nDisallow: /\nAllow: /books/', '/admin')).toBe(false);
    expect(robotsAllowed('User-agent: SomeOtherBot\nDisallow: /', '/books/a')).toBe(true);
    expect(()=>sourceUrl('https://aethonbooks.com.attacker.example/book/')).toThrow(ReviewError);
    expect(()=>sourceUrl('https://user:secret@aethonbooks.com/book/')).toThrow(ReviewError);
  });
  it('replays fresh pages without a network call and retains the old snapshot after an interstitial', async () => {
    const old='2000-01-01T00:00:00.000Z', future='2999-01-01T00:00:00.000Z';
    db.prepare('INSERT INTO catalog_urls(url,document_id,checked_at,next_check_at,etag) VALUES(?,?,?,?,?)').run(source.url,source.id,old,future,'"original"');
    const request=vi.fn();
    expect((await getDocument(db,source.url,{request})).downloaded).toBe(false);
    expect(request).not.toHaveBeenCalled();
    // The robots record is also a durable source document, so the forced content request needn't refetch it.
    const robots='https://aethonbooks.com/robots.txt';
    db.prepare('INSERT INTO catalog_documents VALUES(?,?,?,?,?)').run('robots',robots,'robot-hash','User-agent: *\nDisallow:',old);
    db.prepare('INSERT INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)').run(robots,'robots',old,future);
    request.mockResolvedValue(new Response(`<html><title>Just a moment</title>${' '.repeat(400)}</html>`,{headers:{'content-type':'text/html'}}));
    await expect(getDocument(db,source.url,{request,force:true})).rejects.toThrow(ReviewError);
    expect(db.prepare('SELECT document_id FROM catalog_urls WHERE url=?').get(source.url)).toEqual({document_id:source.id});
    const headers=request.mock.calls[0][1].headers;
    expect(headers['If-None-Match']).toBe('"original"');
    request.mockResolvedValue(new Response(null,{status:304}));
    expect((await getDocument(db,source.url,{request,force:true})).document.id).toBe(source.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_documents').get()).toEqual({n:2});
  });
});

describe('inference persistence', () => {
  it('keeps the concrete first-book premise when a later volume has a generic series footer', () => {
    importWork(db,seed,book,source);
    importWork(db,seed,{...book,title:'Test Series 2',number:2,description:'The merchant dies in the final battle. About the Series: A tactical adventure with an internally consistent magic system.'},source);
    const input=seriesExtractionInput(db,seed.id)!;
    expect(input.description).toContain(book.description);
    expect(input.description).toContain('internally consistent magic system');
    expect(input.description).not.toContain('merchant dies');
  });
  it('drops unsupported feature spans and changes the cache key when evidence changes', () => {
    expect(validateExtraction({...result,features:[...result.features,{tag:'time-loop',evidence:'The year repeats again.'}]},book.description).features).toHaveLength(1);
    expect(extractionHash({description:'first'})).not.toBe(extractionHash({description:'second'}));
    const before=extractionHash({description:'first'});vi.stubEnv('CATALOG_OPENAI_MODEL','another-model');
    expect(extractionHash({description:'first'})).not.toBe(before);
  });
  it('reuses a persisted paid response after a crash before promotion without another API call', async () => {
    const id=importWork(db,seed,book,source), work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(id) as WorkRow;
    const inputHash=extractionHash(extractionInput(work));
    db.prepare('INSERT INTO catalog_inferences VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(hash(['work',id,'extract-response',inputHash]),'work',id,'extract-response',inputHash,'model','actual','version',JSON.stringify(result),JSON.stringify({input_tokens:123,output_tokens:45}),source.fetched_at);
    const request=vi.fn();vi.stubGlobal('fetch',request);
    expect(await processExtraction(db,id,'extract',{})).toMatchObject({cached:true,promoted:true,input_tokens:0,output_tokens:0});
    expect(request).not.toHaveBeenCalled();
    expect(db.prepare('SELECT description FROM catalog_works WHERE id=?').get(id)).toEqual({description:result.synopsis});
    expect(await processExtraction(db,id,'extract',{})).toMatchObject({cached:true});
    expect(db.prepare("SELECT SUM(json_extract(usage_json,'$.input_tokens')) AS tokens FROM catalog_inferences").get()).toEqual({tokens:123});
  });
  it('retains invalid paid responses for review rather than buying repeated retries', async () => {
    vi.stubEnv('OPENAI_API_KEY','test-key');const id=importWork(db,seed,book,source);
    const request=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({status:'completed',model:'test-model',usage:{input_tokens:50,output_tokens:5},output:[{content:[{type:'output_text',text:JSON.stringify({synopsis:'Too short',features:[]})}]}]}),{headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',request);
    await expect(processExtraction(db,id,'extract',{})).rejects.toThrow(ReviewError);
    await expect(processExtraction(db,id,'extract',{})).rejects.toThrow(ReviewError);
    expect(request).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT description FROM catalog_works WHERE id=?').get(id)).toEqual({description:''});
    expect(db.prepare('SELECT kind FROM catalog_inferences ORDER BY kind').all()).toEqual([{kind:'extract-response'},{kind:'extract-wire-response'}]);
    expect(db.prepare("SELECT SUM(json_extract(usage_json,'$.input_tokens')) AS tokens FROM catalog_inferences").get()).toEqual({tokens:50});
  });
  it.each(['incomplete','refusal','invalid-json'])('saves a paid %s response before parsing and does not retry the model', async failure => {
    vi.stubEnv('OPENAI_API_KEY','test-key');const id=importWork(db,seed,book,source);
    const response={status:failure==='incomplete'?'incomplete':'completed',model:'test-model',usage:{input_tokens:50,output_tokens:5},output:[{content:[failure==='refusal'?{type:'refusal',text:'Declined'}:{type:'output_text',text:'{unfinished'}]}]};
    const request=vi.fn().mockImplementation(async()=>new Response(JSON.stringify(response)));vi.stubGlobal('fetch',request);
    await expect(processExtraction(db,id,'extract',{})).rejects.toThrow(ReviewError);
    await expect(processExtraction(db,id,'extract',{})).rejects.toThrow(ReviewError);
    expect(request).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT kind FROM catalog_inferences').get()).toEqual({kind:'extract-wire-response'});
    expect(db.prepare('SELECT description FROM catalog_works WHERE id=?').get(id)).toEqual({description:''});
  });
  it('does not promote a result if the publisher evidence changes during the request', async () => {
    vi.stubEnv('OPENAI_API_KEY','test-key');const id=importWork(db,seed,book,source);
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>{
      db.prepare('UPDATE catalog_works SET source_description=? WHERE id=?').run('A corrected publisher description with different events.',id);
      return new Response(JSON.stringify({status:'completed',model:'test-model',usage:{input_tokens:50,output_tokens:25},output:[{content:[{type:'output_text',text:JSON.stringify(result)}]}]}));
    }));
    expect(await processExtraction(db,id,'extract',{})).toMatchObject({promoted:false});
    expect(db.prepare('SELECT description FROM catalog_works WHERE id=?').get(id)).toEqual({description:''});
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_inferences').get()).toEqual({n:3});
  });
});
