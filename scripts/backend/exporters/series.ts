import type Database from 'better-sqlite3';
import { genreLabels, normalizeIdentity, validReleaseDate, type Assessment, type CatalogBook } from '../../../src/lib/catalog.js';
import { groupSeries, type CatalogSeries, type CatalogWork } from '../../../src/lib/series.js';
import { classifyContent } from '../classifiers/content.js';
import { assessmentHash } from '../jev/assessment.js';
import { extractionHash, extractionInput, profileInput, seriesExtractionContext } from '../catalog/inference.js';
import { seeds } from '../catalog/pipeline.js';
import { sourceName } from '../catalog/import.js';
import type { WorkRow } from '../catalog/types.js';
import { catalogAudioCoverage } from '../catalog/coverage-store.js';
import { reviewedMetadata, type EditorialReview } from '../catalog/editorial.js';
import { creditedAuthorKeys, sameAuthorCredits } from '../catalog/author-identity.js';

interface EditionRow {
  id:string;work_id:string;legacy_book_id:string|null;format:string;title:string;
  source_url:string;source_name:string;release_date:string|null;cover_url:string|null;
  narrator:string|null;runtime_minutes:number|null;
  identifiers_json:string;
}
const safeUrl=(value:string|null)=>{try{return value&&new URL(value).protocol==='https:'?value:null;}catch{return null;}};

