import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioProductUrl, importAudioProduct, processAudio, verifyAudioProduct, verifyCanonicalAudioProduct } from './audio.js';
import { productDescription } from '../fetchers/audible.js';
import { importWork } from './import.js';
import { getDocument } from './sources.js';
import { hash } from './queue.js';
import { ReviewError, type Document, type ExtractedBook, type SeedSeries, type WorkRow } from './types.js';

const seed: SeedSeries = {id:'test',title:'Test Series',author:'Test Author',authorAliases:['Test Author','Test Pen Name'],aliases:[],genres:['litrpg'],priority:1,sources:[]};
const doc: Document = {id:'source',url:'https://aethonbooks.com/book/test/',content_hash:'source',body:'publisher page',fetched_at:'2026-09-19T00:00:00Z'};
const book: ExtractedBook = {title:'Test Series 1',series:seed.title,number:1,author:seed.author,description:'A healer wakes in a hostile world. She must learn to fight and form new friendships before the creatures of the forest find her.',coverUrl:null,releaseDate:'2025-01-01',publicationStatus:'released',format:'ebook',narrator:null,audioReleaseDate:null,audioRuntimeMinutes:null,links:[{format:'audiobook',asin:'B000000001',url:'https://www.audible.com/pd/B000000001'}]};
const product = {asin:'B000000001',title:'Test Series 1',language:'english',content_type:'Product',format_type:'unabridged',authors:[{name:'Test Author'}],narrators:[{name:'Good Narrator'}],series:[{title:'Test Series',sequence:'1'}],release_date:'2025-03-01',runtime_length_min:720,merchandising_summary:'A short retailer snippet.',product_images:{'500':'https://m.media-amazon.com/images/I/test.jpg'}};
let db: Database.Database;
beforeEach(() => {
  db=new Database(':memory:');db.pragma('foreign_keys=ON');
  for(const name of ['001_initial.sql','006_catalog_pipeline.sql'])db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id,seed.title,seed.author,doc.fetched_at);
  db.prepare('INSERT INTO catalog_documents VALUES(?,?,?,?,?)').run(doc.id,doc.url,doc.content_hash,doc.body,doc.fetched_at);
});
afterEach(() => {vi.unstubAllGlobals();vi.useRealTimers();db.close();});

