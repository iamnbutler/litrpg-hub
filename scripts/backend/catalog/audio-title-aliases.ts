import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { load } from 'cheerio';
import { normalizeIdentity } from '../../../src/lib/catalog.js';
import type { AudibleProduct } from '../fetchers/audible.js';
import { creditedAuthorKeys, sameAuthorCredits } from './author-identity.js';
import { hash } from './queue.js';
import { ReviewError, type Document, type SeedSeries, type WorkRow } from './types.js';

export type AudioWorkIdentity = Pick<WorkRow,'id'|'series_id'|'number'|'title'|'author'>;
export function audioWorkIdentity(work:AudioWorkIdentity):string {
  return hash([work.id,work.series_id,work.number,normalizeIdentity(work.title),normalizeIdentity(work.author)]);
}
type AudioProduct = AudibleProduct & {format_type?:string;content_type?:string;is_vvab?:boolean;publisher_name?:string};
/** Independent recording identity, shared by title verification and safe replay of
 * an already verified alias. This module has no dependency on the work importer. */
export function verifyAudioIdentity(value:unknown,asin:string,seed:SeedSeries,number:number,expectedAuthor?:string):AudioProduct & {title:string} {
  const product=(value as {product?:AudioProduct}|null)?.product;
  if(!product||typeof product!=='object'||!product.asin)throw new Error('Audiobook response contains no product.');
  if(product.asin!==asin)throw new ReviewError('Audiobook API returned a different identifier.');
  if(typeof product.title!=='string'||!product.title.trim())throw new ReviewError('The API returned no audiobook metadata for this identifier; its identity or marketplace needs review.');
  if(product.language?.toLowerCase()!=='english')throw new ReviewError('The identified audiobook is not confirmed to be in English.');
  if(product.content_type!=='Product'||product.format_type!=='unabridged')throw new ReviewError('The identified audio is not a full unabridged audiobook.');
  if(/\b(collection|omnibus|box(?:ed)?\s*set|summary|summaries|dramatized|dramatised|episode|books?\s*\d+\s*[-–]\s*\d+)\b/i.test(`${product.title} ${product.subtitle??''}`)){
    throw new ReviewError('Collection, adaptation, episode, or summary requires an explicit edition mapping.');
  }
  const authors=product.authors?.map(author=>author.name)??[];
  if(!creditedAuthorKeys(seed,authors))throw new ReviewError('Audiobook author credits conflict with the selected series.');
  if(expectedAuthor&&!sameAuthorCredits(seed,authors,expectedAuthor))throw new ReviewError('Audiobook author credits conflict with the selected work.');
  const series=product.series?.find(item=>[seed.title,...seed.aliases].some(title=>normalizeIdentity(title)===normalizeIdentity(item.title)));
  if(!series||!/^\d+(?:\.\d+)?$/.test(series.sequence??'')||Number(series.sequence)!==number)throw new ReviewError('Audiobook series or volume conflicts with the selected work.');
  return product as AudioProduct & {title:string};
}
interface EvidenceReference { documentId:string; url:string; contentHash:string }
/** An exception for one exact US recording, never a pattern or a series-wide title alias.
 * Reviewers establish the semantic equivalence; runtime checks keep that review bound
 * to the canonical identity and both immutable, still-current source documents. */
export interface AudioTitleAliasReview {
  id:string;
  workId:string;
  workIdentityHash:string;
  asin:string;
  canonicalTitle:string;
  retailerTitle:string;
  reviewedAt:string;
  reviewedBy:string;
  primary:EvidenceReference & { sourceType:'publisher'|'author' };
  product:EvidenceReference;
  notes?:string;
}
export const audioTitleAliases=JSON.parse(readFileSync(new URL('../config/catalog-audio-title-aliases.json',import.meta.url),'utf8')) as readonly AudioTitleAliasReview[];

const needsReview=()=>new ReviewError('Audiobook title alias is stale, conflicting, or missing its reviewed source proof.');
function retainedEvidence(db:Database.Database,reference:EvidenceReference):Document {
  if(!reference||!reference.documentId||!reference.url||!/^[a-f0-9]{64}$/.test(reference.contentHash))throw needsReview();
  const doc=db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(reference.documentId) as Document|undefined;
  if(!doc||doc.url!==reference.url||doc.content_hash!==reference.contentHash||hash(doc.body)!==reference.contentHash)throw needsReview();
  const head=db.prepare('SELECT document_id FROM catalog_urls WHERE url=?').get(doc.url) as {document_id:string}|undefined;
  if(head&&head.document_id!==doc.id)throw needsReview();
  return doc;
}
function productUrl(value:string,asin:string):boolean {
  try{
    const url=new URL(value);
    return url.origin==='https://api.audible.com'&&!url.username&&!url.password&&!url.hash
      &&url.pathname===`/1.0/catalog/products/${asin}`;
  }catch{return false;}
}
function observedAudioLink(body:string,base:string,asin:string):boolean {
  const $=load(body);
  return $('a[href]').toArray().some(anchor=>{
    try{
      const url=new URL($(anchor).attr('href')!,base);
      return url.protocol==='https:'&&['audible.com','www.audible.com'].includes(url.hostname)&&!url.username&&!url.password
        &&new RegExp(`^/pd/(?:[^/]+/)?${asin}/?$`).test(url.pathname);
    }catch{return false;}
  });
}

