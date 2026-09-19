import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioProductUrl, importAudioProduct, verifyAudioProduct, verifyCanonicalAudioProduct } from './audio.js';
import { audioWorkIdentity, resolveAudioTitleAlias, type AudioTitleAliasReview } from './audio-title-aliases.js';
import { hash } from './queue.js';
import { ReviewError, type Document, type SeedSeries, type WorkRow } from './types.js';

// All source text and product metadata are synthetic, retained only in the test database.
const AT='2026-09-19T00:00:00.000Z', LATER='2026-09-19T00:05:00.000Z';
const ASIN='B000000001', primaryUrl='https://aethonbooks.com/book/the-sheltered-valley/';
const seed:SeedSeries={id:'synthetic-coast',title:'Synthetic Coast',author:'Synthetic Writer',authorAliases:['Synthetic Writer'],
  aliases:[],genres:['litrpg'],priority:1,sources:[{url:'https://aethonbooks.com/book-series/synthetic-coast/',adapter:'aethon-series'}]};
const product={asin:ASIN,title:seed.title,language:'english',format_type:'unabridged',content_type:'Product',
  authors:[{name:seed.author}],series:[{title:seed.title,sequence:'1'}],release_date:'2025-01-02'};
const html=(link=`https://www.audible.com/pd/${ASIN}`)=>`<html><h1>The Sheltered Valley</h1><p>Synthetic Coast Book 1 by Synthetic Writer</p><a href="${link}">Buy the audiobook</a></html>`;
let db:Database.Database, primary:Document, exact:Document, work:WorkRow, review:AudioTitleAliasReview;
function retain(url:string,body:string,at=AT):Document {
  const content_hash=hash(body),id=hash([url,content_hash]);
  db.prepare('INSERT OR IGNORE INTO catalog_documents VALUES(?,?,?,?,?)').run(id,url,content_hash,body,at);
  db.prepare('INSERT OR REPLACE INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)').run(url,id,at,'2099-01-01T00:00:00Z');
  return {id,url,content_hash,body,fetched_at:at};
}
const reference=(doc:Document)=>({documentId:doc.id,url:doc.url,contentHash:doc.content_hash});
const verify=(reviews:readonly AudioTitleAliasReview[]=[review],doc=exact)=>verifyCanonicalAudioProduct(db,JSON.parse(doc.body),ASIN,seed,work,doc,{titleAliases:reviews});
beforeEach(()=>{
  db=new Database(':memory:');db.pragma('foreign_keys=ON');
  for(const name of ['001_initial.sql','006_catalog_pipeline.sql'])db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id,seed.title,seed.author,AT);
  db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('work-synthetic-coast-1',seed.id,1,'The Sheltered Valley',seed.author,primaryUrl,AT);
  work=db.prepare('SELECT * FROM catalog_works').get() as WorkRow;
  primary=retain(primaryUrl,html());exact=retain(audioProductUrl(ASIN),JSON.stringify({product}));
  review={id:'synthetic-coast-audio-title-review',workId:work.id,workIdentityHash:audioWorkIdentity(work),asin:ASIN,
    canonicalTitle:work.title,retailerTitle:product.title,reviewedAt:'2026-09-19T00:10:00.000Z',reviewedBy:'Synthetic source review',
    primary:{...reference(primary),sourceType:'publisher'},product:reference(exact)};
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-19T01:00:00.000Z'));
  vi.stubGlobal('fetch',()=>{throw new Error('No network in title-alias tests.');});
});
afterEach(()=>{db.close();vi.useRealTimers();vi.unstubAllGlobals();});

