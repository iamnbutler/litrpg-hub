import { craftDimensions, type AggregationCoverage, type AuthorQualityInput, type AuthorQualityScore,
  type BookQualityInput, type BookQualityScore, type CraftConcern, type CraftDimension, type CraftInput,
  type CraftScore, type DimensionEvidence, type DimensionScore, type IndexAdjustment, type ProductionAssessment,
  type ProductionInput, type QualityIndex, type QualityModifiers, type QualityPreferences, type ScoreEstimate,
  type SeriesQualityInput, type SeriesQualityScore, type SeriesTrend } from './types.js';

export const QUALITY_SCORING_VERSION = 'quality-scoring-v1';
export const craftWeights: Readonly<Record<CraftDimension, number>> = Object.freeze({
  prose: .20, editing: .15, coherence: .20, structure: .15, pacing: .15, repetition: .15
});
export const qualityThresholds = Object.freeze({ relevantVoices: 5, dimensionVoices: 3, dimensions: 2,
  dimensionConfidence: .5, contentConfidence: .8, renownConfidence: .7, rapidDays: 75,
  shortIntervals: 2, trendBooks: 4, trendChange: 10 });
export const defaultQualityPreferences: Readonly<QualityPreferences> = Object.freeze({
  avoidExplicit: true, avoidHarem: true, avoidSexualizedMarketing: true,
  useRenown: true, useCorroboratedProductionRisk: true
});
const DAY = 86_400_000;
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp = (n: number) => Math.max(0, Math.min(100, n));
const unique = (values: readonly string[]) => [...new Set(values.filter(value => typeof value === 'string' && value.trim()))].sort();
const mean = (values: readonly number[]) => values.reduce((sum, n) => sum + n, 0) / values.length;
function finite(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid quality ${name}.`);
  return value;
}
function count(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid quality ${name}.`);
  return value;
}
function date(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : null;
}
function evidence(raw: DimensionEvidence, dimension: CraftDimension): DimensionScore | null {
  finite(raw.score, 0, 100, `${dimension} score`); finite(raw.confidence, 0, 1, `${dimension} confidence`);
  const positive = count(raw.positiveVoices, `${dimension} positive voices`), negative = count(raw.negativeVoices, `${dimension} negative voices`);
  const mixed = count(raw.mixedVoices, `${dimension} mixed voices`), judged = count(raw.judgedVoices, `${dimension} judged voices`);
  const uncertain = count(raw.uncertainVoices ?? 0, `${dimension} uncertain voices`);
  const relevant = positive + negative + mixed + uncertain, evidenceIds = unique(raw.evidenceIds);
  if (relevant > judged || relevant !== evidenceIds.length) throw new Error(`Inconsistent quality ${dimension} evidence counts.`);
  if (relevant < qualityThresholds.dimensionVoices || raw.confidence < qualityThresholds.dimensionConfidence) return null;
  return { ...raw, evidenceIds, dimension, weight: craftWeights[dimension] };
}
const dimRange = (item: DimensionEvidence): [number, number] => [clamp(item.score - 50 * (1 - item.confidence)), clamp(item.score + 50 * (1 - item.confidence))];