/** Missing review is neutral: the ordinary structural title check must still pass.
 * A claimed but obsolete/conflicting review is an explicit failure, never a fallback.
 * A changed source body requires renewed review, even if only commerce fields changed. */
export function resolveAudioTitleAlias(db:Database.Database,seed:SeedSeries,work:AudioWorkIdentity,asin:string,retailerTitle:string,
  currentProduct:Document,reviews:readonly AudioTitleAliasReview[]=audioTitleAliases,now=new Date().toISOString()):AudioTitleAliasReview|null {
  if(!Array.isArray(reviews))throw needsReview();
  const candidates=reviews.filter(review=>review?.asin===asin);
  if(!candidates.length)return null;
  if(candidates.length!==1)throw needsReview();
  const review=candidates[0], reviewedAt=Date.parse(review.reviewedAt), at=Date.parse(now);
  if(typeof review.id!=='string'||!review.id.trim()||typeof review.reviewedBy!=='string'||!review.reviewedBy.trim()
    ||!Number.isFinite(reviewedAt)||!Number.isFinite(at)||reviewedAt>at
    ||review.workId!==work.id||review.workIdentityHash!==audioWorkIdentity(work)||work.series_id!==seed.id
    ||review.canonicalTitle!==work.title||review.retailerTitle!==retailerTitle||!/^[A-Z0-9]{10}$/.test(asin))throw needsReview();
  const primary=retainedEvidence(db,review.primary),product=retainedEvidence(db,review.product);
  let primaryUrl:URL;
  try{primaryUrl=new URL(primary.url);}catch{throw needsReview();}
  if(!['publisher','author'].includes(review.primary.sourceType)||primaryUrl.protocol!=='https:'||primaryUrl.username||primaryUrl.password
    ||!seed.sources.some(source=>new URL(source.url).origin===primaryUrl.origin)
    ||!primary.body.trimStart().startsWith('<')||!observedAudioLink(primary.body,primary.url,asin))throw needsReview();
  if(!productUrl(product.url,asin)||currentProduct.id!==product.id||currentProduct.url!==product.url
    ||currentProduct.content_hash!==product.content_hash||hash(currentProduct.body)!==product.content_hash
    ||![primary.fetched_at,product.fetched_at].every(stamp=>Number.isFinite(Date.parse(stamp))&&Date.parse(stamp)<=reviewedAt))throw needsReview();
  // Query variants are one logical product; an old reviewed response cannot mask a newer one.
  const base=`https://api.audible.com/1.0/catalog/products/${asin}`;
  const latest=db.prepare(`SELECT d.id FROM catalog_urls u JOIN catalog_documents d ON d.id=u.document_id
    WHERE u.url=? OR u.url LIKE ? ORDER BY u.checked_at DESC,d.fetched_at DESC,d.id LIMIT 1`).get(base,`${base}?%`) as {id:string}|undefined;
  if(latest&&latest.id!==product.id)throw needsReview();
  let observed:{product?:{asin?:string;title?:string}};
  try{observed=JSON.parse(product.body);}catch{throw needsReview();}
  if(observed?.product?.asin!==asin||observed.product.title!==retailerTitle)throw needsReview();
  return review;
}

/** Suppress a redundant legacy-title conflict only for an existing, still-bound
 * verified recording. This does not promote an edition or apply any copied facts. */
export function reusesVerifiedAudioTitleAlias(db:Database.Database,seed:SeedSeries,work:AudioWorkIdentity,
  legacy:{id:string;title:string;subtitle:string|null},reviews:readonly AudioTitleAliasReview[]=audioTitleAliases):boolean {
  try{
    const current=db.prepare('SELECT id,series_id,number,title,author FROM catalog_works WHERE id=?').get(work.id) as AudioWorkIdentity|undefined;
    const edition=db.prepare('SELECT work_id,format,identifiers_json FROM catalog_editions WHERE legacy_book_id=?').get(legacy.id) as {work_id:string;format:string;identifiers_json:string}|undefined;
    if(!current||audioWorkIdentity(current)!==audioWorkIdentity(work)||!edition||edition.work_id!==current.id||edition.format!=='audiobook')return false;
    const identifiers=JSON.parse(edition.identifiers_json) as {asin?:string;marketplace?:string;workIdentityHash?:string;verifiedDocument?:string};
    if(identifiers.asin!==legacy.id||identifiers.marketplace!=='US'||identifiers.workIdentityHash!==audioWorkIdentity(current)||!identifiers.verifiedDocument)return false;
    const recorded=db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(identifiers.verifiedDocument) as Document|undefined;
    if(!recorded||!productUrl(recorded.url,legacy.id))return false;
    const base=`https://api.audible.com/1.0/catalog/products/${legacy.id}`;
    const document=db.prepare(`SELECT d.* FROM catalog_urls u JOIN catalog_documents d ON d.id=u.document_id
      WHERE u.url=? OR u.url LIKE ? ORDER BY u.checked_at DESC,d.fetched_at DESC,d.id LIMIT 1`).get(base,`${base}?%`) as Document|undefined;
    const doc=document??recorded,product=verifyAudioIdentity(JSON.parse(doc.body),legacy.id,seed,current.number,current.author);
    if(product.title!==legacy.title||(product.subtitle??null)!==legacy.subtitle)return false;
    return !!resolveAudioTitleAlias(db,seed,current,legacy.id,product.title,doc,reviews);
  }catch{return false;}
}
