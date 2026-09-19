import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { normalizeIdentity, seriesIdentity, validReleaseDate } from '../../../src/lib/catalog.js';
import { productToBookRow, recordingNarrator, recordingRuntime, type AudibleProduct } from '../fetchers/audible.js';
import { getDocument } from './sources.js';
import { enqueue, hash } from './queue.js';
import { matchesCanonicalTitle, retainClaim } from './import.js';
import { creditedAuthorKeys, sameAuthorCredits } from './author-identity.js';
import { audioWorkIdentity, resolveAudioTitleAlias, verifyAudioIdentity, type AudioTitleAliasReview, type AudioWorkIdentity } from './audio-title-aliases.js';
import { AUDIO_ADAPTER_VERSION, ReviewError, type AudioPayload, type Document, type SeedSeries, type WorkRow } from './types.js';
export { audioWorkIdentity } from './audio-title-aliases.js';

export function audioProductUrl(asin: string): string {
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new ReviewError('Invalid known audiobook identifier.');
  return `https://api.audible.com/1.0/catalog/products/${asin}?response_groups=product_desc,product_attrs,product_extended_attrs,contributors,series,media,rating`;
}

type Product = AudibleProduct & { format_type?: string; content_type?: string; is_vvab?: boolean; publisher_name?: string };
type VerifiedProduct = Product & {title:string};

/** An observed buy link is a lead. The product itself must establish the audio identity.
 * Title may be omitted only while discovering a work that has no canonical title yet. */
export function verifyAudioProduct(value: unknown, asin: string, seed: SeedSeries, number: number, expectedAuthor?: string, expectedTitle?: string): VerifiedProduct {
  const product=verifyAudioIdentity(value,asin,seed,number,expectedAuthor);
  if (expectedTitle !== undefined && !matchesCanonicalTitle(product.title, expectedTitle, seed, number,product.subtitle)) throw new ReviewError('Audiobook title conflicts with the selected canonical work.');
  return product;
}

/** A caller-supplied product is not proof unless those exact facts were retained
 * from the exact endpoint. Current query variants share one recording identity. */
function requireProductDocument(db:Database.Database,product:VerifiedProduct,document:Document):void {
  const fail=()=>new ReviewError('Audiobook verification needs its exact current retained product document.');
  let url:URL;
  try{url=new URL(document.url);}catch{throw fail();}
  if(!/^[A-Z0-9]{10}$/.test(product.asin)||url.origin!=='https://api.audible.com'||url.username||url.password||url.hash
    ||url.pathname!==`/1.0/catalog/products/${product.asin}`)throw fail();
  const retained=db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(document.id) as Document|undefined;
  if(!retained||retained.url!==document.url||retained.content_hash!==document.content_hash||retained.body!==document.body
    ||retained.fetched_at!==document.fetched_at||hash(retained.body)!==retained.content_hash)throw fail();
  let value:{product?:unknown}|null;
  try{value=JSON.parse(retained.body);}catch{throw fail();}
  if(!isDeepStrictEqual(value?.product,product))throw fail();
  const base=`https://api.audible.com/1.0/catalog/products/${product.asin}`;
  const current=db.prepare(`SELECT d.id FROM catalog_urls u JOIN catalog_documents d ON d.id=u.document_id
    WHERE u.url=? OR u.url LIKE ? ORDER BY u.checked_at DESC,d.fetched_at DESC,d.id LIMIT 1`).get(base,`${base}?%`) as {id:string}|undefined;
  if(current&&current.id!==document.id)throw fail();
}

/** Shared known-work gate for import and coverage. The title-less verifier is reserved
 * for discovery which genuinely has no canonical title; aliases cannot relax its
 * independent author, selected series, volume, language, or full-audiobook checks. */
export function verifyCanonicalAudioProduct(db:Database.Database,value:unknown,asin:string,seed:SeedSeries,work:AudioWorkIdentity,
  document:Document,options:{titleAliases?:readonly AudioTitleAliasReview[]}={}):VerifiedProduct {
  if(work.series_id!==seed.id)throw new ReviewError('Canonical work identity conflicts with its selected series.');
  const product=verifyAudioProduct(value,asin,seed,work.number,work.author);
  const alias=resolveAudioTitleAlias(db,seed,work,asin,product.title,document,options.titleAliases);
  if(!alias&&!matchesCanonicalTitle(product.title,work.title,seed,work.number,product.subtitle))throw new ReviewError('Audiobook title conflicts with the selected canonical work.');
  requireProductDocument(db,product,document);
  return product;
}

