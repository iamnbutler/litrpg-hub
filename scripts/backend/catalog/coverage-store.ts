import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { validReleaseDate } from '../../../src/lib/catalog.js';
import { assessAudioCoverage, type AudioCoverage, type CoverageEdition, type CoverageEvidence, type ReviewedAudioManifest } from './coverage.js';
import { audioWorkIdentity, verifyCanonicalAudioProduct } from './audio.js';
import { hash } from './queue.js';
import type { Document, SeedSeries } from './types.js';

type EvidenceReference = Omit<CoverageEvidence, 'observedAt'>;
export interface AudioManifestSpec extends Omit<ReviewedAudioManifest, 'bibliography' | 'finalListEvidence'> {
  bibliography: EvidenceReference[];
  finalListEvidence?: EvidenceReference;
  /** Reviewer context, never a replacement for the retained source. */
  notes?: string;
}
export const audioManifests = JSON.parse(readFileSync(new URL('../config/catalog-audio-manifests.json', import.meta.url), 'utf8')) as AudioManifestSpec[];

/** Resolve observation time from retained evidence. An export or model run cannot renew it.
 * An unchanged HTTP 304 can; a changed page needs its bibliography reviewed again. */
function observation(db: Database.Database, doc: Document): string | null {
  if (hash(doc.body) !== doc.content_hash) return null;
  const head = db.prepare('SELECT document_id,checked_at FROM catalog_urls WHERE url=?').get(doc.url) as { document_id: string; checked_at: string } | undefined;
  if (head && head.document_id !== doc.id) return null;
  return head && head.checked_at > doc.fetched_at ? head.checked_at : doc.fetched_at;
}

function primaryEvidence(db: Database.Database, reference: EvidenceReference): CoverageEvidence {
  const doc = db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(reference.documentId) as Document | undefined;
  // A curated research note is useful evidence, but it is not an observed bibliography page.
  const observedAt = doc && doc.url === reference.url && doc.body.trimStart().startsWith('<')
    && reference.sourceType !== 'retailer' ? observation(db, doc) : null;
  return { ...reference, observedAt: observedAt ?? '' };
}

export function catalogAudioCoverage(db: Database.Database, seed: SeedSeries, now = new Date().toISOString(), specifications: readonly AudioManifestSpec[] = audioManifests): AudioCoverage {
  const spec = specifications.find(item => item.seriesId === seed.id);
  let manifest: ReviewedAudioManifest | undefined;
  if (spec) {
    const { bibliography, finalListEvidence, notes: _notes, ...reviewed } = spec;
    manifest = { ...reviewed, bibliography: bibliography.map(reference => primaryEvidence(db, reference)),
      ...(finalListEvidence ? { finalListEvidence: primaryEvidence(db, finalListEvidence) } : {}) };
  }
  const works = db.prepare('SELECT id,series_id,number,title,author FROM catalog_works WHERE series_id=?').all(seed.id) as { id: string; series_id: string; number: number;title:string;author:string }[];
  const byId = new Map(works.map(work=>[work.id,work]));
  const rows = db.prepare(`SELECT e.id,e.work_id,e.legacy_book_id,e.format,e.identifiers_json,w.number
    FROM catalog_editions e JOIN catalog_works w ON w.id=e.work_id WHERE w.series_id=?`).all(seed.id) as {
      id: string; work_id: string; legacy_book_id: string | null; format: CoverageEdition['format']; identifiers_json: string; number: number
    }[];
  const editions: CoverageEdition[] = rows.map(row => {
    const edition: CoverageEdition = { id: row.legacy_book_id ?? row.id, workId: row.work_id, format: row.format, verification: null };
    try {
      const identifiers = JSON.parse(row.identifiers_json) as { asin?: string; marketplace?: string; verifiedDocument?: string; workIdentityHash?: string };
      if (row.format !== 'audiobook' || !row.legacy_book_id || identifiers.asin !== row.legacy_book_id
        || identifiers.marketplace !== 'US' || !identifiers.verifiedDocument
        || identifiers.workIdentityHash !== audioWorkIdentity(byId.get(row.work_id)!)) return edition;
      const recorded = db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(identifiers.verifiedDocument) as Document | undefined;
      if (!recorded) return edition;
      const recordedUrl = new URL(recorded.url);
      const productBase = `https://api.audible.com/1.0/catalog/products/${row.legacy_book_id}`;
      if (recordedUrl.origin !== 'https://api.audible.com' || recordedUrl.pathname !== `/1.0/catalog/products/${row.legacy_book_id}`) return edition;
      // response_groups is a request shape, not a new product identity. A newer response
      // must override old proof even when it was requested with a different query string.
      const current = db.prepare(`SELECT d.* FROM catalog_urls u JOIN catalog_documents d ON d.id=u.document_id
        WHERE u.url=? OR u.url LIKE ? ORDER BY u.checked_at DESC,d.fetched_at DESC,d.id LIMIT 1`)
        .get(productBase, `${productBase}?%`) as Document | undefined;
      const doc = current ?? recorded;
      const url = new URL(doc.url), observedAt = observation(db, doc);
      if (url.origin !== 'https://api.audible.com' || url.pathname !== `/1.0/catalog/products/${row.legacy_book_id}` || !observedAt) return edition;
      // Check the actual retained product again, not the edition row's copied claims.
      const work = byId.get(row.work_id)!;
      const product = verifyCanonicalAudioProduct(db, JSON.parse(doc.body), row.legacy_book_id, seed, work, doc);
      edition.verification = {
        method: 'exact-retailer-product', workId: row.work_id, seriesId: seed.id, number: row.number,
        language: product.language!, marketplace: 'US', format: 'unabridged',
        audioReleaseDate: validReleaseDate(product.release_date ?? ''),
        evidence: { documentId: doc.id, url: doc.url, observedAt, sourceType: 'retailer' }
      };
    } catch { /* An invalid or obsolete proof leaves this edition unverified. */ }
    return edition;
  });
  return assessAudioCoverage({ seriesId: seed.id, now, manifest,
    works: works.map(work => ({ id: work.id, seriesId: work.series_id, number: work.number })), editions });
}
