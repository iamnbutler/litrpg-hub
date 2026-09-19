import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { FEATURE_TAXONOMY_VERSION, type FeatureEvidence } from '../../../src/lib/catalog.js';
import { featureTags, validateExtraction, type Extraction } from './inference.js';
import { hash } from './queue.js';

export interface EditorialReview {
  entityType: 'work' | 'series';
  entityId: string;
  /** Immutable extraction receipt. A later model run cannot replace approved prose. */
  inputHash: string;
  /** Source inputs only: independent of model and prompt changes. */
  evidenceHash: string;
  taxonomyVersion: string;
  reviewedAt: string;
  sourceUrl: string;
  additionalSourceUrls?: string[];
  allowedFeatures: Extraction['features'][number]['tag'][];
  correctedSynopsis?: string;
  reviewNote: string;
}

const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sourceUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
};

export function validateEditorialReviews(value: unknown): EditorialReview[] {
  if (!Array.isArray(value)) throw new Error('Editorial reviews must be a list.');
  const seen = new Set<string>();
  return value.map((item: EditorialReview) => {
    if (!item || !['work', 'series'].includes(item.entityType)
      || typeof item.entityId !== 'string' || !item.entityId.trim()
      || !digest(item.inputHash) || !digest(item.evidenceHash)
      || typeof item.taxonomyVersion !== 'string' || !item.taxonomyVersion
      || typeof item.reviewedAt !== 'string' || !Number.isFinite(Date.parse(item.reviewedAt))
      || !sourceUrl(item.sourceUrl) || typeof item.reviewNote !== 'string' || !item.reviewNote.trim()
      || (item.additionalSourceUrls !== undefined && (!Array.isArray(item.additionalSourceUrls)
        || item.additionalSourceUrls.some(url => !sourceUrl(url) || url === item.sourceUrl)
        || new Set(item.additionalSourceUrls).size !== item.additionalSourceUrls.length))
      || !Array.isArray(item.allowedFeatures) || item.allowedFeatures.some(tag => !featureTags.includes(tag))
      || new Set(item.allowedFeatures).size !== item.allowedFeatures.length
      || (item.correctedSynopsis !== undefined && (typeof item.correctedSynopsis !== 'string'
        || item.correctedSynopsis.trim().length < 80 || item.correctedSynopsis.trim().split(/\s+/).length > 160))) {
      throw new Error('An editorial review has invalid identity, evidence, or metadata.');
    }
    const reviewedAt = new Date(item.reviewedAt).toISOString();
    const key = [item.entityType, item.entityId, item.evidenceHash, item.taxonomyVersion, reviewedAt].join(':');
    if (seen.has(key)) throw new Error('Duplicate editorial review.');
    seen.add(key);
    // Keep the runtime artifact closed: quoted source excerpts and private notes belong in
    // retained evidence, never in an accidentally copied extra configuration property.
    const keys = new Set(['entityType', 'entityId', 'inputHash', 'evidenceHash', 'taxonomyVersion', 'reviewedAt', 'sourceUrl', 'additionalSourceUrls', 'allowedFeatures', 'correctedSynopsis', 'reviewNote']);
    if (Object.keys(item).some(key => !keys.has(key))) throw new Error('Unexpected editorial review field.');
    return { ...item, reviewedAt, allowedFeatures: [...item.allowedFeatures], ...(item.additionalSourceUrls ? { additionalSourceUrls: [...item.additionalSourceUrls] } : {}) };
  });
}

export const editorialReviews = validateEditorialReviews(JSON.parse(readFileSync(new URL('../config/catalog-editorial-reviews.json', import.meta.url), 'utf8')));

export interface ReviewedMetadata {
  synopsis: string;
  features: string[];
  evidence: FeatureEvidence;
}

/** Resolve a reviewed snapshot, never mark a new model answer reviewed by association.
 * Source, identity or taxonomy changes invalidate it. A model-only rerun does not.
 * Omitted features are unknown, not negative assertions about the book. */
export function reviewedMetadata(
  db: Database.Database,
  entityType: EditorialReview['entityType'],
  entityId: string,
  input: { description: string },
  url: string,
  reviews: readonly EditorialReview[] = editorialReviews,
  additionalSourceUrls: readonly string[] = []
): ReviewedMetadata | null {
  const review = reviews.filter(item => item.entityType === entityType && item.entityId === entityId
    && item.evidenceHash === hash(input) && item.sourceUrl === url
    && JSON.stringify([...(item.additionalSourceUrls ?? [])].sort()) === JSON.stringify([...additionalSourceUrls].sort())
    && item.taxonomyVersion === FEATURE_TAXONOMY_VERSION)
    .sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt))[0];
  if (!review) return null;
  const receipt = db.prepare(`SELECT result_json FROM catalog_inferences
    WHERE entity_type=? AND entity_id=? AND kind='extract' AND input_hash=?`)
    .get(entityType, entityId, review.inputHash) as { result_json: string } | undefined;
  if (!receipt) return null;
  const approved = validateExtraction(JSON.parse(receipt.result_json), input.description);
  const supported = new Set(approved.features.map(feature => feature.tag));
  if (review.allowedFeatures.some(tag => !supported.has(tag))) {
    throw new Error(`Editorial review for ${entityId} allows a feature absent from its source-supported receipt.`);
  }
  return {
    synopsis: review.correctedSynopsis?.trim() ?? approved.synopsis,
    features: [...review.allowedFeatures],
    evidence: { sourceUrl: review.sourceUrl, reviewedAt: review.reviewedAt, taxonomyVersion: review.taxonomyVersion,
      ...(review.additionalSourceUrls?.length ? { additionalSourceUrls: [...review.additionalSourceUrls] } : {}) }
  };
}