export function enqueueAudio(db: Database.Database, payload: AudioPayload, priority = 0): boolean {
  audioProductUrl(payload.asin);
  return enqueue(db, 'audio-edition', `${payload.workId}--${payload.asin}`, hash({ version: AUDIO_ADAPTER_VERSION, workId: payload.workId, asin: payload.asin }), payload, priority);
}

/** Plan only identifiers already observed in a selected bibliography or the existing catalog. */
export function planAudio(db: Database.Database, selected: SeedSeries[]): number {
  const seeds = new Map(selected.map(s => [s.id, s]));
  let count = 0;
  const rows = db.prepare(`SELECT e.work_id,e.legacy_book_id,e.source_url,e.identifiers_json,w.series_id
    FROM catalog_editions e JOIN catalog_works w ON w.id=e.work_id`).all() as {
    work_id: string; legacy_book_id: string | null; source_url: string; identifiers_json: string; series_id: string
  }[];
  for (const row of rows) {
    const seed = seeds.get(row.series_id);
    if (!seed) continue;
    const identifiers = JSON.parse(row.identifiers_json) as { links?: { format: string; asin?: string }[] };
    const asins = new Set([row.legacy_book_id, ...(identifiers.links ?? []).filter(l => l.format === 'audiobook').map(l => l.asin)]);
    for (const asin of asins) if (asin && /^[A-Z0-9]{10}$/.test(asin)) {
      count += Number(enqueueAudio(db, { seriesId: seed.id, workId: row.work_id, asin, sourceUrl: row.source_url }, seed.priority));
    }
  }
  return count;
}

/** Missing new facts preserve earlier known credits; obvious old placeholders must
 * not survive COALESCE as if they were confirmed recording metadata. */
function clearRecordingPlaceholders(db: Database.Database, asin: string) {
  type Recording = { release_date: string | null; narrator: string | null; runtime_minutes: number | null };
  const book = db.prepare('SELECT release_date,narrator,runtime_minutes FROM books WHERE id=?').get(asin) as Recording;
  const edition = db.prepare('SELECT release_date,narrator,runtime_minutes FROM catalog_editions WHERE legacy_book_id=?').get(asin) as Recording;
  db.prepare('UPDATE books SET release_date=?,narrator=?,runtime_minutes=? WHERE id=?')
    .run(validReleaseDate(book.release_date) ?? '', recordingNarrator(book.narrator), recordingRuntime(book.runtime_minutes), asin);
  db.prepare('UPDATE catalog_editions SET release_date=?,narrator=?,runtime_minutes=? WHERE legacy_book_id=?')
    .run(validReleaseDate(edition.release_date), recordingNarrator(edition.narrator), recordingRuntime(edition.runtime_minutes), asin);
}

