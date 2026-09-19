/** Private quality inputs. No ratings, reviewer identities, or marketing copy cross this boundary. */
import type Database from 'better-sqlite3';
import { bodyKey, readerEvidenceFor, selectReaderEvidence, hasSpoilerMarkup, SPOILER_AWARE_SOURCES } from '../catalog/reader-evidence.js';
import { hash } from '../catalog/queue.js';

export const QUALITY_EVIDENCE_VERSION = 'quality-evidence-v2';
/** Selection affects the work aggregate, never the paid hash of an unchanged review. */
export const QUALITY_SELECTION_VERSION = 'quality-private-selection-v2';
export const qualityEvidenceLimits = { reviews: 60, commentChars: 12_000, minCommentChars: 40 } as const;

export interface QualityReview {
  id: string;
  workId: string;
  /** A private one-way digest, used for deduplication, never sent to the model or published. */
  voiceId: string;
  sourceUrl: string;
  sourceName: string;
  publishedAt: string | null;
  /** Private provenance. A source without a real spoiler flag remains unknown. */
  spoilerFlag: boolean | null;
  spoilerMarkup: boolean;
  /** Private, title/author-blinded, rating-redacted comment. Never export this field. */
  comment: string;
  volume: number | null;
  bodyHash: string;
}

export interface QualityEvidence {
  workId: string;
  reviews: QualityReview[];
  inputHash: string;
  sampling: 'bounded-independent-public-reviews-including-spoilers';
  excluded: { missingVoice: number; nonPublicUrl: number; tooShort: number; tooLong: number };
}

