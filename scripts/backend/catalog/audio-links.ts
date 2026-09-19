import type Database from 'better-sqlite3';
import { hash } from './queue.js';
import { ReviewError, type Document } from './types.js';

export function audioLinkAsin(value:string):string|undefined {
  let url:URL;try{url=new URL(value);}catch{return;}
  if(url.protocol!=='https:'||url.username||url.password||url.port)return;
  if(!['www.audible.com','audible.com','www.amazon.com','amazon.com'].includes(url.hostname))return;
  return url.pathname.match(/\/(?:dp|product)\/([A-Z0-9]{10})(?:\/|$)/)?.[1]
    ??url.pathname.match(/\/pd\/(?:[^/]+\/)?([A-Z0-9]{10})(?:\/|$)/)?.[1];
}
interface Resolution { kind:'observed-audio-link-v1'; from:string; to:string; asin:string }
/** Resolve only an observed, explicitly audio-labeled author buy link. A redirect supplies a
 * candidate ID, never audio facts; the exact product verifier still controls promotion. */
export async function resolveAudioLink(db:Database.Database,value:string,request:typeof fetch=fetch):Promise<{asin:string;document:Document}> {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='amzn.to'||url.username||url.password||url.port||!/^\/[A-Za-z0-9]+$/.test(url.pathname)||url.search)
    throw new ReviewError('Only a known author-provided amzn.to audio link can be resolved.');
  const row=db.prepare('SELECT document_id,next_check_at FROM catalog_urls WHERE url=?').get(url.href) as {document_id:string;next_check_at:string}|undefined;
  if(row&&row.next_check_at>new Date().toISOString()){
    const saved=db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(row.document_id) as Document|undefined;
    if(saved){try{const r=JSON.parse(saved.body) as Resolution;if(r.kind==='observed-audio-link-v1'&&r.from===url.href&&audioLinkAsin(r.to)===r.asin)return{asin:r.asin,document:{...saved,method:'retailer-link'}};}catch{}}
  }
  const response=await request(url.href,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(20_000)});
  if(response.status===429||response.status>=500)throw new Error(`Audio link returned HTTP ${response.status}; retry later.`);
  if(![301,302,303,307,308].includes(response.status))throw new ReviewError('Author audio link did not redirect to a known product.');
  const location=response.headers.get('location'),asin=location?audioLinkAsin(location):undefined;
  if(!location||!asin)throw new ReviewError('Author audio link does not resolve directly to an identified US retailer product.');
  // The destination is inspected, never followed: no product HTML or arbitrary redirects.
  const destination=new URL(location);destination.search='';destination.hash='';
  const stamp=new Date().toISOString(),body=JSON.stringify({kind:'observed-audio-link-v1',from:url.href,to:destination.href,asin} satisfies Resolution),contentHash=hash(body),id=hash([url.href,contentHash]);
  const document:Document={id,url:url.href,content_hash:contentHash,body,fetched_at:stamp,method:'retailer-link'};
  db.transaction(()=>{
    db.prepare('INSERT OR IGNORE INTO catalog_documents VALUES(?,?,?,?,?)').run(id,url.href,contentHash,body,stamp);
    db.prepare('INSERT INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET document_id=excluded.document_id,checked_at=excluded.checked_at,next_check_at=excluded.next_check_at')
      .run(url.href,id,stamp,new Date(Date.now()+30*86400000).toISOString());
  })();
  return{asin,document};
}