/** Merge one verified retailer edition, keeping publisher work titles and every saved ID. */
export function importAudioProduct(db: Database.Database, seed: SeedSeries, work: WorkRow, product: Product, doc: Document,
  options:{titleAliases?:readonly AudioTitleAliasReview[]}={}): void {
  db.transaction(() => {
    if(work.series_id!==seed.id||!creditedAuthorKeys(seed,work.author))
      throw new ReviewError('Canonical work identity conflicts with its selected series.');
    if(!sameAuthorCredits(seed,work.author,product.authors?.map(author=>author.name)??[]))
      throw new ReviewError('Audiobook author credits conflict with the selected work.');
    // Re-read inside the write transaction: a supplied snapshot cannot stand in
    // for a different canonical title or author after a request was in flight.
    const current=db.prepare('SELECT id,series_id,number,title,author FROM catalog_works WHERE id=?').get(work.id) as AudioWorkIdentity|undefined;
    if(!current||audioWorkIdentity(current)!==audioWorkIdentity(work))throw new ReviewError('Canonical work identity changed before audio import; its edition binding needs an explicit review.');
    const existing = db.prepare('SELECT work_id,identifiers_json FROM catalog_editions WHERE legacy_book_id=?').get(product.asin) as { work_id: string; identifiers_json:string } | undefined;
    if (existing && existing.work_id !== work.id) throw new ReviewError('Verified audio identifier is already attached to another work.');
    const previousIdentity=existing?(JSON.parse(existing.identifiers_json) as {workIdentityHash?:string}).workIdentityHash:undefined;
    if(previousIdentity&&previousIdentity!==audioWorkIdentity(work))throw new ReviewError('Canonical work identity changed after audio verification; its edition binding needs an explicit review.');
    // A direct caller must pass the same complete identity gate as processAudio.
    verifyCanonicalAudioProduct(db,{product},product.asin,seed,current,doc,options);
    const row = productToBookRow({...product, authors: product.authors?.filter(a => !seed.publisherCredits?.some(p => normalizeIdentity(p) === normalizeIdentity(a.name)))}), stamp = new Date().toISOString();
    const seriesId = seriesIdentity(seed.title, seed.author);
    db.prepare('INSERT OR IGNORE INTO series(id,title,author) VALUES(?,?,?)').run(seriesId, seed.title, seed.author);
    db.prepare(`INSERT INTO books(id,title,subtitle,author,series_id,series_number,release_date,cover_url,narrator,runtime_minutes,description,url,rating,rating_count,is_ai_narrated,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,subtitle=COALESCE(excluded.subtitle,books.subtitle),author=excluded.author,series_id=excluded.series_id,series_number=excluded.series_number,
      release_date=COALESCE(NULLIF(excluded.release_date,''),books.release_date),cover_url=COALESCE(excluded.cover_url,books.cover_url),narrator=COALESCE(excluded.narrator,books.narrator),runtime_minutes=COALESCE(excluded.runtime_minutes,books.runtime_minutes),
      description=CASE WHEN LENGTH(COALESCE(excluded.description,''))>LENGTH(COALESCE(books.description,'')) THEN excluded.description ELSE books.description END,
      url=excluded.url,rating=COALESCE(excluded.rating,books.rating),rating_count=COALESCE(excluded.rating_count,books.rating_count),is_ai_narrated=excluded.is_ai_narrated,updated_at=excluded.updated_at`)
      .run(product.asin, row.title, row.subtitle, row.author, seriesId, work.number, row.release_date ?? '', row.cover_url, row.narrator, row.runtime_minutes, row.description, row.url, row.rating, row.rating_count, Number(product.is_vvab === true || row.is_ai_narrated), stamp);
    db.prepare(`INSERT INTO catalog_editions(id,work_id,legacy_book_id,format,title,source_url,source_name,release_date,cover_url,narrator,runtime_minutes,identifiers_json,updated_at)
      VALUES(?,?,?,'audiobook',?,?,'Audible',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,source_url=excluded.source_url,release_date=COALESCE(excluded.release_date,catalog_editions.release_date),cover_url=COALESCE(excluded.cover_url,catalog_editions.cover_url),narrator=COALESCE(excluded.narrator,catalog_editions.narrator),runtime_minutes=COALESCE(excluded.runtime_minutes,catalog_editions.runtime_minutes),identifiers_json=excluded.identifiers_json,updated_at=excluded.updated_at`)
      .run(`edition-${product.asin}`, work.id, product.asin, row.title, row.url, row.release_date, row.cover_url, row.narrator, row.runtime_minutes,
        JSON.stringify({ asin: product.asin, marketplace: 'US', series: product.series, publisher: product.publisher_name ?? null, verifiedDocument: doc.id, workIdentityHash:audioWorkIdentity(work) }), stamp);
    clearRecordingPlaceholders(db, product.asin);
    for (const genre of seed.genres) db.prepare(`INSERT INTO book_subgenres(book_id,subgenre,confidence,source) VALUES(?,?,1,'curated-series') ON CONFLICT(book_id,subgenre) DO NOTHING`).run(product.asin, genre);
    db.prepare(`INSERT INTO book_sources(book_id,source,source_id,raw_data,fetched_at) VALUES(?,'audible',?,?,?)
      ON CONFLICT(book_id,source) DO UPDATE SET source_id=excluded.source_id,raw_data=excluded.raw_data,fetched_at=excluded.fetched_at`)
      .run(product.asin, product.asin, JSON.stringify(product), doc.fetched_at);
    for (const [field, value] of Object.entries({ workId: work.id, title: row.title, author: row.author, releaseDate: row.release_date, narrator: row.narrator, runtimeMinutes: row.runtime_minutes, coverUrl: row.cover_url, audioMarketplace: 'US', audioFormat: product.format_type, rating: row.rating, ratingCount: row.rating_count })) {
      retainClaim(db, 'edition', product.asin, field, value, { ...doc, method: 'retailer-api' });
    }
    // Full publisher copy is retained even when a richer author/publisher source wins.
    // Upgrade old clipped API descriptions without replacing substantial primary copy.
    if(row.description)retainClaim(db,'edition',product.asin,'description',row.description,{...doc,method:'retailer-api'});
    // Another worker may have enriched this work while the HTTP request was in flight.
    const source=db.prepare('SELECT source_description,source_url FROM catalog_works WHERE id=?').get(work.id) as Pick<WorkRow,'source_description'|'source_url'>;
    const length=row.description?.length??0, prior=source.source_description.trim();
    const priorClaim=db.prepare("SELECT method FROM catalog_claims WHERE entity_type='work' AND entity_id=? AND field='description' AND value_json=? ORDER BY observed_at DESC LIMIT 1").get(work.id,JSON.stringify(source.source_description)) as {method:string}|undefined;
    const richer=!!product.publisher_summary&&length>prior.length&&(source.source_url.startsWith('https://api.audible.com/')||priorClaim?.method==='curated-source-summary'||prior.length<250&&length>prior.length*1.5);
    if (length >= 100 && (!prior || richer)) {
      db.prepare('UPDATE catalog_works SET source_description=?,source_url=?,updated_at=? WHERE id=?').run(row.description, doc.url, stamp, work.id);
      retainClaim(db, 'work', work.id, 'description', row.description, { ...doc, method: 'retailer-api' });
    }
    // Independent product identity has now settled this exact candidate. Keep the old
    // conflict and its payload as history, while recording the evidence that resolved it.
    db.prepare(`UPDATE catalog_jobs SET status='completed',result_json=?,updated_at=?
      WHERE kind='review-edition' AND entity_id=? AND status='review'`)
      .run(JSON.stringify({resolution:'verified-exact-product',documentId:doc.id,workId:work.id,asin:product.asin}),stamp,`${work.id}--${product.asin}`);
  }).immediate();
}

