import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { normalizeIdentity, type CatalogBook } from '../../../src/lib/catalog.js';
import { buildCatalog } from '../exporters/catalog.js';
import { creditedAuthorKeys } from '../catalog/author-identity.js';
import { enqueue, hash } from '../catalog/queue.js';
import { JevReviewError } from '../catalog/paid-jev.js';
import type { SeedSeries } from '../catalog/types.js';
import { qualityEvidenceFor } from './evidence.js';
import { loadReviewJudgement, loadWorkQuality, processQualityReview, qualityReviewHash } from './assessment.js';
import { scoreAuthor, scoreBook, scoreSeries, qualityThresholds } from './scoring.js';
import type { ContentSignals, QualityPreferences, RenownEvidence } from './types.js';

export const QUALITY_JOB_KIND = 'quality-review';
const seeds = JSON.parse(readFileSync(new URL('../config/catalog-seeds.json', import.meta.url), 'utf8')) as SeedSeries[];
interface Work { id: string; series_id: string; number: number; title: string; author: string }
interface Series { id: string; title: string; author: string }
interface Edition { id: string; work_id: string; legacy_book_id: string | null; format: string; release_date: string | null; source_url: string }
export interface RenownClaim {
  id: string; entityType: string; entityId: string; claim: string; sourceUrl: string;
  observedAt: string; assessment: RenownEvidence;
}
export interface QualityOptions {
  now?: Date;
  model?: string;
  preferences?: Partial<QualityPreferences>;
  /** Injectable safe input for fixtures; production assembles current content evidence. */
  catalogBooks?: CatalogBook[];
  renownEvidence?: RenownClaim[];
}

const safeUrl = (value: string): string | null => {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')
      || /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[)/.test(u.hostname)
      || /^172\.(?:1[6-9]|2\d|3[01])\./.test(u.hostname)
      || /\.(?:local|internal|test|invalid)$/.test(u.hostname) || /\/(?:users?|profiles?)\//i.test(u.pathname)) return null;
    return `${u.origin}${u.pathname}`;
  } catch { return null; }
};

function renownClaims(): RenownClaim[] {
  // Calibration targets NEVER enter scoring or a model prompt. Only individually sourced
  // recognition events are read from the research registry.
  const file = new URL('./benchmarks.json', import.meta.url);
  try { return (JSON.parse(readFileSync(file, 'utf8')) as { renownEvidence?: RenownClaim[] }).renownEvidence ?? []; }
  catch { return []; }
}

function recognition(rows: RenownClaim[], kind: string, id: string, now: Date): RenownEvidence | undefined {
  const claims = rows.filter(r => r.entityType === kind && r.entityId === id && safeUrl(r.sourceUrl)
    && Number.isFinite(Date.parse(r.observedAt)) && Date.parse(r.observedAt) <= now.getTime()
    && r.assessment && Number.isFinite(r.assessment.score) && r.assessment.score > 0 && r.assessment.score <= 100
    && Number.isFinite(r.assessment.confidence) && r.assessment.confidence >= qualityThresholds.renownConfidence && r.assessment.confidence <= 1
    && ['independent-recognition', 'editorial-reference'].includes(r.assessment.basis));
  if (!claims.length) return undefined;
  // Repeated publicity is not independent support. The strongest single reviewed event wins.
  const winner = [...claims].sort((a, b) => b.assessment.score * b.assessment.confidence - a.assessment.score * a.assessment.confidence || a.id.localeCompare(b.id))[0];
  return { ...winner.assessment, evidenceIds: [winner.id] };
}

function contentSignals(books: CatalogBook[], workId: string): ContentSignals {
  const result: ContentSignals = {};
  for (const key of ['explicit', 'harem', 'sexualized'] as const) {
    const values = books.flatMap(b => b.workId === workId ? [{ book: b.id, signal: b.content[key] }] : [])
      .filter(v => v.signal.verdict !== 'unknown' && v.signal.confidence >= 0.8);
    const verdicts = new Set(values.map(v => v.signal.verdict));
    // Conflicting recordings/listings remain unresolved; positive and negative evidence
    // are never silently collapsed into whichever edition happened to be first.
    if (verdicts.size !== 1) continue;
    result[key] = { verdict: values[0].signal.verdict, confidence: Math.min(...values.map(v => v.signal.confidence)),
      evidenceIds: values.map(v => `content:${v.book}:${key}:${hash(v.signal).slice(0, 16)}`).sort() };
  }
  return result;
}

