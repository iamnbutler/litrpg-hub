import type Database from 'better-sqlite3';
import { normalizeIdentity, seriesIdentity, validReleaseDate } from '../../../src/lib/catalog.js';
import { productToBookRow, recordingNarrator, recordingRuntime, type AudibleProduct } from '../fetchers/audible.js';
import { getDocument } from './sources.js';
import { enqueue, hash } from './queue.js';
import { retainClaim } from './import.js';
import { creditedAuthorKeys, sameAuthorCredits } from './author-identity.js';
import { AUDIO_ADAPTER_VERSION, ReviewError, type AudioPayload, type Document, type SeedSeries, type WorkRow } from './types.js';

export function audioProductUrl(asin: string): string {
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new ReviewError('Invalid known audiobook identifier.');
  return `https://api.audible.com/1.0/catalog/products/${asin}?response_groups=product_desc,product_attrs,product_extended_attrs,contributors,series,media,rating`;
}

type Product = AudibleProduct & { format_type?: string; content_type?: string; is_vvab?: boolean; publisher_name?: string };
export function audioWorkIdentity(work: Pick<WorkRow,'id'|'series_id'|'number'|'title'|'author'>): string {
  return hash([work.id,work.series_id,work.number,normalizeIdentity(work.title),normalizeIdentity(work.author)]);
}

/** An observed buy link is a lead. The product itself must establish the audio identity. */
export function verifyAudioProduct(value: unknown, asin: string, seed: SeedSeries, number: number, expectedAuthor?: string): Product {
  const product = (value as { product?: Product } | null)?.product;
  if (!product || typeof product !== 'object' || !product.asin) throw new Error('Audiobook response contains no product.');
  if (product.asin !== asin) throw new ReviewError('Audiobook API returned a different identifier.');
  if (!product.title?.trim()) throw new ReviewError('The API returned no audiobook metadata for this identifier; its identity or marketplace needs review.');
  if (product.language?.toLowerCase() !== 'english') throw new ReviewError('The identified audiobook is not confirmed to be in English.');
  if (product.content_type !== 'Product' || product.format_type !== 'unabridged') throw new ReviewError('The identified audio is not a full unabridged audiobook.');
  if (/\b(collection|omnibus|box(?:ed)?\s*set|summary|summaries|dramatized|dramatised|episode|books?\s*\d+\s*[-–]\s*\d+)\b/i.test(`${product.title} ${product.subtitle ?? ''}`)) {
    throw new ReviewError('Collection, adaptation, episode, or summary requires an explicit edition mapping.');
  }
  const authors = product.authors?.map(a => a.name) ?? [];
  if (!creditedAuthorKeys(seed,authors)) throw new ReviewError('Audiobook author credits conflict with the selected series.');
  if (expectedAuthor && !sameAuthorCredits(seed,authors,expectedAuthor)) throw new ReviewError('Audiobook author credits conflict with the selected work.');
  const series = product.series?.find(s => [seed.title, ...seed.aliases].some(title => normalizeIdentity(title) === normalizeIdentity(s.title)));
  if (!series || !/^\d+(?:\.\d+)?$/.test(series.sequence ?? '') || Number(series.sequence) !== number) throw new ReviewError('Audiobook series or volume conflicts with the selected work.');
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
export function importAudioProduct(db: Database.Database, seed: SeedSeries, work: WorkRow, product: Product, doc: Document): void {
  if(work.series_id!==seed.id||!creditedAuthorKeys(seed,work.author))
    throw new ReviewError('Canonical work identity conflicts with its selected series.');
  if(!sameAuthorCredits(seed,work.author,product.authors?.map(author=>author.name)??[]))
    throw new ReviewError('Audiobook author credits conflict with the selected work.');
  const row = productToBookRow({...product, authors: product.authors?.filter(a => !seed.publisherCredits?.some(p => normalizeIdentity(p) === normalizeIdentity(a.name)))}), stamp = new Date().toISOString();
  const seriesId = seriesIdentity(seed.title, seed.author);
  const existing = db.prepare('SELECT work_id,identifiers_json FROM catalog_editions WHERE legacy_book_id=?').get(product.asin) as { work_id: string; identifiers_json:string } | undefined;
  if (existing && existing.work_id !== work.id) throw new ReviewError('Verified audio identifier is already attached to another work.');
  const previousIdentity=existing?(JSON.parse(existing.identifiers_json) as {workIdentityHash?:string}).workIdentityHash:undefined;
  if(previousIdentity&&previousIdentity!==audioWorkIdentity(work))throw new ReviewError('Canonical work identity changed after audio verification; its edition binding needs an explicit review.');
  db.transaction(() => {
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
    const current=db.prepare('SELECT source_description,source_url FROM catalog_works WHERE id=?').get(work.id) as Pick<WorkRow,'source_description'|'source_url'>;
    const length=row.description?.length??0, prior=current.source_description.trim();
    const priorClaim=db.prepare("SELECT method FROM catalog_claims WHERE entity_type='work' AND entity_id=? AND field='description' AND value_json=? ORDER BY observed_at DESC LIMIT 1").get(work.id,JSON.stringify(current.source_description)) as {method:string}|undefined;
    const richer=!!product.publisher_summary&&length>prior.length&&(current.source_url.startsWith('https://api.audible.com/')||priorClaim?.method==='curated-source-summary'||prior.length<250&&length>prior.length*1.5);
    if (length >= 100 && (!prior || richer)) {
      db.prepare('UPDATE catalog_works SET source_description=?,source_url=?,updated_at=? WHERE id=?').run(row.description, doc.url, stamp, work.id);
      retainClaim(db, 'work', work.id, 'description', row.description, { ...doc, method: 'retailer-api' });
    }
    // Independent product identity has now settled this exact candidate. Keep the old
    // conflict and its payload as history, while recording the evidence that resolved it.
    db.prepare(`UPDATE catalog_jobs SET status='completed',result_json=?,updated_at=?
      WHERE kind='review-edition' AND entity_id=? AND status='review'`)
      .run(JSON.stringify({resolution:'verified-exact-product',documentId:doc.id,workId:work.id,asin:product.asin}),stamp,`${work.id}--${product.asin}`);
  })();
}

export async function processAudio(db: Database.Database, payload: AudioPayload, selected: SeedSeries[]) {
  const seed = selected.find(s => s.id === payload.seriesId);
  const work = db.prepare('SELECT * FROM catalog_works WHERE id=? AND series_id=?').get(payload.workId, payload.seriesId) as WorkRow | undefined;
  if (!seed || !work) throw new ReviewError('Audio job has no selected canonical work.');
  const { document, downloaded } = await getDocument(db, audioProductUrl(payload.asin), { format: 'audible-product', ttlDays: 90 });
  const product = verifyAudioProduct(JSON.parse(document.body), payload.asin, seed, work.number,work.author);
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