function importedState() {
  return Object.fromEntries(['catalog_works','catalog_editions','books','book_sources','book_subgenres','catalog_claims','catalog_jobs']
    .map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function retainedProduct(value:unknown=product,url=audioProductUrl(product.asin),stamp=doc.fetched_at):Document {
  const body=JSON.stringify({product:value}),content_hash=hash(body),id=hash([url,content_hash]);
  db.prepare('INSERT OR IGNORE INTO catalog_documents VALUES(?,?,?,?,?)').run(id,url,content_hash,body,stamp);
  db.prepare('INSERT OR REPLACE INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
    .run(url,id,stamp,'2099-01-01T00:00:00Z');
  return {id,url,content_hash,body,fetched_at:stamp};
}

describe('known audiobook verification', () => {
  it('rejects an unrelated title despite otherwise matching exact product identity',async()=>{
    const workId=importWork(db,seed,book,doc),before=importedState();
    const wrong={...product,title:'An Entirely Different Adventure'};
    expect(()=>verifyAudioProduct({product:wrong},wrong.asin,seed,book.number,book.author,book.title)).toThrow(/title conflicts/);
    const request=vi.fn().mockResolvedValue(new Response(JSON.stringify({product:wrong}),{headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',request);
    const payload={seriesId:seed.id,workId,asin:wrong.asin,sourceUrl:doc.url};
    await expect(processAudio(db,payload,[seed])).rejects.toThrow(/title conflicts/);
    await expect(processAudio(db,payload,[seed])).rejects.toThrow(/title conflicts/);
    expect(importedState()).toEqual(before);
    expect(request).toHaveBeenCalledOnce();
    const retained=db.prepare('SELECT body FROM catalog_documents WHERE url=?').get(audioProductUrl(wrong.asin)) as {body:string};
    expect(JSON.parse(retained.body).product.title).toBe(wrong.title);
  });
  it.each(['Test Series: ','Test Series 1: ','Test Series, Book 1: '])('does not discard a conflicting story title after %s',prefix=>{
    const expected={...book,title:`${prefix}First Tale`};
    const workId=importWork(db,seed,expected,doc),work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    const wrong={...product,title:`${prefix}Second Tale`},before=importedState();
    expect(()=>verifyAudioProduct({product:wrong},wrong.asin,seed,work.number,work.author,work.title)).toThrow(/title conflicts/);
    expect(()=>importAudioProduct(db,seed,work,wrong,doc)).toThrow(/title conflicts/);
    expect(importedState()).toEqual(before);
  });
  it('checks title compatibility for a direct import even when no verifier was called first',()=>{
    const workId=importWork(db,seed,book,doc),work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    importAudioProduct(db,seed,work,product,retainedProduct());
    const before=importedState();
    expect(()=>importAudioProduct(db,seed,work,{...product,title:'Another Story'},doc)).toThrow(/title conflicts/);
    expect(importedState()).toEqual(before);
  });
  it('does not let a direct caller substitute a different canonical title snapshot',()=>{
    const workId=importWork(db,seed,book,doc),work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    const before=importedState();
    expect(()=>importAudioProduct(db,seed,{...work,title:'A Caller Supplied Title'},{...product,title:'A Caller Supplied Title'},doc)).toThrow(/Canonical work identity changed/);
    expect(importedState()).toEqual(before);
  });
  it('rechecks the current canonical title after a product request was in flight',async()=>{
    const workId=importWork(db,seed,book,doc);
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>{
      db.prepare('UPDATE catalog_works SET title=? WHERE id=?').run('A Corrected Canonical Title',workId);
      return new Response(JSON.stringify({product}),{headers:{'content-type':'application/json'}});
    }));
    await expect(processAudio(db,{seriesId:seed.id,workId,asin:product.asin,sourceUrl:doc.url},[seed])).rejects.toThrow(/Canonical work identity changed/);
    expect(db.prepare('SELECT title FROM catalog_works WHERE id=?').get(workId)).toEqual({title:'A Corrected Canonical Title'});
    expect(db.prepare('SELECT * FROM books').all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM catalog_editions WHERE format='audiobook'").all()).toHaveLength(0);
  });
  it.each([
    {authors:[{name:'Unexpected Author'}]}, {series:[{title:seed.title,sequence:'2'}]},
    {series:[{title:'Another Series',sequence:'1'}]}, {format_type:'abridged'}, {language:'german'}
  ])('a matching title cannot bypass the other identity checks in direct imports: %j',changed=>{
    const workId=importWork(db,seed,book,doc),work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    const before=importedState();
    expect(()=>importAudioProduct(db,seed,work,{...product,...changed},doc)).toThrow(ReviewError);
    expect(importedState()).toEqual(before);
  });
  it.each([
    ['First Tale','Test Series, Book 1: First Tale'],
    ['First Tale','First Tale: A Fantasy LitRPG Adventure'],
    ['Test Series 1','Test Series Book One'],
    ['Test Series 1','Test Series 1: A Fantasy LitRPG Adventure']
  ])('accepts the supported canonical/retailer title pair %s / %s', (title,audioTitle)=>{
    const workId=importWork(db,seed,{...book,title},doc),work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    const known={...product,title:audioTitle};
    expect(()=>verifyAudioProduct({product:known},known.asin,seed,work.number,work.author,work.title)).not.toThrow();
    importAudioProduct(db,seed,work,known,retainedProduct(known));
    expect(db.prepare('SELECT title FROM catalog_works WHERE id=?').get(workId)).toEqual({title});
    expect(db.prepare('SELECT title FROM books WHERE id=?').get(known.asin)).toEqual({title:audioTitle});
  });
  it('does not use a bare series-and-volume title as a wildcard for a distinctive work',()=>{
    const workId=importWork(db,seed,{...book,title:'First Tale'},doc),work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    const before=importedState();
    expect(()=>importAudioProduct(db,seed,work,{...product,title:'Test Series Book 1'},doc)).toThrow(/title conflicts/);
    expect(importedState()).toEqual(before);
  });
  it('verifies a split title/subtitle but rejects a later conflicting distinctive subtitle',()=>{
    const workId=importWork(db,seed,{...book,title:'First Tale'},doc),work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    const split={...product,title:'Test Series Book 1',subtitle:'First Tale: A LitRPG Adventure'};
    expect(()=>verifyAudioProduct({product:split},split.asin,seed,work.number,work.author,work.title)).not.toThrow();
    importAudioProduct(db,seed,work,split,retainedProduct(split));
    const before=importedState();
    for(const other of [{...split,subtitle:'Second Tale: A LitRPG Adventure'},{...split,title:'Another Story'}]){
      expect(()=>verifyAudioProduct({product:other},other.asin,seed,work.number,work.author,work.title)).toThrow(/title conflicts/);
      expect(()=>importAudioProduct(db,seed,work,other,doc)).toThrow(/title conflicts/);
    }
    expect(importedState()).toEqual(before);
  });
  it('can verify numbered discovery before its title is known, without treating that as a canonical-title match',()=>{
    const discovered={...product,title:'Newly Discovered Distinct Title'};
    expect(()=>verifyAudioProduct({product:discovered},discovered.asin,seed,book.number,book.author)).not.toThrow();
    expect(()=>verifyAudioProduct({product:discovered},discovered.asin,seed,book.number,book.author,book.title)).toThrow(/title conflicts/);
  });
  it('requires retained exact product facts for a direct import, not a synthesized product with a source ID',()=>{
    const workId=importWork(db,seed,book,doc),work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    const exact=retainedProduct(),before=importedState();
    expect(()=>importAudioProduct(db,seed,work,product,doc)).toThrow(/exact current retained product document/);
    expect(()=>importAudioProduct(db,seed,work,product,{...exact,id:'unretained'})).toThrow(/exact current retained product document/);
    const invented={...product,release_date:'2026-08-01',narrators:[{name:'Invented Narrator'}]};
    expect(()=>verifyCanonicalAudioProduct(db,{product:invented},product.asin,seed,work,exact)).toThrow(/exact current retained product document/);
    expect(()=>importAudioProduct(db,seed,work,invented,exact)).toThrow(/exact current retained product document/);
    const body=JSON.stringify({product:invented});
    expect(()=>importAudioProduct(db,seed,work,invented,{...exact,body,content_hash:hash(body)})).toThrow(/exact current retained product document/);
    expect(()=>importAudioProduct(db,seed,work,product,{...exact,fetched_at:'2026-09-20T00:00:00Z'})).toThrow(/exact current retained product document/);
    expect(importedState()).toEqual(before);
  });
  it('rejects a retained product copied from another endpoint or corrupted after retention',()=>{
    const workId=importWork(db,seed,book,doc),work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    const other=retainedProduct(product,audioProductUrl('B000000002')),before=importedState();
    expect(()=>importAudioProduct(db,seed,work,product,other)).toThrow(/exact current retained product document/);
    const exact=retainedProduct();
    db.prepare('UPDATE catalog_documents SET body=body||? WHERE id=?').run(' ',exact.id);
    expect(()=>importAudioProduct(db,seed,work,product,exact)).toThrow(/exact current retained product document/);
    expect(importedState()).toEqual(before);
  });
  it('will not re-import old product proof after a newer query variant has become current',()=>{
    const workId=importWork(db,seed,book,doc),work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    const exact=retainedProduct();
    importAudioProduct(db,seed,work,product,exact);
    retainedProduct({...product,title:'Different Current Work'},`https://api.audible.com/1.0/catalog/products/${product.asin}?response_groups=series`,'2026-09-19T01:00:00Z');
    const before=importedState();
    expect(()=>importAudioProduct(db,seed,work,product,exact)).toThrow(/exact current retained product document/);
    expect(importedState()).toEqual(before);
  });
  it('verifies a solo-authored volume in a series with a broader reviewed coauthor roster',async()=>{
    const collaboration={...seed,author:'Test Author, Co Author',authorAliases:[...seed.authorAliases,'Co Author']};
    const workId=importWork(db,collaboration,book,doc);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({product}),{headers:{'content-type':'application/json'}})));
    await processAudio(db,{seriesId:seed.id,workId,asin:product.asin,sourceUrl:doc.url},[collaboration]);
    expect(db.prepare('SELECT author FROM catalog_works WHERE id=?').get(workId)).toEqual({author:'Test Author'});
    expect(db.prepare('SELECT author FROM books WHERE id=?').get(product.asin)).toEqual({author:'Test Author'});
    const work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    expect(()=>importAudioProduct(db,collaboration,{...work,author:'Unrelated Author'},product,doc)).toThrow(/Canonical work identity/);
    const wrong={...product,authors:[{name:'Co Author'}]};
    expect(()=>verifyAudioProduct({product:wrong},product.asin,collaboration,1,work.author)).toThrow(/selected work/);
    expect(()=>importAudioProduct(db,collaboration,work,wrong,doc)).toThrow(/selected work/);
    const joint={...work,author:'Test Author, Co Author'};
    expect(()=>verifyAudioProduct({product},product.asin,collaboration,1,joint.author)).toThrow(/selected work/);
  });
  it('records exact product proof resolving a quarantined incomplete legacy row',async()=>{
    db.prepare('INSERT INTO books(id,title,author,release_date) VALUES(?,?,?,?)').run(product.asin,'Old incomplete listing',seed.author,'');
    const workId=importWork(db,seed,book,doc);
    expect(db.prepare("SELECT status FROM catalog_jobs WHERE kind='review-edition'").get()).toEqual({status:'review'});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({product}),{headers:{'content-type':'application/json'}})));
    await processAudio(db,{seriesId:seed.id,workId,asin:product.asin,sourceUrl:doc.url},[seed]);
    const resolution=db.prepare("SELECT status,result_json,payload_json,last_error FROM catalog_jobs WHERE kind='review-edition'").get() as {status:string;result_json:string;payload_json:string;last_error:string};
    expect(resolution.status).toBe('completed');
    expect(JSON.parse(resolution.result_json)).toMatchObject({resolution:'verified-exact-product',workId,asin:product.asin});
    expect(JSON.parse(resolution.payload_json).existingTitle).toBe('Old incomplete listing');
    expect(resolution.last_error).toContain('conflicting edition');
    expect(db.prepare('SELECT series_number FROM books WHERE id=?').get(product.asin)).toEqual({series_number:1});
  });
  it('does not silently rebind a changed canonical work during a cached audio refresh',async()=>{
    const workId=importWork(db,seed,book,doc),payload={seriesId:seed.id,workId,asin:product.asin,sourceUrl:doc.url};
    const request=vi.fn().mockResolvedValue(new Response(JSON.stringify({product}),{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',request);
    await processAudio(db,payload,[seed]);
    const binding=db.prepare('SELECT identifiers_json FROM catalog_editions WHERE legacy_book_id=?').get(product.asin);
    db.prepare('UPDATE catalog_works SET title=? WHERE id=?').run('Another book at the same number',workId);
    await expect(processAudio(db,payload,[seed])).rejects.toThrow(/title conflicts with the selected canonical work/);
    expect(db.prepare('SELECT identifiers_json FROM catalog_editions WHERE legacy_book_id=?').get(product.asin)).toEqual(binding);
    expect(request).toHaveBeenCalledOnce();
  });
  it('checks a preorder by its release day and never extends freshness during cache-only processing',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-19T00:00:00Z'));
    const workId=importWork(db,seed,book,doc),payload={seriesId:seed.id,workId,asin:product.asin,sourceUrl:doc.url};
    const request=vi.fn().mockResolvedValue(new Response(JSON.stringify({product:{...product,release_date:'2026-09-21'}}),{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',request);
    await processAudio(db,payload,[seed]);
    const due=()=>db.prepare('SELECT next_check_at FROM catalog_urls WHERE url=?').get(audioProductUrl(product.asin));
    expect(due()).toEqual({next_check_at:'2026-09-21T00:00:00.000Z'});
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    await processAudio(db,payload,[seed]);
    expect(due()).toEqual({next_check_at:'2026-09-21T00:00:00.000Z'});
    expect(request).toHaveBeenCalledOnce();
  });
  it('rejects a wrong-volume buy link even in a completely fresh catalog', async () => {
    const workId=importWork(db,seed,book,doc);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({product:{...product,series:[{title:seed.title,sequence:'6'}]}}),{headers:{'content-type':'application/json'}})));
    await expect(processAudio(db,{seriesId:seed.id,workId,asin:product.asin,sourceUrl:doc.url},[seed])).rejects.toThrow(ReviewError);
    expect(db.prepare('SELECT * FROM books').all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM catalog_editions WHERE format='audiobook'").all()).toHaveLength(0);
  });
  it('promotes exact audio facts and replays its saved response without fetching again', async () => {
    const workId=importWork(db,seed,book,doc),payload={seriesId:seed.id,workId,asin:product.asin,sourceUrl:doc.url};
    const request=vi.fn().mockResolvedValue(new Response(JSON.stringify({product}),{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',request);
    expect(await processAudio(db,payload,[seed])).toMatchObject({downloaded:true});
    expect(await processAudio(db,payload,[seed])).toMatchObject({downloaded:false});
    expect(request).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT release_date,narrator,runtime_minutes FROM books').get()).toEqual({release_date:'2025-03-01',narrator:'Good Narrator',runtime_minutes:720});
    expect(db.prepare("SELECT release_date FROM catalog_editions WHERE format='ebook'").get()).toEqual({release_date:'2025-01-01'});
    expect(db.prepare('SELECT source_description FROM catalog_works').get()).toEqual({source_description:book.description});
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_claims WHERE method='retailer-api'").get()).toEqual({n:12});
  });
  it('uses the full publisher summary and removes only obsolete availability boilerplate', () => {
    const full='<p>This title will be streaming in Audible Plus through September 1st, 2021.</p><p>A healer meets a merchant.</p><p>They enter the forest.</p>';
    expect(productDescription({...product,publisher_summary:full})).toBe('A healer meets a merchant. They enter the forest.');
    expect(productDescription({...product,publisher_summary:'  '})).toBe(product.merchandising_summary);
    expect(audioProductUrl(product.asin)).toContain('product_extended_attrs');
  });
  it('upgrades a clipped API work description while preserving substantial primary copy', () => {
    const workId=importWork(db,seed,book,doc),full=book.description.repeat(4);
    db.prepare('UPDATE catalog_works SET source_url=?,source_description=? WHERE id=?').run(audioProductUrl(product.asin),'A clipped synopsis from the earlier API.',workId);
    let work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    const fullProduct={...product,publisher_summary:full},exact=retainedProduct(fullProduct);
    importAudioProduct(db,seed,work,fullProduct,exact);
    expect(db.prepare('SELECT source_description FROM catalog_works WHERE id=?').get(workId)).toEqual({source_description:full});
    const preferred=book.description.repeat(3);
    db.prepare('UPDATE catalog_works SET source_url=?,source_description=? WHERE id=?').run(doc.url,preferred,workId);
    work=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(workId) as WorkRow;
    importAudioProduct(db,seed,work,fullProduct,exact);
    expect(db.prepare('SELECT source_description FROM catalog_works WHERE id=?').get(workId)).toEqual({source_description:preferred});
  });
  it('does not reuse a cached identifier stub or send its conditional validators', async () => {
    const url=audioProductUrl(product.asin),body=JSON.stringify({product:{asin:product.asin}});
    db.prepare('INSERT INTO catalog_documents VALUES(?,?,?,?,?)').run('stub',url,'stub-hash',body,'2020-01-01T00:00:00Z');
    db.prepare('INSERT INTO catalog_urls(url,document_id,etag,checked_at,next_check_at) VALUES(?,?,?,?,?)').run(url,'stub','bad-etag','2020-01-01T00:00:00Z','2999-01-01T00:00:00Z');
    const request=vi.fn().mockResolvedValue(new Response(JSON.stringify({product}),{headers:{'content-type':'application/json'}}));
    const result=await getDocument(db,url,{format:'audible-product',request});
    expect(result.downloaded).toBe(true);
    expect(request.mock.calls[0][1].headers).not.toHaveProperty('If-None-Match');
    expect(result.document.id).not.toBe('stub');
  });
  it('does not infer volume membership from a partial sequence, unexpected coauthor, or bundle', () => {
    for(const changed of [{series:[{title:seed.title,sequence:'1-3.5'}]},{authors:[{name:'Test Author'},{name:'Other Author'}]},{title:'Test Series: Books 1–3'},{language:'german'},{asin:'B000000002'}]) {
      expect(()=>verifyAudioProduct({product:{...product,...changed}},product.asin,seed,1)).toThrow(ReviewError);
    }
    expect(()=>verifyAudioProduct({product:{...product,authors:[{name:'Test Author'},{name:'Test Pen Name'}]}},product.asin,seed,1)).not.toThrow();
    expect(()=>audioProductUrl('../search')).toThrow(ReviewError);
  });
  it('does not cache an empty HTTP-200 product response or mutate known work data', async () => {
    const workId=importWork(db,seed,book,doc);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{headers:{'content-type':'application/json'}})));
    await expect(processAudio(db,{seriesId:seed.id,workId,asin:product.asin,sourceUrl:doc.url},[seed])).rejects.toThrow(/no product/);
    expect(db.prepare('SELECT * FROM catalog_urls').all()).toHaveLength(0);
    expect(db.prepare('SELECT title,source_description FROM catalog_works').get()).toEqual({title:book.title,source_description:book.description});
  });
  it('retains the last good source when a refresh returns only an identifier stub', async () => {
    const workId=importWork(db,seed,book,doc),payload={seriesId:seed.id,workId,asin:product.asin,sourceUrl:doc.url};
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({product}),{headers:{'content-type':'application/json'}})));
    await processAudio(db,payload,[seed]);
    const url=audioProductUrl(product.asin),before=db.prepare('SELECT document_id FROM catalog_urls WHERE url=?').get(url);
    db.prepare("UPDATE catalog_urls SET checked_at='2020-01-01T00:00:00Z'").run();
    const request=vi.fn().mockResolvedValue(new Response(JSON.stringify({product:{asin:product.asin}}),{headers:{'content-type':'application/json'}}));
    await expect(getDocument(db,url,{format:'audible-product',force:true,request})).rejects.toThrow(/identifier stub/);
    expect(db.prepare('SELECT document_id FROM catalog_urls WHERE url=?').get(url)).toEqual(before);
    expect(db.prepare('SELECT title,narrator FROM books').get()).toEqual({title:product.title,narrator:'Good Narrator'});
  });
});