function authorCredits(series: Series, credit = series.author): { id: string; name: string }[] {
  const seed = seeds.find(s => s.id === series.id);
  const keys = seed ? creditedAuthorKeys(seed, credit) : null;
  // A reviewed identity roster rejecting a credit cannot be bypassed by splitting it.
  if (seed && !keys) return [];
  if (!seed && /,|\s+and\s+/i.test(credit)) return [];
  const names = (seed?.author ?? credit).split(/,|\s+and\s+/i).map(n => n.trim()).filter(Boolean);
  if (!names.length || names.some(n => /^(?:unknown|unknown author)$/i.test(n))) return [];
  return (keys ?? names.map(normalizeIdentity)).map(key => ({
    id: `author-${hash(key).slice(0, 20)}`,
    name: (seed?.authorIdentities?.find(p => normalizeIdentity(p.name) === key)?.name)
      ?? names.find(n => normalizeIdentity(n) === key) ?? series.author
  }));
}

/** Edition timing is useful context, never passed off as the time spent writing a book. */
function audioCadence(editions: Edition[], asOf: string) {
  const dates = new Map<string, string>();
  for (const e of editions) {
    const date = e.release_date;
    if (e.format !== 'audiobook' || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > asOf) continue;
    if (!dates.has(e.work_id) || date < dates.get(e.work_id)!) dates.set(e.work_id, date);
  }
  const ordered = [...dates.values()].sort();
  const gaps = ordered.slice(1).map((d, i) => Math.round((Date.parse(d) - Date.parse(ordered[i])) / 86_400_000));
  const sorted = [...gaps].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { releasedWorks: dates.size, medianDays: !sorted.length ? null : sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    intervalsAtMost62Days: gaps.filter(d => d <= 62).length,
    interpretation: 'Observed audiobook publication intervals; not composition time. No quality penalty.' };
}

export function planQualityJobs(db: Database.Database, options: { seriesId?: string; workId?: string; model?: string } = {}) {
  const works = db.prepare('SELECT id,series_id,number FROM catalog_works ORDER BY series_id,number,id').all() as Work[];
  let queued = 0, cached = 0, selected = 0, unusable = 0;
  for (const work of works) {
    if (options.seriesId && work.series_id !== options.seriesId || options.workId && work.id !== options.workId) continue;
    const evidence = qualityEvidenceFor(db, work.id);
    // A tiny sample cannot produce a work score. Keep its raw evidence without spending.
    if (evidence.reviews.length < 5) continue;
    for (const review of evidence.reviews) {
      selected++;
      try { if (loadReviewJudgement(db, review, { model: options.model })) { cached++; continue; } }
      catch (error) { if (error instanceof JevReviewError) { unusable++; continue; } throw error; }
      const inputHash = qualityReviewHash(review, options.model);
      if (enqueue(db, QUALITY_JOB_KIND, review.id, inputHash,
        { workId: work.id, seriesId: work.series_id, reviewId: review.id, inputHash, model: options.model ?? process.env.JEV_MODEL ?? 'jev-latest' },
        ['dungeon-crawler-carl', 'cradle', 'the-primal-hunter', 'heretical-fishing'].includes(work.series_id) ? 10 : 0)) queued++;
    }
  }
  return { queued, selected, cached, unusable };
}

export async function processQualityJob(db: Database.Database, payload: {
  workId: string; reviewId: string; inputHash: string; model: string;
}) {
  const evidence = qualityEvidenceFor(db, payload.workId);
  if (evidence.reviews.length < 5) return { skipped: 'The current sample is below the five-voice acquisition gate.', input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0 };
  const review = evidence.reviews.find(r => r.id === payload.reviewId);
  if (!review || qualityReviewHash(review, payload.model) !== payload.inputHash) {
    return { skipped: 'Evidence changed or was removed; plan current inputs.', input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0 };
  }
  return processQualityReview(db, review, { model: payload.model });
}