describe('reviewed recording title aliases',()=>{
  it('requires explicit review of a semantic alias and keeps the canonical title unchanged',()=>{
    expect(resolveAudioTitleAlias(db,seed,work,ASIN,product.title,exact,[])).toBeNull();
    expect(()=>verify([])).toThrow(/title conflicts/);
    expect(()=>verifyAudioProduct({product},ASIN,seed,1,work.author,work.title)).toThrow(/title conflicts/);
    expect(verify()).toEqual(product);
    importAudioProduct(db,seed,work,product,exact,{titleAliases:[review]});
    expect(db.prepare('SELECT title FROM catalog_works WHERE id=?').get(work.id)).toEqual({title:work.title});
    const edition=db.prepare('SELECT title,identifiers_json FROM catalog_editions WHERE legacy_book_id=?').get(ASIN) as {title:string;identifiers_json:string};
    expect(edition.title).toBe(product.title);
    expect(JSON.parse(edition.identifiers_json)).toMatchObject({verifiedDocument:exact.id,workIdentityHash:audioWorkIdentity(work),marketplace:'US'});
  });
  it.each([
    {workId:'work-another-1'}, {workIdentityHash:hash('changed identity')}, {canonicalTitle:'Other canonical title'},
    {retailerTitle:'Other retailer title'}, {reviewedAt:'not-a-date'}, {reviewedAt:'2026-09-20T00:00:00.000Z'},
    {reviewedAt:'2026-09-18T00:00:00.000Z'}, {reviewedBy:''}
  ])('rejects an unbound or invalid review: %j',change=>{
    expect(()=>verify([{...review,...change}])).toThrow(/alias is stale, conflicting/);
    expect(()=>importAudioProduct(db,seed,work,product,exact,{titleAliases:[{...review,...change}]})).toThrow(ReviewError);
    expect(db.prepare('SELECT * FROM books').all()).toHaveLength(0);
  });
  it('rejects competing claims for the same recording instead of choosing the first review',()=>{
    expect(()=>verify([review,{...review,id:'second-review'}])).toThrow(/alias is stale, conflicting/);
    expect(()=>verify([{...review,workId:'another-work'},review])).toThrow(/alias is stale, conflicting/);
  });
  it.each([
    {authors:[{name:'Another Writer'}]}, {series:[{title:seed.title,sequence:'2'}]},
    {series:[{title:'Another Series',sequence:'1'}]}, {language:'german'}, {format_type:'abridged'}
  ])('cannot relax recording identity checks: %j',change=>{
    const other={...product,...change};
    expect(()=>verifyCanonicalAudioProduct(db,{product:other},ASIN,seed,work,exact,{titleAliases:[review]})).toThrow(ReviewError);
    expect(()=>importAudioProduct(db,seed,work,other,exact,{titleAliases:[review]})).toThrow(ReviewError);
    expect(db.prepare('SELECT * FROM books').all()).toHaveLength(0);
  });
  it('does not transfer the review to another ASIN or a changed canonical work',()=>{
    const different='B000000002',other={...product,asin:different};
    expect(()=>verifyCanonicalAudioProduct(db,{product:other},different,seed,work,exact,{titleAliases:[review]})).toThrow(/title conflicts/);
    db.prepare('UPDATE catalog_works SET title=? WHERE id=?').run('A Corrected Canonical Work',work.id);
    expect(()=>importAudioProduct(db,seed,work,product,exact,{titleAliases:[review]})).toThrow(/Canonical work identity changed/);
    const changed=db.prepare('SELECT * FROM catalog_works').get() as WorkRow;
    expect(()=>verifyCanonicalAudioProduct(db,{product},ASIN,seed,changed,exact,{titleAliases:[review]})).toThrow(/alias is stale, conflicting/);
  });
  it('fails closed when a claimed alias is stale even if its supplied titles would otherwise match',()=>{
    const identical={...work,title:product.title};
    expect(()=>verifyCanonicalAudioProduct(db,{product},ASIN,seed,identical,exact,{titleAliases:[review]})).toThrow(/alias is stale, conflicting/);
  });
  it('requires the exact retained primary and product references, including untampered raw bodies',()=>{
    expect(()=>verify([{...review,primary:{...review.primary,documentId:'missing'}}])).toThrow(ReviewError);
    expect(()=>verify([{...review,product:{...review.product,contentHash:hash('another body')}}])).toThrow(ReviewError);
    expect(()=>verify([review],{...exact,body:JSON.stringify({product:{...product,title:'Another Book'}})})).toThrow(ReviewError);
    db.prepare('UPDATE catalog_documents SET body=body||? WHERE id=?').run('<p>Unreviewed change</p>',primary.id);
    expect(()=>verify()).toThrow(ReviewError);
  });
  it('requires a primary source on a configured author/publisher origin',()=>{
    const other=retain('https://unrelated.example/book/',html());
    expect(()=>verify([{...review,primary:{...reference(other),sourceType:'publisher'}}])).toThrow(ReviewError);
    const note=retain(primaryUrl,JSON.stringify({title:work.title,asin:ASIN}));
    expect(()=>verify([{...review,primary:{...reference(note),sourceType:'publisher'}}])).toThrow(ReviewError);
  });
  it.each([
    'https://www.audible.co.uk/pd/B000000001', 'https://www.amazon.com/dp/B000000001',
    'https://www.audible.com/pd/B000000002', 'https://www.audible.com.example/pd/B000000001',
    'https://www.audible.com/pd/Another-Book/B000000002?unrelated=B000000001'
  ])('does not treat %s as an observed exact US audio lead',link=>{
    const other=retain(primaryUrl,html(link));
    expect(()=>verify([{...review,primary:{...reference(other),sourceType:'publisher'}}])).toThrow(ReviewError);
  });
  it('invalidates a changed primary head while retaining the reviewed raw page',()=>{
    const newer=retain(primaryUrl,html()+'<p>A changed publisher bibliography.</p>',LATER);
    expect(()=>verify()).toThrow(/alias is stale, conflicting/);
    expect(db.prepare('SELECT body FROM catalog_documents WHERE id=?').get(primary.id)).toEqual({body:primary.body});
    expect(verify([{...review,primary:{...reference(newer),sourceType:'publisher'}}])).toEqual(product);
  });
  it('requires renewed review for a changed product body, even if only commerce data changed',()=>{
    const newer=retain(exact.url,JSON.stringify({product:{...product,rating:{overall_distribution:{average_rating:4.9}}}}),LATER);
    expect(()=>verify([review],newer)).toThrow(/alias is stale, conflicting/);
    expect(()=>verify([review],exact)).toThrow(/alias is stale, conflicting/);
    expect(verify([{...review,product:reference(newer)}],newer)).toMatchObject(product);
    expect(db.prepare('SELECT body FROM catalog_documents WHERE id=?').get(exact.id)).toEqual({body:exact.body});
  });
  it('does not fall back to an old reviewed product after a newer query variant was retained',()=>{
    const newer=retain(`https://api.audible.com/1.0/catalog/products/${ASIN}?response_groups=series`,JSON.stringify({product:{...product,title:'Unrelated Work'}}),LATER);
    expect(()=>verify([review],exact)).toThrow(/alias is stale, conflicting/);
    expect(()=>verify([{...review,product:reference(newer)}],newer)).toThrow(/alias is stale, conflicting/);
  });
  it('accepts an unchanged source observation without inventing a new review or mutating evidence',()=>{
    db.prepare('UPDATE catalog_urls SET checked_at=?').run(LATER);
    const before=db.prepare('SELECT * FROM catalog_documents ORDER BY id').all();
    expect(verify()).toEqual(product);
    expect(db.prepare('SELECT * FROM catalog_documents ORDER BY id').all()).toEqual(before);
  });
});