/** Confidence changes uncertainty, never the point score. Missing dimensions are unknown, not failures. */
export function scoreCraft(input: CraftInput): CraftScore {
  const relevantVoices = count(input.relevantVoices, 'relevant voices');
  const dimensions = craftDimensions.flatMap(dimension => {
    const raw = input.dimensions[dimension], accepted = raw ? evidence(raw, dimension) : null;
    return accepted ? [accepted] : [];
  });
  const allEvidence = unique(Object.values(input.dimensions).flatMap(item => item?.evidenceIds ?? []));
  if (relevantVoices > allEvidence.length) throw new Error('Relevant voice count exceeds retained quality evidence.');
  if (Object.values(input.dimensions).some(item => item && item.positiveVoices + item.negativeVoices + item.mixedVoices + (item.uncertainVoices ?? 0) > relevantVoices))
    throw new Error('A dimension cannot have more relevant voices than the whole quality sample.');
  const missingDimensions = craftDimensions.filter(dimension => !dimensions.some(item => item.dimension === dimension));
  const coverage = dimensions.reduce((sum, item) => sum + item.weight, 0);
  const acceptedVoices = unique(dimensions.flatMap(item => item.evidenceIds)).length;
  const eligible = dimensions.length >= qualityThresholds.dimensions && relevantVoices >= qualityThresholds.relevantVoices
    && acceptedVoices >= qualityThresholds.relevantVoices;
  const score = eligible ? round(dimensions.reduce((sum, item) => sum + item.score * item.weight, 0) / coverage) : null;
  const confidence = eligible ? round(dimensions.reduce((sum, item) => sum + item.confidence * item.weight, 0)) : 0;
  const bounds = dimensions.reduce(([low, high], item) => {
    const [l, h] = dimRange(item); return [low + l * item.weight, high + h * item.weight];
  }, [0, 100 * (1 - coverage)]);
  return { score, confidence, coverage: round(coverage), range: eligible ? [round(bounds[0]), round(bounds[1])] : [0, 100],
    status: !dimensions.length ? 'unknown' : !eligible ? 'insufficient' : confidence >= .65 && coverage >= .65 && relevantVoices >= 10 ? 'supported' : 'provisional',
    dimensions, relevantVoices, missingDimensions,
    reasons: [!eligible ? `An overall score needs at least ${qualityThresholds.dimensions} assessed dimensions and ${qualityThresholds.relevantVoices} independent relevant voices.`
      : 'The score describes evidenced craftsmanship in this review sample, not the share of readers who liked the book.',
    ...(missingDimensions.length ? [`${missingDimensions.length} craft dimensions remain unknown; missing evidence is not a low score.`] : []),
    'Sensitivity bounds show missing dimensions and judgement uncertainty; they are not statistical confidence intervals.'] };
}