/** Recomputes only from current evidence and matching retained receipts. Never buys a call. */
export function buildQualityIndex(db: Database.Database, options: QualityOptions = {}) {
  const now = options.now ?? new Date(), asOf = now.toISOString().slice(0, 10);
  const works = db.prepare('SELECT id,series_id,number,title,author FROM catalog_works ORDER BY series_id,number,id').all() as Work[];
  const seriesRows = db.prepare('SELECT id,title,author FROM catalog_series ORDER BY id').all() as Series[];
  const editions = db.prepare('SELECT id,work_id,legacy_book_id,format,release_date,source_url FROM catalog_editions ORDER BY id').all() as Edition[];
  const catalogBooks = options.catalogBooks ?? buildCatalog(db, now).books;
  const renown = options.renownEvidence ?? renownClaims();
  const prefs = options.preferences;
  const seriesById = new Map(seriesRows.map(s => [s.id, s]));
  const creditsByWork = new Map(works.map(w => [w.id, authorCredits(seriesById.get(w.series_id)!, w.author)]));
  const books = works.map(work => {
    const assessed = loadWorkQuality(db, work.id, { model: options.model });
    const scored = scoreBook({ id: work.id, seriesId: work.series_id, number: work.number,
      // Scoring an arbitrary completed prefix makes rankings depend on worker order. Keep
      // partial receipts, but wait for the selected sample before publishing a point score.
      craft: assessed.complete ? { dimensions: assessed.dimensions, relevantVoices: assessed.relevantVoices }
        : { dimensions: {}, relevantVoices: 0 },
      content: contentSignals(catalogBooks, work.id), renown: recognition(renown, 'book', work.id, now) }, prefs);
    const evidence = qualityEvidenceFor(db, work.id);
    const recordings = editions.filter(e => e.work_id === work.id && ['audiobook', 'dramatized'].includes(e.format));
    return { ...scored, title: work.title, author: work.author,
      authorIds: creditsByWork.get(work.id)!.map(a => a.id),
      hasAudio: recordings.length > 0,
      editionIds: recordings.flatMap(e => [e.id, ...(e.legacy_book_id ? [e.legacy_book_id] : [])]).sort(),
      audio: assessed.audio,
      evidence: { inputHash: assessed.inputHash, sampledVoices: assessed.selectedVoices, judgedVoices: assessed.judgedVoices,
        pendingReviews: assessed.pending.length, unusableReviews: assessed.unusable.length, complete: assessed.complete, sampling: evidence.sampling,
        sources: [...new Set(evidence.reviews.map(r => safeUrl(r.sourceUrl)).filter((u): u is string => !!u))].sort(),
        limitations: [...(!assessed.complete ? ['Assessment incomplete; the craft point score is withheld until the selected sample has been judged.'] : []),
          'Public review sample, not a direct manuscript evaluation.', 'Reviews can describe print, ebook, serial or audio; audio performance is separate.'] }
    };
  });
  const series = seriesRows.map(row => {
    const selected = books.filter(b => b.seriesId === row.id);
    const workIds = new Set(selected.map(b => b.id));
    return { ...scoreSeries({ id: row.id, books: selected, knownWorkCount: selected.length, catalogComplete: false,
      renown: recognition(renown, 'series', row.id, now) }, prefs), title: row.title, author: row.author,
      authors: [...new Map(selected.flatMap(b => creditsByWork.get(b.id)!).map(a => [a.id, a])).values()],
      audioCadence: audioCadence(editions.filter(e => workIds.has(e.work_id)), asOf) };
  });
  const people = new Map<string, { id: string; name: string }>();
  for (const s of series) for (const a of s.authors) people.set(a.id, a);
  const authors = [...people.values()].sort((a, b) => a.id.localeCompare(b.id)).map(person => {
    // The series roster does not establish who wrote every volume. Attribute only works
    // carrying this person's verified credit, then preserve the equal-series weighting.
    const selected = series.filter(s => s.authors.some(a => a.id === person.id)).map(s => {
      const credited = books.filter(b => b.seriesId === s.id && b.authorIds.includes(person.id));
      return scoreSeries({ id: s.id, books: credited, knownWorkCount: credited.length, catalogComplete: false }, prefs);
    });
    return { ...scoreAuthor({ id: person.id, series: selected, knownSeriesCount: selected.length, catalogComplete: false,
      renown: recognition(renown, 'author', person.id, now) }, prefs), name: person.name,
      attribution: 'Only verified credited works; coauthored works describe joint output, not an isolated personal contribution.' };
  });
  return {
    version: books[0]?.version ?? 'quality-index-v1', generatedAt: now.toISOString(),
    model: options.model ?? process.env.JEV_MODEL ?? 'jev-latest',
    policy: { ratingsUsed: false, targetsUsedAsInputs: false, manuscriptAssessed: false,
      stage: 'research', metric: 'selected-reader-craft-sentiment', publicRankingEnabled: false,
      validation: 'Not calibrated as an overall literary-quality scale. Sparse aspect scores are diagnostics, not a public ranking.',
      description: 'Versioned review-evidence craft index with separate content-fit and capped recognition adjustments. Unknown is never zero.',
      aggregation: 'Equal assessed books within series; equal assessed series within author. Coverage describes the known catalog, not an exhaustive bibliography.',
      production: 'Audiobook cadence is context only. A risk adjustment requires verified original-publication dates, excluded backlog and corroborating craft defects.' },
    totals: { books: books.length, series: series.length, authors: authors.length,
      scoredBooks: books.filter(b => b.craft.score !== null).length, scoredSeries: series.filter(s => s.craft.score !== null).length,
      scoredAuthors: authors.filter(a => a.craft.score !== null).length,
      selectedReviews: books.reduce((sum, b) => sum + b.evidence.sampledVoices, 0),
      judgedReviews: books.reduce((sum, b) => sum + b.evidence.judgedVoices, 0) },
    recognition: renown.filter(r => safeUrl(r.sourceUrl)).map(r => ({ id: r.id, entityType: r.entityType, entityId: r.entityId,
      claim: r.claim, sourceUrl: safeUrl(r.sourceUrl), observedAt: r.observedAt })),
    books, series, authors
  };
}
export type QualityReport = ReturnType<typeof buildQualityIndex>;