export function enrichCatalogSeries(db:Database.Database,books:CatalogBook[],options:{editorialReviews?:readonly EditorialReview[]}={}):CatalogSeries[] {
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_works'").get())return groupSeries(books);
  const works=db.prepare('SELECT * FROM catalog_works').all() as WorkRow[];
  const byId=new Map(works.map(w=>[w.id,w]));
  const observed=new Map((db.prepare('SELECT url,MAX(fetched_at) AS stamp FROM catalog_documents GROUP BY url').all() as {url:string;stamp:string}[]).map(r=>[r.url,r.stamp]));
  const editions=db.prepare('SELECT * FROM catalog_editions').all() as EditionRow[];
  const workByEdition=new Map(editions.filter(e=>e.legacy_book_id).map(e=>[e.legacy_book_id!,byId.get(e.work_id)!]));
  const publicBooks=new Map(books.map(b=>[b.id,b]));

  // A publisher can sell an audiobook without an Audible ASIN. Its source edition is a real
  // identity of its own. Avoid duplicating a source edition already represented by a retailer.
  const represented=new Map<string,CatalogBook[]>();
  for(const edition of editions.filter(e=>e.legacy_book_id)){
    const book=publicBooks.get(edition.legacy_book_id!);if(!book)continue;
    (represented.get(edition.work_id)??represented.set(edition.work_id,[]).get(edition.work_id)!).push(book);
  }
  const narratorKey=(value:string|null)=>value?.split(',').map(normalizeIdentity).filter(Boolean).sort().join('|')??'';
  for(const edition of editions.filter(e=>e.format==='audiobook'&&!e.legacy_book_id)){
    const work=byId.get(edition.work_id),seed=seeds.find(s=>s.id===work?.series_id);
    if(!work||!seed)continue;
    const links=(JSON.parse(edition.identifiers_json) as {links?:{format:string;asin?:string}[]}).links??[];
    const linkedIds=new Set(links.filter(l=>l.format==='audiobook').map(l=>l.asin).filter(Boolean));
    const matching=(represented.get(edition.work_id)??[]).find(book=>{
      // The same narrator can record a book twice. An explicit different product ID
      // or conflicting performance facts must not disappear behind a name match.
      if(linkedIds.size)return linkedIds.has(book.id);
      if(!narratorKey(edition.narrator)||narratorKey(edition.narrator)!==narratorKey(book.narrator))return false;
      const date=validReleaseDate(edition.release_date??'');
      if(date&&book.releaseDate&&date!==book.releaseDate)return false;
      if(edition.runtime_minutes&&book.runtimeMinutes&&Math.abs(edition.runtime_minutes-book.runtimeMinutes)>2)return false;
      return true;
    });
    if(matching){
      // Corroborated performances may fill missing facts. A current retailer recording's
      // nonempty duration/date stays intact when an older publisher page still disagrees.
      matching.releaseDate??=validReleaseDate(edition.release_date??'');
      matching.coverUrl??=safeUrl(edition.cover_url);
      matching.narrator??=edition.narrator;
      matching.runtimeMinutes??=edition.runtime_minutes;
      if(!matching.sources.some(s=>s.url===edition.source_url))matching.sources.push({name:edition.source_name,url:edition.source_url,fetchedAt:observed.get(edition.source_url)??work.updated_at});
      continue;
    }
    const book:CatalogBook={
      id:edition.id,workId:work.id,title:edition.title,subtitle:'',author:work.author,
      series:seed.title,seriesKey:seed.id,seriesNumber:work.number,narrator:edition.narrator,
      releaseDate:validReleaseDate(edition.release_date??''),coverUrl:safeUrl(edition.cover_url),runtimeMinutes:edition.runtime_minutes,
      description:'',url:safeUrl(edition.source_url),rating:null,ratingCount:0,subgenres:seed.genres.filter(g=>g in genreLabels),
      edition:'audiobook',scope:'indexed',content:classifyContent({title:work.title,subtitle:'',description:work.source_description,narrator:edition.narrator}),
      assessment:null,coverAssessment:null,sources:[{name:edition.source_name,url:edition.source_url,fetchedAt:observed.get(edition.source_url)??work.updated_at}],issues:[]
    };
    books.push(book);workByEdition.set(book.id,work);
    // A different narrator is a distinct performance even when a retailer edition exists.
    (represented.get(work.id)??represented.set(work.id,[]).get(work.id)!).push(book);
  }
  const canonical=new Map<string,CatalogWork>();
  for(const work of works)canonical.set(work.id,{
    id:work.id,title:work.title,number:work.number,bookId:'',
    editionIds:editions.filter(e=>e.work_id===work.id&&e.format==='audiobook').map(e=>e.legacy_book_id??e.id),audioReleaseDate:null,verified:true
  });

  for(const book of books){
    const work=workByEdition.get(book.id);
    const seed=work?seeds.find(s=>s.id===work.series_id):seeds.find(s=>{
      if(![s.title,...s.aliases].some(t=>normalizeIdentity(t)===normalizeIdentity(book.series))||!creditedAuthorKeys(s,book.author))return false;
      const numbered=works.find(candidate=>candidate.series_id===s.id&&candidate.number===book.seriesNumber);
      // An unlinked retailer row must not bypass the work's reviewed author identity.
      // Conflicting books keep their original legacy group and every saved edition ID.
      return !numbered||sameAuthorCredits(s,numbered.author,book.author);
    });
    if(seed){
      book.seriesKey=seed.id;book.series=seed.title;
      // Reviewed progression-only series must not inherit a broad retailer LitRPG tag.
      // Keep the registry authoritative: a thin later-volume blurb cannot revoke its genre.
      if(seed.genres.includes('progression')&&!seed.genres.includes('litrpg'))book.subgenres=book.subgenres.filter(g=>g!=='litrpg');
      book.subgenres=[...new Set([...book.subgenres,...seed.genres.filter(g=>g in genreLabels)])];
    }
    if(!work||!seed)continue;
    book.workId=work.id;
    // Canonical works publish original editorial summaries. Raw source copy stays
    // private while a changed description is waiting for extraction and validation.
    book.description='';
    delete book.descriptionSource;
    delete book.features;
    delete book.featureEvidence;
    const input=extractionInput(work);
    const reviewed=reviewedMetadata(db,'work',work.id,input,work.source_url,options.editorialReviews);
    const metadata=work.metadata_json?JSON.parse(work.metadata_json):null;
    if(reviewed||metadata?.inputHash===extractionHash(input)){
      book.description=reviewed?.synopsis??work.description;
      book.descriptionSource={name:sourceName(work.source_url),url:work.source_url,checkedAt:observed.get(work.source_url)??work.updated_at,kind:'editorial-summary',...(reviewed?{reviewedAt:reviewed.evidence.reviewedAt}:{})};
      if(reviewed){book.features=reviewed.features;book.featureEvidence=reviewed.evidence;}
    }
    // Classify the retained source copy, never the cleaned-up public synopsis. A concrete
    // disclosure/disclaimer in the source outranks an earlier inference from a thin listing.
    const primary=classifyContent({title:work.title,subtitle:'',description:work.source_description,narrator:book.narrator});
    for(const key of ['sexualized','explicit','harem','aiWriting','quality'] as const){
      if(primary[key].verdict!=='unknown'&&book.content[key].source!=='manual')book.content[key]=primary[key];
    }
    if(work.assessment_json){
      const profile=JSON.parse(work.assessment_json) as Assessment;
      if(profile.inputHash===assessmentHash(profileInput(work,seed))){
        book.assessment=profile;
        for(const key of ['explicit','harem','quality'] as const){
          if(book.content[key].verdict==='unknown'||book.content[key].source==='jev')book.content[key]=profile[key];
        }
      }
    }
    if(!book.sources.some(s=>s.url===work.source_url))book.sources.push({name:sourceName(work.source_url),fetchedAt:observed.get(work.source_url)??work.updated_at,url:work.source_url});
  }
  const core=db.prepare('SELECT * FROM catalog_series').all() as {
    id:string;title:string;author:string;aliases_json:string;genres_json:string;description:string;metadata_json:string|null;status:CatalogSeries['status'];updated_at:string
  }[];
  const overrides:Partial<CatalogSeries>[]=core.map(s=>{
    const context=seriesExtractionContext(db,s.id),input=context?.input,metadata=s.metadata_json?JSON.parse(s.metadata_json):null;
    const first=works.find(w=>w.series_id===s.id&&w.number===1);
    const reviewed=input&&first?reviewedMetadata(db,'series',s.id,input,first.source_url,options.editorialReviews,context!.sourceUrls.slice(1)):null;
    const seed=seeds.find(seed=>seed.id===s.id);
    return {id:s.id,title:s.title,author:s.author,aliases:JSON.parse(s.aliases_json),genres:JSON.parse(s.genres_json),
      description:reviewed?.synopsis??(input&&metadata?.inputHash===extractionHash(input)?s.description:''),
      ...(reviewed?{features:reviewed.features,featureEvidence:reviewed.evidence}:{}),
      curated:works.some(w=>w.series_id===s.id),status:s.status,
      ...(seed?{audioCoverage:catalogAudioCoverage(db,seed)}:{}),
      sourceUrls:[...new Set(works.filter(w=>w.series_id===s.id).map(w=>w.source_url))],updatedAt:s.updated_at};
  });
  return groupSeries(books,overrides,canonical);
}