/** Publication cadence describes releases. It cannot establish drafting speed, effort, or AI authorship. */
export function assessProduction(input?: ProductionInput): ProductionAssessment {
  const empty: ProductionAssessment = { status: 'unknown', originalWorks: 0, intervalsDays: [], medianDays: null, shortIntervals: 0,
    backlogExcluded: false, eligibleForRiskAdjustment: false, evidenceIds: [], reasons: [] };
  if (!input) return { ...empty, reasons: ['Verified first-publication chronology is unavailable.'] };
  const asOf = date(input.asOf);
  if (asOf === null) throw new Error('Production asOf must be an exact calendar date.');
  const groups = new Map<string, { at: number; evidenceIds: string[] }[]>();
  for (const release of input.releases) {
    const at = date(release.date), evidenceIds = unique(release.evidenceIds);
    if (!release.workId || !release.verified || release.role !== 'first-publication' || !evidenceIds.length || at === null || at > asOf
      || !['ebook', 'print', 'web-serial'].includes(release.format)) continue;
    groups.set(release.workId, [...groups.get(release.workId) ?? [], { at, evidenceIds }]);
  }
  const coherent = [...groups.values()].filter(rows => new Set(rows.map(row => row.at)).size === 1);
  const dates = coherent.map(rows => rows[0].at).sort((a, b) => a - b);
  const intervalsDays = dates.slice(1).map((at, i) => (at - dates[i]) / DAY);
  const sorted = [...intervalsDays].sort((a, b) => a - b);
  const medianDays = !sorted.length ? null : sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : mean(sorted.slice(sorted.length / 2 - 1, sorted.length / 2 + 1));
  const shortIntervals = intervalsDays.filter(days => days <= qualityThresholds.rapidDays).length;
  const rapid = shortIntervals >= qualityThresholds.shortIntervals && medianDays !== null && medianDays <= qualityThresholds.rapidDays;
  const backlogExcluded = input.backlogExcluded && unique(input.backlogEvidenceIds ?? []).length > 0;
  return { status: dates.length < 3 ? dates.length ? 'insufficient' : 'unknown' : rapid ? 'rapid' : 'ordinary',
    originalWorks: dates.length, intervalsDays, medianDays, shortIntervals, backlogExcluded,
    eligibleForRiskAdjustment: rapid && backlogExcluded,
    evidenceIds: unique([...coherent.flatMap(rows => rows.flatMap(row => row.evidenceIds)), ...(backlogExcluded ? input.backlogEvidenceIds ?? [] : [])]),
    reasons: ['Only source-verified first publication of distinct works is counted; audiobook, dramatized and ordinary edition dates are excluded.',
      ...(groups.size !== coherent.length ? ['Conflicting first-publication dates were excluded until reviewed.'] : []),
      ...(!backlogExcluded ? ['Back-catalogue, serial, translation or reissue batching has not been ruled out; no production adjustment is eligible.'] : []),
      'Rapid publication alone does not lower craftsmanship or establish AI authorship. A ranking adjustment additionally requires corroborated craft problems.'] };
}
function concerns(dimensions: readonly DimensionScore[]): CraftConcern[] {
  return dimensions.filter(item => ['editing', 'coherence', 'structure', 'repetition'].includes(item.dimension)
    && item.score <= 40 && item.confidence >= .7 && item.negativeVoices >= 3)
    .map(({ dimension, score, confidence, evidenceIds }) => ({ dimension, score, confidence, evidenceIds: unique(evidenceIds) }));
}
function mergeConcerns(values: readonly CraftConcern[][]): CraftConcern[] {
  return values.flat().sort((a, b) => a.dimension.localeCompare(b.dimension) || a.score - b.score || a.evidenceIds.join().localeCompare(b.evidenceIds.join()));
}
function ranking(craft: ScoreEstimate, modifiers: QualityModifiers, production: ProductionAssessment,
  craftConcerns: readonly CraftConcern[], preferences: Partial<QualityPreferences> = {}, inherited: IndexAdjustment[] = []): QualityIndex {
  const prefs = { ...defaultQualityPreferences, ...preferences };
  // A directly evidenced modifier replaces the same sampled modifier. It is never added twice.
  const adjustments: IndexAdjustment[] = inherited.filter(item => item.kind === 'content-fit' ? !modifiers.content
    : item.kind === 'renown' ? !modifiers.renown : !modifiers.production);
  if (craft.score === null) return { score: null, baseCraft: null, adjustments, preferences: prefs };
  const options = [
    ['explicit', prefs.avoidExplicit, 10], ['harem', prefs.avoidHarem, 10], ['sexualized', prefs.avoidSexualizedMarketing, 6]
  ] as const;
  const hits = options.flatMap(([field, enabled, maximum]) => {
    const signal = modifiers.content?.[field];
    if (!signal) return [];
    finite(signal.confidence, 0, 1, `${field} confidence`);
    return enabled && signal.verdict === 'present' && signal.confidence >= qualityThresholds.contentConfidence && unique(signal.evidenceIds).length
      ? [{ field, points: maximum * signal.confidence, evidenceIds: unique(signal.evidenceIds) }] : [];
  });
  if (hits.length) adjustments.push({ kind: 'content-fit', points: -round(Math.max(...hits.map(hit => hit.points))),
    evidenceIds: unique(hits.flatMap(hit => hit.evidenceIds)),
    explanation: `Preference fit for ${hits.map(hit => hit.field).join(', ')}; the overlapping penalties are capped at 10 and do not change craftsmanship.` });
  if (prefs.useRenown && modifiers.renown) {
    const renown = modifiers.renown;
    finite(renown.score, 0, 100, 'renown score'); finite(renown.confidence, 0, 1, 'renown confidence');
    if (renown.confidence >= qualityThresholds.renownConfidence && unique(renown.evidenceIds).length && renown.score > 0) adjustments.push({
      kind: 'renown', points: round(5 * renown.score / 100 * renown.confidence), evidenceIds: unique(renown.evidenceIds),
      explanation: 'A source-backed renown adjustment of at most 5 points; reputation is not craftsmanship evidence.' });
  }
  if (prefs.useCorroboratedProductionRisk && production.eligibleForRiskAdjustment && craftConcerns.length) {
    const worst = [...craftConcerns].sort((a, b) => a.score - b.score)[0];
    adjustments.push({ kind: 'production-risk', points: -round(Math.min(5, (50 - worst.score) / 10) * worst.confidence),
      evidenceIds: unique([...production.evidenceIds, ...worst.evidenceIds]),
      explanation: 'Verified rapid original releases with batching ruled out accompany independently evidenced craft problems. This capped ranking signal does not claim drafting speed or AI authorship.' });
  }
  return { score: round(clamp(craft.score + adjustments.reduce((sum, adjustment) => sum + adjustment.points, 0))),
    baseCraft: craft.score, adjustments, preferences: prefs };
}
function sampledAdjustments(children: readonly { index: QualityIndex }[], preferences: Partial<QualityPreferences>, label: string): IndexAdjustment[] {
  const prefs = { ...defaultQualityPreferences, ...preferences }, scored = children.filter(child => child.index.baseCraft !== null);
  if (!scored.length) return [];
  for (const child of scored) if ((Object.keys(prefs) as (keyof QualityPreferences)[]).some(key => prefs[key] !== child.index.preferences[key]))
    throw new Error('Rescore children with the same quality preferences before aggregation.');
  return (['content-fit', 'renown', 'production-risk'] as const).flatMap(kind => {
    const source = scored.flatMap(child => child.index.adjustments.filter(adjustment => adjustment.kind === kind));
    if (!source.length) return [];
    return [{ kind, points: round(source.reduce((sum, item) => sum + item.points, 0) / scored.length),
      evidenceIds: unique(source.flatMap(item => item.evidenceIds)),
      explanation: `Equal-weight average of this adjustment across ${scored.length} scored ${label}, including zero for unaffected children. It is a sampled ranking adjustment, not a blanket content or quality claim.` }];
  });
}

