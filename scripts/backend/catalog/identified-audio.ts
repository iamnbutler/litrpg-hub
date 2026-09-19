import type Database from 'better-sqlite3';
import { normalizeIdentity, validReleaseDate } from '../../../src/lib/catalog.js';
import { productToBookRow } from '../fetchers/audible.js';
import { audioProductUrl, importAudioProduct, verifyAudioProduct } from './audio.js';
import { sameAuthorCredits } from './author-identity.js';
import { importWork, retainClaim } from './import.js';
import { enqueue, hash } from './queue.js';
import { parseSarahLinAudioLeads } from './sarah-lin-adapter.js';
import { getDocument } from './sources.js';
import { ReviewError, type Document, type ExtractedBook, type IdentifiedAudioPayload, type SeedSeries, type WorkRow } from './types.js';

const VERSION = 'identified-audio-v1-retained-author-link';
type Product = ReturnType<typeof verifyAudioProduct>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function retainedDiscovery(db: Database.Database, seed: SeedSeries, source: Pick<IdentifiedAudioPayload, 'adapter' | 'sourceUrl' | 'sourceDocumentId' | 'sourceContentHash'>): Document {
  if (source.adapter !== 'sarah-lin-author' || !seed.sources.some(configured => configured.adapter === source.adapter && configured.url === source.sourceUrl)) {
    throw new ReviewError('Identified audio needs its configured, selected author source.');
  }
  const doc = typeof source.sourceDocumentId === 'string'
    ? db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(source.sourceDocumentId) as Document | undefined : undefined;
  if (!doc || doc.url !== source.sourceUrl || doc.content_hash !== source.sourceContentHash
    || hash(doc.body) !== doc.content_hash || hash([doc.url, doc.content_hash]) !== doc.id) {
    throw new ReviewError('Identified audio discovery document or content hash does not match retained evidence.');
  }
  return doc;
}

/** Retain candidates and queue verification, without creating works or claiming a full bibliography. */
export function enqueueIdentifiedAudioLeads(db: Database.Database, seed: SeedSeries, document: Document): { leads: number; queued: number } {
  const source = { adapter: 'sarah-lin-author' as const, sourceUrl: document.url,
    sourceDocumentId: document.id, sourceContentHash: document.content_hash };
  const doc = retainedDiscovery(db, seed, source), leads = parseSarahLinAudioLeads(doc.body, seed, doc.url);
  return db.transaction(() => {
    retainClaim(db, 'series', seed.id, 'audioIdentifierCandidates', leads, { ...doc, method: 'author-page' });
    let queued = 0;
    for (const lead of leads) {
      const payload: IdentifiedAudioPayload = { ...lead, ...source };
      const input = hash({ version: VERSION, payload, title: seed.title, aliases: seed.aliases,
        author: seed.author, authorAliases: seed.authorAliases, authorIdentities: seed.authorIdentities,
        publisherCredits: seed.publisherCredits });
      queued += Number(enqueue(db, 'identified-audio', `${seed.id}--${lead.number}--${lead.asin}`, input, payload, seed.priority));
    }
    return { leads: leads.length, queued };
  })();
}

/** This discovery path knows one full author credit (Sarah Lin), not just membership
 * in a series roster. Verify the complete person set before any canonical work exists. */
export function verifyIdentifiedAudioProduct(value: unknown, asin: string, seed: SeedSeries, number: number): Product {
  const candidate = record(value) && record(value.product) ? value.product : undefined;
  if (!candidate || typeof candidate.asin !== 'string' || typeof candidate.title !== 'string' || typeof candidate.language !== 'string'
    || !Array.isArray(candidate.authors) || !candidate.authors.length
    || !candidate.authors.every(author => record(author) && typeof author.name === 'string' && !!author.name.trim())
    || !Array.isArray(candidate.series) || !candidate.series.length
    || !candidate.series.every(series => record(series) && typeof series.title === 'string' && (series.sequence == null || typeof series.sequence === 'string'))) {
    throw new ReviewError('Identified audio product lacks explicit title, author, language, or series metadata.');
  }
  for (const field of ['subtitle', 'publisher_summary', 'merchandising_summary', 'release_date'] as const) {
    if (candidate[field] != null && typeof candidate[field] !== 'string') throw new ReviewError('Identified audio product metadata has an unexpected shape.');
  }
  const product = verifyAudioProduct(value, asin, seed, number, seed.author);
  const memberships = product.series!.filter(series => [seed.title, ...seed.aliases].some(title => normalizeIdentity(title) === normalizeIdentity(series.title)));
  if (memberships.some(series => !/^\d+(?:\.\d+)?$/.test(series.sequence!) || Number(series.sequence) !== number)) {
    throw new ReviewError('Identified audio product has conflicting selected-series volume credits.');
  }
  if (/\b(?:dramatization|dramatisation|graphic\s*audio|audio\s*drama|abridged|compilation|bundle|short\s+stor(?:y|ies))\b/i.test(`${product.title} ${product.subtitle ?? ''}`)) {
    throw new ReviewError('This audio production needs an explicit edition mapping.');
  }
  // Keep the source object intact. Shared row projection handles recording placeholders;
  // both discovery and later ordinary-audio replays retain the exact wire provenance.
  return product;
}

