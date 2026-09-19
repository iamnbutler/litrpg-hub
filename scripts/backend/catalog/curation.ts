import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { hash } from './queue.js';
import { importWork } from './import.js';
import type { Document, ExtractedBook, SeedSeries } from './types.js';
interface CuratedEvidence {seriesId:string;sourceUrl:string;observedAt:string;method:'curated-source-summary';book:ExtractedBook}
/** Import reviewable, attributed research notes without pretending they are a scraped page. */
export function importCuratedEvidence(db:Database.Database,seeds:SeedSeries[],file=new URL('../config/curated-evidence.json',import.meta.url)):number {
  const entries=JSON.parse(readFileSync(file,'utf8')) as CuratedEvidence[];
  if(!Array.isArray(entries)||entries.length>1000)throw new Error('Invalid curated evidence file.');
  let count=0;
  for(const entry of entries){
    const seed=seeds.find(s=>s.id===entry.seriesId);if(!seed)continue;
    if(entry.method!=='curated-source-summary'||!Number.isFinite(Date.parse(entry.observedAt)))throw new Error('Curated evidence must name its method and observation time.');
    // A reviewed citation does not grant the crawler access to another host. No network
    // request occurs here; actual crawl adapters retain their separate host allowlist.
    const citation=new URL(entry.sourceUrl);
    if(citation.protocol!=='https:'||citation.username||citation.password||citation.port)throw new Error('Curated evidence needs a public HTTPS citation.');
    citation.hash='';
    const url=citation.href,body=JSON.stringify(entry),contentHash=hash(body),id=hash([url,contentHash]);
    const doc:Document={id,url,content_hash:contentHash,body,fetched_at:entry.observedAt,method:entry.method};
    db.transaction(()=>{db.prepare('INSERT OR IGNORE INTO catalog_documents(id,url,content_hash,body,fetched_at) VALUES(?,?,?,?,?)').run(id,url,contentHash,body,entry.observedAt);importWork(db,seed,entry.book,doc);})();count++;
  }
  return count;
}