export function scoreBook(input: BookQualityInput, preferences: Partial<QualityPreferences> = {}): BookQualityScore {
  if (!input.id || !input.seriesId || input.number !== null && (!Number.isFinite(input.number) || input.number < 0)) throw new Error('Invalid quality book identity.');
  const craft = scoreCraft(input.craft), production = assessProduction(input.production), craftConcerns = concerns(craft.dimensions);
  return { id: input.id, seriesId: input.seriesId, number: input.number, version: QUALITY_SCORING_VERSION, craft, production, craftConcerns,
    index: ranking(craft, input, production, craftConcerns, preferences) };
}
function deduplicate<T extends { id: string }>(values: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    if (!value.id) throw new Error('Missing quality aggregation identity.');
    const previous = byId.get(value.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error(`Conflicting quality aggregate identity: ${value.id}.`);
    byId.set(value.id, value);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function aggregate(estimates: readonly ScoreEstimate[], known: number, complete: boolean): ScoreEstimate {
  const assessed = estimates.filter(item => item.score !== null);
  if (!assessed.length) return { score: null, confidence: 0, coverage: 0, range: [0, 100], status: 'unknown' };
  // Each child gets one vote. Evidence quantity changes coverage/certainty, never its vote's weight.
  const score = round(mean(assessed.map(item => item.score!)));
  const confidence = round(estimates.reduce((sum, item) => sum + item.confidence, 0) / known);
  const coverage = round(estimates.reduce((sum, item) => sum + item.coverage, 0) / known);
  const range: [number, number] = [round(estimates.reduce((sum, item) => sum + item.range[0], 0) / known),
    round((estimates.reduce((sum, item) => sum + item.range[1], 0) + (known - estimates.length) * 100) / known)];
  return { score, confidence, coverage, range,
    status: complete && confidence >= .65 && coverage >= .65 && assessed.every(item => item.status === 'supported') ? 'supported' : 'provisional' };
}
function aggregationCoverage(assessed: number, actual: number, expected: number | undefined, catalogComplete: boolean | undefined,
  scope: AggregationCoverage['scope']): AggregationCoverage {
  const known = expected ?? actual;
  count(known, 'known members');
  if (known < actual) throw new Error('Quality aggregate known count is smaller than its distinct members.');
  return { assessed, known, share: known ? round(assessed / known) : 0, catalogComplete: catalogComplete ?? false, scope };
}
/** Comparisons use the SAME dimensions on early/late books, avoiding a changing-rubric illusion. */
export function seriesTrend(books: readonly BookQualityScore[]): SeriesTrend {
  const blank: SeriesTrend = { status: 'insufficient', early: null, late: null, change: null, earlyWorkIds: [], lateWorkIds: [],
    explanation: 'A trajectory needs at least four independently assessed, numbered works and two comparable craft dimensions.' };
  const ordered = books.filter(book => book.number !== null && book.craft.score !== null)
    .sort((a, b) => a.number! - b.number! || a.id.localeCompare(b.id));
  if (ordered.length < qualityThresholds.trendBooks || new Set(ordered.map(book => book.number)).size !== ordered.length) return blank;
  const early = ordered.slice(0, 2), late = ordered.slice(-2), selected = [...early, ...late];
  const shared = craftDimensions.filter(dimension => selected.every(book => book.craft.dimensions.some(item => item.dimension === dimension)));
  if (shared.length < 2) return blank;
  const weight = shared.reduce((sum, dimension) => sum + craftWeights[dimension], 0);
  const values = (rows: BookQualityScore[]) => rows.map(book => {
    const dims = book.craft.dimensions.filter(item => shared.includes(item.dimension));
    return { score: dims.reduce((sum, item) => sum + item.score * item.weight, 0) / weight,
      low: dims.reduce((sum, item) => sum + dimRange(item)[0] * item.weight, 0) / weight,
      high: dims.reduce((sum, item) => sum + dimRange(item)[1] * item.weight, 0) / weight };
  });
  const ev = values(early), lv = values(late), e = mean(ev.map(v => v.score)), l = mean(lv.map(v => v.score)), change = l - e;
  const declining = change <= -qualityThresholds.trendChange && mean(lv.map(v => v.high)) < mean(ev.map(v => v.low));
  const improving = change >= qualityThresholds.trendChange && mean(lv.map(v => v.low)) > mean(ev.map(v => v.high));
  return { status: declining ? 'declining' : improving ? 'improving' : 'similar', early: round(e), late: round(l), change: round(change),
    earlyWorkIds: early.map(book => book.id), lateWorkIds: late.map(book => book.id),
    explanation: `First two versus last two assessed numbered works, using the same ${shared.length} dimensions. This describes sampled volumes; unassessed intervening or later volumes remain unknown. ${!declining && !improving ? 'There is no clearly separated change under the uncertainty bounds.' : 'The sensitivity bounds are separated; this is an editorial signal, not a statistical significance claim.'}` };
}
export function scoreSeries(input: SeriesQualityInput, preferences: Partial<QualityPreferences> = {}): SeriesQualityScore {
  const books = deduplicate(input.books);
  if (books.some(book => book.seriesId !== input.id)) throw new Error('A quality series cannot contain another series\' books.');
  const coverage = aggregationCoverage(books.filter(book => book.craft.score !== null).length, books.length, input.knownWorkCount, input.catalogComplete, 'assessed-books');
  const craft = aggregate(books.map(book => book.craft), coverage.known, coverage.catalogComplete), production = assessProduction(input.production);
  const craftConcerns = mergeConcerns(books.map(book => book.craftConcerns));
  return { id: input.id, version: QUALITY_SCORING_VERSION, craft, coverage, production, craftConcerns,
    index: ranking(craft, input, production, craftConcerns, preferences, sampledAdjustments(books, preferences, 'books')), trend: seriesTrend(books), bookIds: books.map(book => book.id),
    reasons: [`Equal weights across ${coverage.assessed} assessed books from ${coverage.known} known works; this is a sample score, not a claim about unread volumes.`,
      ...(coverage.catalogComplete ? [] : ['The full series bibliography has not been established as complete.'])] };
}
export function scoreAuthor(input: AuthorQualityInput, preferences: Partial<QualityPreferences> = {}): AuthorQualityScore {
  const series = deduplicate(input.series);
  const coverage = aggregationCoverage(series.filter(row => row.craft.score !== null).length, series.length, input.knownSeriesCount, input.catalogComplete, 'assessed-series');
  const craft = aggregate(series.map(row => row.craft), coverage.known, coverage.catalogComplete), production = assessProduction(input.production);
  const craftConcerns = mergeConcerns(series.map(row => row.craftConcerns));
  return { id: input.id, version: QUALITY_SCORING_VERSION, craft, coverage, production, craftConcerns,
    index: ranking(craft, input, production, craftConcerns, preferences, sampledAdjustments(series, preferences, 'series')), seriesIds: series.map(row => row.id),
    reasons: [`Equal weights across ${coverage.assessed} assessed series from ${coverage.known} known series; prolific series get no extra author-level vote.`,
      'Author aggregates are never fed back into book or series craft scores.',
      ...(coverage.catalogComplete ? [] : ['The full author bibliography has not been established as complete.'])] };
}
