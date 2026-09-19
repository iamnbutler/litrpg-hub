import type Database from 'better-sqlite3';
import { normalizeIdentity, validReleaseDate } from '../../../src/lib/catalog.js';
import { hash, enqueue } from './queue.js';
import { verifyIdentity } from './adapters.js';
import { sameAuthorCredits } from './author-identity.js';
import { AUDIO_ADAPTER_VERSION, ReviewError, type Document, type ExtractedBook, type SeedSeries, type WorkRow } from './types.js';

export function sourceName(url:string):string {
  const host=new URL(url).hostname.replace(/^www\./,'');
  const names:Record<string,string>={
    'aethonbooks.com':'Aethon Books','soundbooththeater.com':'Soundbooth Theater',
    'penguinrandomhouse.com':'Penguin Random House','podiumentertainment.com':'Podium Entertainment',
    'mountaindalepress.store':'Mountaindale Press','portal-books.com':'Portal Books',
    'audible.com':'Audible','api.audible.com':'Audible','books.apple.com':'Apple Books','books.google.com':'Google Books'
  };
  return names[host]??host;
}
export function retainClaim(db: Database.Database, entityType: string, entityId: string, field: string, value: unknown, doc: Document) {
  const json=JSON.stringify(value);
  db.prepare(`INSERT OR IGNORE INTO catalog_claims(id,entity_type,entity_id,field,value_json,document_id,method,observed_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(hash([entityType,entityId,field,json,doc.id]),entityType,entityId,field,json,doc.id,doc.method??'publisher-page',doc.fetched_at);
}
interface Legacy { id:string; title:string; subtitle:string|null; series_title:string; series_number:number|null; author:string; release_date:string; cover_url:string|null; narrator:string|null; runtime_minutes:number|null; url:string|null }
const titleKey=(title:string)=>normalizeIdentity(title.replace(/\([^)]*\)|\[[^\]]*\]/g,'').split(/:|\s[-–]\s/)[0].replace(/^the\s+/i,''));
const formatSubtitle=(value:string)=>/^(?:an?\s+)?(?:(?:epic|fantasy|military|portal|progression|deck[ -]building|cultivation|cozy|isekai|gamelit|litrpg|lit-rpg)\s*)+(?:(?:adventure|novel|series|saga|story|epic)\s*)*[.!]?$/i.test(value.trim());
function titleForms(title:string,seed:SeedSeries,number:number):Set<string>{
  for(const name of [seed.title,...seed.aliases]){
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const suffix=title.match(new RegExp(`^${escaped}\\s*(?:,?\\s*(?:Book\\s+)?${String(number).replace('.','\\.')})?\\s*[:,–-]\\s*(.+)$`,'i'))?.[1];
    // A series prefix is not a distinctive title. Keeping it as an alternate form
    // would make "Awaken Online: Precipice" equal "Awaken Online: Evolution".
    if(suffix&&!formatSubtitle(suffix))return new Set([titleKey(suffix)]);
  }
  return new Set([titleKey(title)]);
}
const sameTitle=(left:string,right:string,seed:SeedSeries,number:number)=>[...titleForms(left,seed,number)].some(t=>titleForms(right,seed,number).has(t));
export function matchesLegacy(row: Legacy, seed: SeedSeries, book: Pick<ExtractedBook,'title'|'number'|'author'>): boolean {
  if (!sameAuthorCredits(seed,row.author,book.author) ||
    ![seed.title,...seed.aliases].some(s=>normalizeIdentity(s)===normalizeIdentity(row.series_title??'')) || row.series_number!==book.number ||
    /\b(collection|omnibus|box(?:ed)? set|dramatized|dramatised|episode|books?\s*\d+\s*[-–]\s*\d+)\b/i.test(`${row.title} ${row.subtitle??''}`)) return false;
  const bare=normalizeIdentity(row.title.replace(/\([^)]*\)|\[[^\]]*\]/g,''));
  return sameTitle(row.title,book.title,seed,book.number) || bare===normalizeIdentity(`${seed.title} ${book.number}`) || bare===normalizeIdentity(`${seed.title} Book ${book.number}`);
}
export function importWork(db: Database.Database, seed: SeedSeries, book: ExtractedBook, doc: Document): string {
  verifyIdentity(book,seed);
  const id=`work-${seed.id}-${String(book.number).replace('.','_')}`, stamp=new Date().toISOString();
  return db.transaction(()=>{
    const prior=db.prepare('SELECT * FROM catalog_works WHERE id=?').get(id) as WorkRow|undefined;
    for(const field of ['title','number','author','description','releaseDate','publicationStatus','coverUrl','links','audioReleaseDate','audioRuntimeMinutes','narrator'] as const) retainClaim(db,'work',id,field,book[field],doc);
    // Keep disputed evidence for review without applying it to the existing work or
    // attaching editions matched against the new, incompatible author credit.
    if(prior&&!sameAuthorCredits(seed,prior.author,book.author)){
      const input=hash([doc.id,id,'author-credit',prior.author,book.author]);
      enqueue(db,'review-author',id,input,{seriesId:seed.id,sourceUrl:doc.url,previousAuthor:prior.author,observedAuthor:book.author},0);
      db.prepare("UPDATE catalog_jobs SET status='review',last_error=? WHERE kind='review-author' AND entity_id=? AND input_hash=?")
        .run('This work has different author credits in a later source; the existing work and editions are retained for review.',id,input);
      return id;
    }
    if(prior && !sameTitle(prior.title,book.title,seed,book.number)) throw new ReviewError('Two different titles claim the same series number; requires review.');
    const rows=db.prepare('SELECT b.*,s.title AS series_title FROM books b LEFT JOIN series s ON s.id=b.series_id').all() as Legacy[];
    const audioAsins=new Set(book.links.filter(l=>l.format==='audiobook'&&l.asin).map(l=>l.asin!));
    const conflicts=rows.filter(r=>audioAsins.has(r.id)&&!matchesLegacy(r,seed,book));
    const matches=rows.filter(r=>matchesLegacy(r,seed,book));
    const dates=[book.releaseDate,...matches.map(m=>validReleaseDate(m.release_date))].filter((d):d is string=>!!d).sort();
    const degraded=!!prior?.source_description && prior.source_url===doc.url && (book.description.trim().length<100 || book.description.trim().length<prior.source_description.length*0.35);
    const useDescription=!prior?.source_description || !degraded&&(prior.source_url===doc.url || book.description.length>prior.source_description.length);
    const date=[prior?.first_release_date,...dates].filter((d):d is string=>!!d).sort()[0]??null;
    db.prepare(`INSERT INTO catalog_works(id,series_id,number,title,author,source_description,source_url,cover_url,publication_status,first_release_date,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET source_description=excluded.source_description,source_url=excluded.source_url,cover_url=COALESCE(catalog_works.cover_url,excluded.cover_url),publication_status=excluded.publication_status,first_release_date=excluded.first_release_date,updated_at=excluded.updated_at`)
      .run(id,seed.id,book.number,book.title,book.author,useDescription?book.description:prior!.source_description,useDescription?doc.url:prior!.source_url,book.coverUrl,
        date?date<=stamp.slice(0,10)?'released':'announced':prior?.publication_status??book.publicationStatus,date,stamp);
    if(degraded){
      const input=hash([doc.id,id,'description-regression']);
      enqueue(db,'review-description',id,input,{seriesId:seed.id,sourceUrl:doc.url},0);
      db.prepare("UPDATE catalog_jobs SET status='review',last_error=? WHERE kind='review-description' AND entity_id=? AND input_hash=?")
        .run('Refreshed description is empty or substantially shorter; retained previous source text for review.',id,input);
    }
    for(const conflict of conflicts){
      retainClaim(db,'work',id,'rejectedAudioIdentifier',{asin:conflict.id,existingTitle:conflict.title,existingNumber:conflict.series_number},doc);
      const entity=`${id}--${conflict.id}`,input=hash([doc.id,conflict.id,conflict.title,conflict.series_number]);
      enqueue(db,'review-edition',entity,input,{seriesId:seed.id,sourceUrl:doc.url,workId:id,asin:conflict.id,existingTitle:conflict.title},0);
      db.prepare("UPDATE catalog_jobs SET status='review',last_error=? WHERE kind='review-edition' AND entity_id=? AND input_hash=?")
        .run('Publisher audio link points to a conflicting edition; the link was not applied.',entity,input);
    }
    // A bibliography can establish a work without establishing any particular edition.
    if(book.format!=='unknown'){
    const previousEdition=db.prepare('SELECT id FROM catalog_editions WHERE work_id=? AND source_url=? AND format=? AND legacy_book_id IS NULL LIMIT 1').get(id,doc.url,book.format) as {id:string}|undefined;
    const sourceEdition=previousEdition?.id??`edition-${hash([doc.url,book.format,id]).slice(0,24)}`;
    db.prepare(`INSERT INTO catalog_editions(id,work_id,format,title,source_url,source_name,release_date,cover_url,narrator,runtime_minutes,identifiers_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET release_date=COALESCE(excluded.release_date,catalog_editions.release_date),cover_url=COALESCE(excluded.cover_url,catalog_editions.cover_url),narrator=COALESCE(excluded.narrator,catalog_editions.narrator),runtime_minutes=COALESCE(excluded.runtime_minutes,catalog_editions.runtime_minutes),identifiers_json=excluded.identifiers_json,updated_at=excluded.updated_at`)
      .run(sourceEdition,id,book.format,book.title,doc.url,sourceName(doc.url),book.releaseDate,book.coverUrl,book.narrator,book.format==='audiobook'?book.audioRuntimeMinutes:null,JSON.stringify({links:book.links}),stamp);
    }
    // Even a publisher can paste the wrong buy link. Every observed ASIN must be checked
    // before promotion, including an inherited row with incomplete or conflicting metadata.
    // The exact-product verifier can settle that conflict; the old row alone cannot veto it.
    for(const asin of audioAsins) {
      const payload={seriesId:seed.id,workId:id,asin,sourceUrl:doc.url};
      enqueue(db,'audio-edition',`${id}--${asin}`,hash({version:AUDIO_ADAPTER_VERSION,workId:id,asin}),payload,seed.priority);
    }
    for(const row of matches) {
      const existing=db.prepare('SELECT work_id FROM catalog_editions WHERE legacy_book_id=?').get(row.id) as {work_id:string}|undefined;
      if(existing && existing.work_id!==id) throw new ReviewError('An edition is already attached to a different work.');
      const verifiedAudio=audioAsins.has(row.id), release=verifiedAudio ? book.audioReleaseDate??validReleaseDate(row.release_date) : validReleaseDate(row.release_date);
      const narrator=verifiedAudio?book.narrator??row.narrator:row.narrator, runtime=verifiedAudio?book.audioRuntimeMinutes??row.runtime_minutes:row.runtime_minutes;
      db.prepare(`INSERT INTO catalog_editions(id,work_id,legacy_book_id,format,title,source_url,source_name,release_date,cover_url,narrator,runtime_minutes,identifiers_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET release_date=COALESCE(excluded.release_date,catalog_editions.release_date),narrator=COALESCE(excluded.narrator,catalog_editions.narrator),runtime_minutes=COALESCE(excluded.runtime_minutes,catalog_editions.runtime_minutes),updated_at=excluded.updated_at`)
        .run(`edition-${row.id}`,id,row.id,'audiobook',row.title,row.url??doc.url,'Audible',release,row.cover_url,narrator,runtime,JSON.stringify({asin:row.id}),stamp);
      if (verifiedAudio) db.prepare(`UPDATE books SET release_date=COALESCE(?,NULLIF(release_date,''),''),narrator=COALESCE(?,narrator),runtime_minutes=COALESCE(?,runtime_minutes),cover_url=COALESCE(cover_url,?),updated_at=? WHERE id=?`)
        .run(book.audioReleaseDate,book.narrator,book.audioRuntimeMinutes,book.format==='audiobook'?book.coverUrl:null,stamp,row.id);
      for(const genre of seed.genres) db.prepare(`INSERT INTO book_subgenres(book_id,subgenre,confidence,source) VALUES(?,?,1,'curated-series') ON CONFLICT(book_id,subgenre) DO NOTHING`).run(row.id,genre);
      retainClaim(db,'edition',row.id,'workId',id,doc);
    }
    return id;
  })();
}
