import type Database from 'better-sqlite3';
import { normalizeIdentity, validReleaseDate } from '../../../src/lib/catalog.js';
import { hash, enqueue } from './queue.js';
import { verifyIdentity } from './adapters.js';
import { sameAuthorCredits } from './author-identity.js';
import { reusesVerifiedAudioTitleAlias, type AudioTitleAliasReview } from './audio-title-aliases.js';
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
const escapeRegex=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const numberWords=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const ordinalWords=['zeroth','first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth','eleventh','twelfth','thirteenth','fourteenth','fifteenth','sixteenth','seventeenth','eighteenth','nineteenth'];
/** Used only in a structural volume slot, never as a replacement inside a story title. */
function titleNumber(value:string):number|null {
  const token=value.trim();
  if(/^\d+(?:\.\d+)?$/.test(token))return Number(token);
  const words=token.toLowerCase().split(/[ -]+/), single=Math.max(numberWords.indexOf(words[0]),ordinalWords.indexOf(words[0]));
  if(words.length===1&&single>=0)return single;
  const tens=['twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'].indexOf(words[0]);
  if(tens>=0){
    if(words.length===1)return (tens+2)*10;
    const unit=Math.max(numberWords.indexOf(words[1]),ordinalWords.indexOf(words[1]));
    if(words.length===2&&unit>0&&unit<10)return (tens+2)*10+unit;
  }
  // Only conventional Roman numerals, not arbitrary letters that happen to have values.
  const roman=token.toUpperCase();
  if(!/^(?=[MDCLXVI]+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/.test(roman))return null;
  const values:Record<string,number>={I:1,V:5,X:10,L:50,C:100,D:500,M:1000};
  return [...roman].reduce((total,c,i)=>total+(values[c]<(values[roman[i+1]]??0)?-values[c]:values[c]),0);
}

// Observed marketing subtitles with words outside the deliberately bounded genre grammar.
const seriesFormatSubtitles:Record<string,readonly string[]>={
  'heretical-fishing':['A Cozy Guide to Annoying the Cults, Outsmarting the Fish, and Alienating Oneself'],
  'path-of-the-berserker':['A Daopocalypse Progression Fantasy']
};
function formatSubtitle(value:string,seed:SeedSeries):boolean {
  const subtitle=value.trim().replace(/[.!]$/,'').replace(/\s*\/\s*/g,' ');
  if((seriesFormatSubtitles[seed.id]??[]).some(known=>known.toLowerCase()===subtitle.toLowerCase()))return true;
  if(/^(?:unabridged|audiobook)$/i.test(subtitle))return true;
  return /^(?:an?\s+)?(?:epic|fantasy|military|portal|progression|deck[ -]building|cultivation|cozy|isekai|gamelit|lit-?rpg|xianxia|slice[ -]of[ -]life)(?:\s+(?:epic|fantasy|military|portal|progression|deck[ -]building|cultivation|cozy|isekai|gamelit|lit-?rpg|xianxia|slice[ -]of[ -]life))*(?:\s+(?:adventure|novel|series|saga|story|epic))*$/i.test(subtitle);
}
function withoutFormatSubtitles(value:string,seed:SeedSeries):string {
  let title=value.trim();
  for(let i=0;i<3;i++){
    const suffix=title.match(/^(.*?)\s*\(([^()]*)\)$/)??title.match(/^(.*?)\s*\[([^\[\]]*)\]$/)
      ??title.match(/^(.*?)(?:\s*:\s*|\s+[-–—]\s+)([^:]+)$/);
    if(!suffix?.[1].trim()||!formatSubtitle(suffix[2],seed))break;
    title=suffix[1].trim();
  }
  return title;
}
const storyForm=(value:string):string|null=>{
  // Initial articles vary between primary and retailer headings. All remaining
  // words, including internal articles and Part labels, still identify the story.
  const key=normalizeIdentity(value.replace(/^the\s+/i,''));
  return key?`story:${key}`:null;
};
/** A single identity, rather than alternate truncated prefixes which can mask a conflict. */
function titleForm(value:string,seed:SeedSeries,number:number):string|null {
  let title=withoutFormatSubtitles(value,seed);
  if(!normalizeIdentity(title))return null;
  let labelled=false;
  // A terminal explicit volume qualifier is formatting only when it agrees with the work.
  const terminal=title.match(/^(.*?)\s*\((?:book|volume)\s+([^()]+)\)$/i)
    ??title.match(/^(.*?)\s*\[(?:book|volume)\s+([^\[\]]+)\]$/i)
    ??title.match(/^(.*?)(?:\s*[:,–—]\s*|\s+-\s+)(?:book|volume)\s+([^,:–—]+)$/i);
  if(terminal?.[1].trim()){
    const volume=titleNumber(terminal[2]);
    if(volume!==null){if(volume!==number)return null;title=terminal[1].trim();labelled=true;}
  }
  for(const name of [...new Set([seed.title,...seed.aliases])].sort((a,b)=>b.length-a.length)){
    const prefix=title.match(new RegExp(`^${escapeRegex(name).replace(/\s+/g,'\\s+')}(?=$|[\\s,:–—-])`,'i'));
    if(!prefix)continue;
    let remainder=title.slice(prefix[0].length).trim();
    const delimiter=/^[:,–—-]\s*/.test(remainder);
    if(delimiter)remainder=remainder.replace(/^[:,–—-]\s*/,'');
    if(!remainder)return labelled||number===1?`series:${number}`:'unqualified-series';
    const head=remainder.match(/^(.+?)(?:\s*[:,–—]\s*|\s+-\s+)(.+)$/);
    const volume=titleNumber((head?.[1]??remainder).replace(/^(?:book|volume)\s+/i,''));
    if(volume!==null){
      if(volume!==number)return null;
      remainder=head?.[2].trim()??'';
      return remainder?storyForm(remainder):`series:${number}`;
    }
    // A selected series can prefix a distinctive title, but it cannot replace that title.
    if(delimiter)return storyForm(remainder);
  }
  return storyForm(title);
}
const sameTitle=(left:string,right:string,seed:SeedSeries,number:number)=>{
  const form=titleForm(left,seed,number);
  return form!==null&&form===titleForm(right,seed,number);
};
/** Supplements independently verified author/series/volume identity. A bare numbered
 * series title needs the distinctive story title in its explicit subtitle field;
 * it never acts as a wildcard or overrides a conflicting distinctive title. */
export function matchesCanonicalTitle(title:string,expectedTitle:string,seed:SeedSeries,number:number,retailerSubtitle?:string|null):boolean {
  const form=titleForm(title,seed,number),expected=titleForm(expectedTitle,seed,number);
  if(form===null||expected===null)return false;
  if(form===expected)return true;
  return form===`series:${number}`&&expected.startsWith('story:')&&typeof retailerSubtitle==='string'
    &&titleForm(retailerSubtitle,seed,number)===expected;
}
function legacyIdentityMatches(row: Legacy, seed: SeedSeries, book: Pick<ExtractedBook,'title'|'number'|'author'>): boolean {
  if (!sameAuthorCredits(seed,row.author,book.author) ||
    ![seed.title,...seed.aliases].some(s=>normalizeIdentity(s)===normalizeIdentity(row.series_title??'')) || row.series_number!==book.number ||
    /\b(collection|omnibus|box(?:ed)? set|dramatized|dramatised|episode|books?\s*\d+\s*[-–]\s*\d+)\b/i.test(`${row.title} ${row.subtitle??''}`)) return false;
  return true;
}
export function matchesLegacy(row: Legacy, seed: SeedSeries, book: Pick<ExtractedBook,'title'|'number'|'author'>): boolean {
  return legacyIdentityMatches(row,seed,book)&&matchesCanonicalTitle(row.title,book.title,seed,book.number,row.subtitle);
}
export function importWork(db: Database.Database, seed: SeedSeries, book: ExtractedBook, doc: Document,
  options:{titleAliases?:readonly AudioTitleAliasReview[]}={}): string {
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
    const matches=rows.filter(r=>matchesLegacy(r,seed,book));
    const matchedIds=new Set(matches.map(row=>row.id));
    const conflicts=rows.filter(row=>audioAsins.has(row.id)&&!matchedIds.has(row.id)
      &&!(prior&&legacyIdentityMatches(row,seed,book)&&reusesVerifiedAudioTitleAlias(db,seed,prior,row,options.titleAliases)));
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