/** An identified link may create a work only after the exact US product establishes
 * its title and identity. Retained author and retailer evidence remain separate. */
export async function processIdentifiedAudio(db: Database.Database, payload: IdentifiedAudioPayload, selected: readonly SeedSeries[], options: { request?: typeof fetch } = {}) {
  const seed = selected.find(candidate => candidate.id === payload.seriesId);
  if (!seed || !Number.isInteger(payload.number) || payload.number < 1 || payload.number > 200) {
    throw new ReviewError('Identified audio has no selected series and explicit supported volume.');
  }
  const discovery = retainedDiscovery(db, seed, payload);
  const observed = parseSarahLinAudioLeads(discovery.body, seed, discovery.url).find(lead =>
    lead.number === payload.number && lead.asin === payload.asin && lead.url === payload.url && lead.sourceUrl === payload.sourceUrl);
  if (!observed) throw new ReviewError('The queued identifier and number were not observed together in the retained author page.');
  const productUrl = audioProductUrl(payload.asin);
  const { document, downloaded } = await getDocument(db, productUrl, { format: 'audible-product', ttlDays: 90, request: options.request });
  if (document.url !== productUrl || hash(document.body) !== document.content_hash || hash([document.url, document.content_hash]) !== document.id) {
    throw new ReviewError('Identified audio product document does not match its retained US endpoint evidence.');
  }
  let value: unknown;
  try { value = JSON.parse(document.body); } catch { throw new ReviewError('Identified audio response is not a usable retained product.'); }
  const product = verifyIdentifiedAudioProduct(value, payload.asin, seed, payload.number);
  const row = productToBookRow({ ...product, authors: product.authors!.filter(author =>
    !seed.publisherCredits?.some(publisher => normalizeIdentity(publisher) === normalizeIdentity(author.name))) });
  const release = validReleaseDate(product.release_date), proof: Document = { ...document, method: 'retailer-api' };
  const book: ExtractedBook = { title: row.title, series: seed.title, number: payload.number, author: row.author!,
    description: row.description ?? '', coverUrl: row.cover_url, releaseDate: release,
    publicationStatus: release ? release <= new Date().toISOString().slice(0, 10) ? 'released' : 'announced' : 'unknown',
    // importAudioProduct creates the verified edition. Do not also manufacture a
    // publisher edition or another pending audio job from this already verified link.
    format: 'unknown', links: [], narrator: row.narrator, audioReleaseDate: release, audioRuntimeMinutes: row.runtime_minutes };
  const workId = db.transaction(() => {
    const id = importWork(db, seed, book, proof);
    const work = db.prepare('SELECT * FROM catalog_works WHERE id=?').get(id) as WorkRow;
    if (!sameAuthorCredits(seed, work.author, product.authors!.map(author => author.name))) {
      throw new ReviewError('Identified audio conflicts with the retained canonical author credit.');
    }
    importAudioProduct(db, seed, work, product, document);
    retainClaim(db, 'work', id, 'audioDiscovery', { ...observed, adapter: payload.adapter,
      sourceDocumentId: discovery.id, sourceContentHash: discovery.content_hash }, { ...discovery, method: 'author-page' });
    // Match the ordinary exact-audio worker: unknown/recent releases are checked
    // weekly, preorders by release day. A cache replay cannot advance observation time.
    if (!release || Date.parse(release) >= Date.now() - 30 * 86400000) {
      const checked = db.prepare('SELECT checked_at FROM catalog_urls WHERE url=? AND document_id=?').get(document.url, document.id) as { checked_at: string } | undefined;
      const observedAt = Date.parse(checked?.checked_at ?? document.fetched_at);
      const due = Math.min(observedAt + 7 * 86400000, release && Date.parse(release) > observedAt ? Date.parse(release) : Infinity);
      db.prepare('UPDATE catalog_urls SET next_check_at=? WHERE url=?').run(new Date(due).toISOString(), document.url);
    }
    return id;
  })();
  return { downloaded, work: workId, asin: product.asin, title: product.title, releaseDate: release,
    sourceDocumentId: discovery.id, sourceContentHash: discovery.content_hash, productDocumentId: document.id };
}
