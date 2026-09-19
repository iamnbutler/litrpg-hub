import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { normalizeIdentity, seriesIdentity } from '../../../src/lib/catalog.js';
import { getDocument } from './sources.js';
import { ADAPTER_VERSION,aethonPageLinks,sbtPageLinks,linksFrom,parseAethonBook,parseSbtBook,parsePrhBook } from './adapters.js';
import { enqueue,hash } from './queue.js';
import { importWork,sourceName,retainClaim } from './import.js';
import { ReviewError,type SeedSeries,type SourcePayload,type Document } from './types.js';
import { parsePodiumBook, parsePortalAuthor, podiumSeriesLinks } from './publisher-adapters.js';
import { chatfieldSeriesLinks, parseBagwellBooks, parseChatfieldBook } from './author-adapters.js';
import { mountaindaleSeriesLinks, parseMountaindaleBook } from './mountaindale-adapter.js';
import { grandGameSeriesBooks, parseGrandGameBook, parseNovaRoma } from './author-series.js';
import { resolveAudioLink } from './audio-links.js';
import { enqueueAudio } from './audio.js';
import { parseDivineApostasy } from './apostasy-adapter.js';
import { enqueueIdentifiedAudioLeads } from './identified-audio.js';

export const seeds=JSON.parse(readFileSync(new URL('../config/catalog-seeds.json',import.meta.url),'utf8')) as SeedSeries[];
export function enqueueSource(db:Database.Database,payload:SourcePayload,priority=0) {
  return enqueue(db,'source',payload.url,hash({version:payload.adapter==='sbt-index'?'sbt-index-v2':ADAPTER_VERSION,...payload}),payload,priority);
}
export function seedCatalog(db:Database.Database,registry:SeedSeries[]=seeds,options:{includeIndexes?:boolean}={}):number {
  let added=0;
  db.transaction(()=>{
    for(const seed of registry) {
      const prior=db.prepare('SELECT title,author,aliases_json FROM catalog_series WHERE id=?').get(seed.id) as {title:string;author:string;aliases_json:string}|undefined;
      // Published identities are permanent reading-history aliases, even after a retitle
      // or a cleanup of the seed's display aliases. A refresh must never drop them.
      const aliases=[...new Set([...(prior?JSON.parse(prior.aliases_json) as string[]:[]),...(prior?[prior.title,seriesIdentity(prior.title,prior.author)]:[]),...seed.aliases,...[seed.title,...seed.aliases].flatMap(title=>seed.authorAliases.map(author=>seriesIdentity(title,author)))])];
      db.prepare(`INSERT INTO catalog_series(id,title,author,aliases_json,genres_json,status,priority,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,aliases_json=excluded.aliases_json,genres_json=excluded.genres_json,status=excluded.status,priority=excluded.priority`)
        .run(seed.id,seed.title,seed.author,JSON.stringify(aliases),JSON.stringify(seed.genres),seed.statusEvidence?seed.status??'unknown':'unknown',seed.priority,new Date().toISOString());
      if(seed.statusEvidence){
        const evidence=seed.statusEvidence,url=new URL(evidence.url).href;
        if(!url.startsWith('https://')||!Number.isFinite(Date.parse(evidence.observedAt)))throw new Error('Series status requires a dated public source.');
        const body=JSON.stringify({method:'curated-source-summary',seriesId:seed.id,status:seed.status,...evidence}),contentHash=hash(body),id=hash([url,contentHash]);
        const doc:Document={id,url,content_hash:contentHash,body,fetched_at:evidence.observedAt,method:'curated-source-summary'};
        db.prepare('INSERT OR IGNORE INTO catalog_documents VALUES(?,?,?,?,?)').run(id,url,contentHash,body,evidence.observedAt);
        retainClaim(db,'series',seed.id,'status',{value:seed.status,summary:evidence.summary},doc);
      }
      for(const source of seed.sources) added+=Number(enqueueSource(db,{...source,seriesId:seed.id},200+seed.priority));
    }
    // Selecting another series must reuse the publisher index already in the catalog.
    // Completed index jobs need not be fetched again just to discover the same link.
    const candidates=db.prepare('SELECT url,title FROM catalog_candidates').all() as {url:string;title:string}[];
    for(const candidate of candidates){
      const seed=registry.find(s=>[s.title,...s.aliases].some(title=>normalizeIdentity(title)===normalizeIdentity(candidate.title)));
      if(!seed)continue;
      const url=new URL(candidate.url);
      const adapter=url.hostname==='aethonbooks.com'&&url.pathname.startsWith('/book-series/')?'aethon-series'
        :url.hostname==='soundbooththeater.com'&&url.pathname.startsWith('/series/')?'sbt-series':null;
      if(!adapter)continue;
      added+=Number(enqueueSource(db,{url:candidate.url,adapter,seriesId:seed.id},200+seed.priority));
      db.prepare("UPDATE catalog_candidates SET status='selected' WHERE url=?").run(candidate.url);
    }
    if(options.includeIndexes!==false){
      added+=Number(enqueueSource(db,{url:'https://aethonbooks.com/litrpg/',adapter:'aethon-index'},400));
      added+=Number(enqueueSource(db,{url:'https://soundbooththeater.com/series/',adapter:'sbt-index'},400));
    }
  })();
  return added;
}
function discover(db:Database.Database,doc:Document,adapter:SourcePayload['adapter']):number {
  const aethon=adapter==='aethon-index',links=linksFrom(doc.body,doc.url,aethon?'/book-series/':'/series/');
  if(!links.length) throw new ReviewError('Publisher index contains no series; not treating it as an empty catalog.');
  for(const link of links) {
    if(!link.title) continue;
    const selected=seeds.find(s=>[s.title,...s.aliases].some(t=>normalizeIdentity(t)===normalizeIdentity(link.title)));
    db.prepare(`INSERT INTO catalog_candidates(url,title,source_name,document_id,status,discovered_at) VALUES(?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET title=excluded.title,document_id=excluded.document_id,status=CASE WHEN excluded.status='selected' THEN 'selected' ELSE catalog_candidates.status END`)
      .run(link.url,link.title,sourceName(doc.url),doc.id,selected?'selected':'discovered',doc.fetched_at);
    if(selected)enqueueSource(db,{url:link.url,adapter:aethon?'aethon-series':'sbt-series',seriesId:selected.id},200+selected.priority);
  }
  if(aethon) for(const url of aethonPageLinks(doc.body,doc.url))enqueueSource(db,{url,adapter:'aethon-index'},400);
  else for(const url of sbtPageLinks(doc.body,doc.url))enqueueSource(db,{url,adapter:'sbt-index'},400);
  return links.length;
}
export async function processSource(db:Database.Database,payload:SourcePayload,registry:readonly SeedSeries[]=seeds) {
  const {document:doc,downloaded}=await getDocument(db,payload.url,{ttlDays:payload.adapter.endsWith('index')||payload.adapter.endsWith('series')||payload.adapter.endsWith('author')?7:90});
  if(payload.adapter.endsWith('index')) return {downloaded,candidates:discover(db,doc,payload.adapter)};
  const seed=registry.find(s=>s.id===payload.seriesId);
  if(!seed) throw new ReviewError('Source job has no selected series identity.');
  if(payload.adapter==='sarah-lin-author') return {downloaded,...enqueueIdentifiedAudioLeads(db,seed,doc)};
  if(payload.adapter==='portal-author'||payload.adapter==='bagwell-author'||payload.adapter==='nova-roma-author'||payload.adapter==='apostasy-author'){
    const books=payload.adapter==='apostasy-author'?parseDivineApostasy(doc.body,seed,doc.url):payload.adapter==='nova-roma-author'?parseNovaRoma(doc.body,seed):payload.adapter==='bagwell-author'?parseBagwellBooks(doc.body,seed):parsePortalAuthor(doc.body,seed);
    if(!books.length)throw new ReviewError('Publisher author page has no identifiable books for the selected series.');
    const evidence:Document=payload.adapter==='apostasy-author'?{...doc,method:'curated-title-mapping'}:doc;
    const ids=db.transaction(()=>books.map(book=>importWork(db,seed,book,evidence)))();
    retainClaim(db,'series',seed.id,'bookList',books.map(b=>({title:b.title,number:b.number})),evidence);
    return {downloaded,works:ids.length};
  }
  if(payload.adapter==='grand-game-series'){
    const entries=grandGameSeriesBooks(doc.body,seed);
    db.transaction(()=>{
      for(const entry of entries){
        importWork(db,seed,entry.book,doc);
        enqueueSource(db,{url:entry.url,adapter:'grand-game-book',seriesId:seed.id,number:entry.book.number,parentDocumentId:doc.id},100+seed.priority);
      }
      retainClaim(db,'series',seed.id,'bookList',entries.map(entry=>({title:entry.book.title,number:entry.book.number,url:entry.url})),doc);
    })();
    return{downloaded,works:entries.length};
  }
  if(payload.adapter==='grand-game-book'){
    const parent=payload.parentDocumentId?db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(payload.parentDocumentId) as Document|undefined:undefined;
    const mapping=parent?grandGameSeriesBooks(parent.body,seed).find(entry=>entry.url===payload.url&&entry.book.number===payload.number):undefined;
    if(!mapping)throw new ReviewError('Author book needs its retained parent URL and explicit volume mapping.');
    const book=parseGrandGameBook(doc.body,seed,mapping.book.number),id=importWork(db,seed,book,doc);
    for(const link of book.links.filter(link=>link.format==='audiobook'&&!link.asin&&new URL(link.url).hostname==='amzn.to')){
      const resolution=await resolveAudioLink(db,link.url);
      retainClaim(db,'work',id,'audioIdentifierCandidate',{asin:resolution.asin,authorLink:link.url},resolution.document);
      enqueueAudio(db,{seriesId:seed.id,workId:id,asin:resolution.asin,sourceUrl:link.url},seed.priority);
    }
    return{downloaded,work:id,number:book.number,title:book.title};
  }
  if(payload.adapter.endsWith('series')) {
    const aethon=payload.adapter==='aethon-series',sbt=payload.adapter==='sbt-series',podium=payload.adapter==='podium-series';
    const links=payload.adapter==='mountaindale-series'?mountaindaleSeriesLinks(doc.body,doc.url,seed):payload.adapter==='chatfield-series'?chatfieldSeriesLinks(doc.body,doc.url):podium?podiumSeriesLinks(doc.body,doc.url):linksFrom(doc.body,doc.url,aethon?'/book/':sbt?'/shop/audiobooks/':'/books/');
    const selected=sbt?links.filter(l=>/\bBook\s+\d+(?:\.\d+)?:/i.test(l.title)):links;
    if(!selected.length)throw new ReviewError('Series page has no identifiable full books.');
    if(selected.length>150)throw new ReviewError('Series page exceeded the bounded discovery limit.');
    retainClaim(db,'series',seed.id,'bookLinks',selected,doc);
    for(const link of selected)enqueueSource(db,{url:link.url,adapter:payload.adapter==='mountaindale-series'?'mountaindale-book':payload.adapter==='chatfield-series'?'chatfield-book':aethon?'aethon-book':sbt?'sbt-book':podium?'podium-book':'prh-book',seriesId:seed.id},100+seed.priority);
    return {downloaded,books:selected.length,otherProductions:links.length-selected.length};
  }
  const book=payload.adapter==='mountaindale-book'?parseMountaindaleBook(doc.body,seed,doc.url):payload.adapter==='chatfield-book'?parseChatfieldBook(doc.body):payload.adapter==='aethon-book'?parseAethonBook(doc.body):payload.adapter==='sbt-book'?parseSbtBook(doc.body):payload.adapter==='prh-book'?parsePrhBook(doc.body):payload.adapter==='podium-book'?parsePodiumBook(doc.body):null;
  if(!book)throw new ReviewError('This source needs an adapter before it can be imported.');
  return {downloaded,work:importWork(db,seed,book,doc),number:book.number,title:book.title};
}