export async function processAudio(db: Database.Database, payload: AudioPayload, selected: SeedSeries[]) {
  const seed = selected.find(s => s.id === payload.seriesId);
  const work = db.prepare('SELECT * FROM catalog_works WHERE id=? AND series_id=?').get(payload.workId, payload.seriesId) as WorkRow | undefined;
  if (!seed || !work) throw new ReviewError('Audio job has no selected canonical work.');
  const { document, downloaded } = await getDocument(db, audioProductUrl(payload.asin), { format: 'audible-product', ttlDays: 90 });
  const product = verifyCanonicalAudioProduct(db,JSON.parse(document.body),payload.asin,seed,work,document);
  importAudioProduct(db, seed, work, product, document);
  const release=validReleaseDate(product.release_date??'');
  const recent = !release || Date.parse(release) >= Date.now() - 30 * 86400000;
  if (recent) {
    const checked=db.prepare('SELECT checked_at FROM catalog_urls WHERE url=? AND document_id=?').get(document.url,document.id) as {checked_at:string}|undefined;
    const observed=Date.parse(checked?.checked_at??document.fetched_at);
    // Reprocessing cached facts must not postpone the next check. A preorder is due
    // again on its actual release boundary even if the usual weekly TTL runs longer.
    const next=Math.min(observed+7*86400000,release&&Date.parse(release)>observed?Date.parse(release):Infinity);
    db.prepare('UPDATE catalog_urls SET next_check_at=? WHERE url=?').run(new Date(next).toISOString(),document.url);
  }
  return { downloaded, work: work.id, asin: product.asin, title: product.title, releaseDate: validReleaseDate(product.release_date ?? '') };
}