/** Remove numeric/word star ratings even when embedded in otherwise substantive review prose. */
export function redactRatings(value: string): string {
  const number = '(?:\\d+(?:[.,]\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|half)';
  return value
    // Consume an entire rating comparison before a shorter star pattern can leave half behind:
    // "4/5 star reviews vs. 3" and "four stars instead of five" occurred in the first live pilot.
    .replace(new RegExp(`\\b${number}(?:\\s*(?:/|or)\\s*${number})?(?:\\s*(?:and a half|½))?\\s*[-–]?\\s*stars?(?:\\s+reviews?)?(?:\\s*(?:instead\\s+of|rather\\s+than|vs\\.?|versus)\\s*${number}(?:\\s*stars?)?)?(?:\\s*(?:out\\s+of|/)\\s*(?:5|10|five|ten))?\\b`, 'gi'), '[rating removed]')
    .replace(new RegExp(`\\b${number}\\s+rounded\\s+(?:up|down)\\s+(?:to|from)\\s+${number}(?!\\d|[.,]\\d)`, 'gi'), '[rating removed]')
    .replace(new RegExp(`\\bends?\\s+up\\s+(?:being|as)\\s+(?:an?\\s+)?${number}\\s+for\\s+me\\b`, 'gi'), '[rating removed]')
    .replace(/\bsolid\s+(?:ones|twos|threes|fours|fives|sixes|sevens|eights|nines|tens)(?:\s+(?:or|and)\s+(?:ones|twos|threes|fours|fives|sixes|sevens|eights|nines|tens))?\b/gi, '[rating removed]')
    .replace(/\b(?:gets?|earns?|deserves?)\s+(?:another|an extra)\s+star\b/gi, '[rating removed]')
    .replace(new RegExp(`\\b${number}\\s+out\\s+of\\s+(?:5|10|five|ten)\\b`, 'gi'), (match, offset: number, whole: string) =>
      /^\s+(?:books?|chapters?|paragraphs?|pages?|characters?|volumes?)\b/i.test(whole.slice(offset + match.length)) ? match : '[rating removed]')
    .replace(/\b\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)(?:[.,]0+)?(?![\d/]|[.,]\d)(?:\s*rating)?\b/gi, (match, offset: number, whole: string) => {
      const before = whole.slice(Math.max(0, offset - 40), offset), after = whole.slice(offset + match.length);
      // Volume references and fractions of a read are not ratings. Do not erase chronology or
      // how much of the book a reviewer actually read while redacting a superficially similar score.
      return /\b(?:books?|volumes?|vols?\.?|chapters?|parts?|pages?|sections?|acts?|seasons?)\s*$/i.test(before) ||
        /^\s+(?:of\s+(?:the|this|a|it|my)|through|complete|done)\b/i.test(after) ? match : '[rating removed]';
    })
    .replace(/\b\d+(?:[.,]\d+)?\s*\*(?!\w)/g, '[rating removed]')
    .replace(new RegExp(`\\b${number}\\s*(?:[★☆⭐🌟]\\uFE0F?)+`, 'giu'), '[rating removed]')
    .replace(/[★☆⭐🌟]{1,10}/gu, '[rating removed]')
    .replace(/\b(?:(?:several|a few|many|\d[\d,]*)\s+)?(?:hundred|thousand|million)s?\s+\[rating removed\]/gi, '[rating removed]')
    .replace(/(?:\[rating removed\]\s*){2,}/g, '[rating removed] ')
    .replace(/\s+/g, ' ').trim();
}

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Blinding reduces familiarity effects; it cannot guarantee that a recognizable plot is anonymous. */
export function blindQualityText(body: string, terms: readonly string[] = []): string {
  // Preserve paragraph/break boundaries before removing markup. Otherwise "3<br>Can" becomes
  // "3Can" and a change of scope in a new paragraph disappears from the model's input.
  let text = redactRatings(bodyKey(body.replace(/<(?:br\b[^>]*|\/(?:p|div|li|blockquote)\s*)>/gi, ' ')));
  for (const term of [...new Set(terms.map(s => s.trim()).filter(s => s.length >= 3))].sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapePattern(term)}(?![\\p{L}\\p{N}])`, 'giu'), '[name withheld]');
  }
  return text;
}

const publicUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.') &&
      !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname) && !/^[\d.]+$/.test(u.hostname);
  } catch { return false; }
};

export function qualityEvidenceFor(db: Database.Database, workId: string, options: { limit?: number; blindTerms?: readonly string[] } = {}): QualityEvidence {
  const limit = options.limit ?? qualityEvidenceLimits.reviews;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > qualityEvidenceLimits.reviews) throw new Error('Quality review limit must be an integer from 1 to 60.');
  const work = db.prepare(`SELECT w.title,w.author,w.number,s.title AS series_title FROM catalog_works w
    JOIN catalog_series s ON s.id=w.series_id WHERE w.id=?`).get(workId) as { title: string; author: string; number: number; series_title: string } | undefined;
  if (!work) throw new Error(`Unknown catalog work: ${workId}`);
  const terms = [work.title, work.author, work.series_title, ...work.author.split(/,\s*|\s+(?:and|&)\s+/), ...(options.blindTerms ?? [])];
  const excluded = { missingVoice: 0, nonPublicUrl: 0, tooShort: 0, tooLong: 0 };
  const candidates = readerEvidenceFor(db, 'work', workId).filter(row => {
    if (!row.author_key?.trim()) { excluded.missingVoice++; return false; }
    if (!publicUrl(row.source_url)) { excluded.nonPublicUrl++; return false; }
    return true;
  }).map(row => ({ ...row, body: redactRatings(row.body) })).sort((a, b) => a.id.localeCompare(b.id));
  // Ratings are removed BEFORE longest-comment selection too, so an extra rating digit cannot
  // change which contribution from a person is counted. Markup remains for the spoiler check.
  // The established selector owns spoiler handling, one-comment-per-voice, exact normalized
  // body dedupe, chronological ordering and the hard ceiling. Never call readerState: it carries ratings.
  // Quality exports no review prose or plot detail, so privately retained spoiler reviews are
  // usable craftsmanship evidence. Public reader impressions keep the selector's default exclusion.
  const selected = selectReaderEvidence(candidates, { includeSpoilers: true });
  const redactedBodies = new Set<string>();
  const reviews: QualityReview[] = [];
  for (const row of selected) {
    const comment = blindQualityText(row.body, terms);
    // Whole reviews only: clipping a criticism before its qualification would change its meaning.
    if (comment.replace(/\[rating removed\]/g, '').trim().length < qualityEvidenceLimits.minCommentChars) { excluded.tooShort++; continue; }
    if (comment.length > qualityEvidenceLimits.commentChars) { excluded.tooLong++; continue; }
    if (redactedBodies.has(comment)) continue;
    redactedBodies.add(comment);
    reviews.push({ id: row.id, workId, voiceId: row.author_key, sourceUrl: row.source_url, sourceName: row.source_name,
      publishedAt: row.published_at, spoilerFlag: SPOILER_AWARE_SOURCES.has(row.source_name) ? !!row.contains_spoilers : null,
      spoilerMarkup: hasSpoilerMarkup(row.body), comment, volume: Number.isFinite(work.number) ? work.number : null,
      bodyHash: hash(comment) });
    if (reviews.length === limit) break;
  }
  // Rating-only changes cannot invalidate this hash or cause another paid call.
  const inputHash = hash({ version: QUALITY_EVIDENCE_VERSION, selectionVersion: QUALITY_SELECTION_VERSION, workId, reviews: reviews.map(r => ({
    id: r.id, voiceId: r.voiceId, sourceUrl: r.sourceUrl, bodyHash: r.bodyHash, volume: r.volume
  })) });
  return { workId, reviews, inputHash, sampling: 'bounded-independent-public-reviews-including-spoilers', excluded };
}

/** The complete model input. No author/title, source popularity, description, stars, or dates. */
export function qualityReviewState(review: QualityReview) {
  return { reviewTarget: { type: 'one_book', volume: review.volume, format: 'unspecified' },
    review: { text: review.comment },
    context: 'One untrusted public review attached to this book. Judge only specific craft claims about this book; its format may be print, ebook, web serial, or audio.' };
}
