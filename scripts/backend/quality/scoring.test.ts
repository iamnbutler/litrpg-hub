import { describe, expect, it } from 'vitest';
import { assessProduction, scoreAuthor, scoreBook, scoreCraft, scoreSeries, seriesTrend } from './scoring.js';
import { craftDimensions, type BookQualityInput, type CraftDimension, type CraftInput, type DimensionEvidence,
  type ProductionInput, type QualityPreferences, type ReleaseEvidence } from './types.js';

const voiceIds = Array.from({ length: 10 }, (_, index) => `review-${index}`);
function dimension(score = 80, confidence = .95, patch: Partial<DimensionEvidence> = {}): DimensionEvidence {
  return { score, confidence, evidenceIds: voiceIds, positiveVoices: score >= 50 ? 10 : 0,
    negativeVoices: score < 50 ? 10 : 0, mixedVoices: 0, judgedVoices: 10, ...patch };
}
function craft(score = 80, confidence = .95, selected: readonly CraftDimension[] = craftDimensions): CraftInput {
  return { dimensions: Object.fromEntries(selected.map(key => [key, dimension(score, confidence)])), relevantVoices: 10 };
}
function book(id = 'book-1', score = 80, patch: Partial<BookQualityInput> = {}, prefs: Partial<QualityPreferences> = {}) {
  return scoreBook({ id, seriesId: 'series', number: Number(id.match(/\d+$/)?.[0] ?? 1), craft: craft(score), ...patch }, prefs);
}
function original(workId: string, date: string, patch: Partial<ReleaseEvidence> = {}): ReleaseEvidence {
  return { workId, date, format: 'ebook', role: 'first-publication', verified: true, evidenceIds: [`source-${workId}`], ...patch };
}
function rapid(patch: Partial<ProductionInput> = {}): ProductionInput {
  return { releases: [original('one', '2025-01-01'), original('two', '2025-03-01'), original('three', '2025-05-01')],
    backlogExcluded: true, backlogEvidenceIds: ['author-confirms-no-batched-backlog'], asOf: '2026-09-19', ...patch };
}

describe('evidence-only craft scoring', () => {
  it('represents no evidence as unknown, distinct from corroborated very poor craftsmanship', () => {
    const unknown = scoreCraft({ dimensions: {}, relevantVoices: 0 }), poor = scoreCraft(craft(0));
    expect(unknown).toMatchObject({ score: null, status: 'unknown', range: [0, 100] });
    expect(poor.score).toBe(0);
    expect(poor.status).toBe('supported');
  });
  it('never treats missing craft dimensions as zero-valued evidence', () => {
    const partial = scoreCraft(craft(80, .95, ['prose', 'editing'])), complete = scoreCraft(craft(80));
    expect(partial.score).toBe(complete.score);
    expect(partial.coverage).toBeLessThan(complete.coverage);
    expect(partial.range[0]).toBeLessThan(complete.range[0]);
    expect(partial.range[1]).toBeGreaterThan(complete.range[1]);
    expect(partial.missingDimensions).toHaveLength(4);
  });
  it('requires at least two dimensions and five relevant independent voices', () => {
    expect(scoreCraft(craft(90, .95, ['prose'])).score).toBeNull();
    const four = dimension(90, .9, { evidenceIds: voiceIds.slice(0, 4), positiveVoices: 4, judgedVoices: 40 });
    // Forty judged reviews do not help when only four actually address craftsmanship.
    expect(scoreCraft({ relevantVoices: 4, dimensions: { prose: four, editing: four } }).score).toBeNull();
    const five = dimension(90, .9, { evidenceIds: voiceIds.slice(0, 5), positiveVoices: 5, judgedVoices: 40 });
    expect(scoreCraft({ relevantVoices: 5, dimensions: { prose: five, editing: five } }).score).toBe(90);
  });
  it('includes uncertain directions in evidence accounting without calling them mixed opinions', () => {
    const uncertain = dimension(61, .7, { positiveVoices: 0, uncertainVoices: 10 });
    const result = scoreCraft({ dimensions: { prose: uncertain, editing: uncertain }, relevantVoices: 10 });
    expect(result.score).toBe(61);
    expect(result.dimensions[0]).toMatchObject({ positiveVoices: 0, negativeVoices: 0, mixedVoices: 0, uncertainVoices: 10 });
    expect(() => scoreCraft({ dimensions: { prose: uncertain }, relevantVoices: 9 })).toThrow(/whole quality sample/);
    expect(() => scoreCraft({ dimensions: { prose: { ...uncertain, uncertainVoices: 9 } }, relevantVoices: 10 })).toThrow(/counts/);
  });
  it('treats an omitted legacy uncertainty count as zero', () => {
    const legacy = dimension(), explicit = { ...legacy, uncertainVoices: 0 };
    expect(scoreCraft({ dimensions: { prose: legacy, editing: legacy }, relevantVoices: 10 }).score)
      .toBe(scoreCraft({ dimensions: { prose: explicit, editing: explicit }, relevantVoices: 10 }).score);
  });
  it('does not turn increasing confidence into a better point score', () => {
    const low = scoreCraft(craft(85, .55)), high = scoreCraft(craft(85, .95));
    expect(low.score).toBe(high.score);
    expect(low.confidence).toBeLessThan(high.confidence);
    expect(high.range[0]).toBeGreaterThan(low.range[0]);
    expect(high.range[1]).toBeLessThan(low.range[1]);
  });
  it('does not weight a dimension by the volume of comments it attracts', () => {
    const input = craft(80); input.dimensions.editing = dimension(20);
    const original = scoreCraft(input), manyIds = Array.from({ length: 1000 }, (_, i) => `voice-${i}`);
    const expanded = scoreCraft({ ...input, relevantVoices: 1000,
      dimensions: { ...input.dimensions, editing: dimension(20, .95, { negativeVoices: 1000, judgedVoices: 1000, evidenceIds: manyIds }) } });
    expect(expanded.score).toBe(original.score);
    expect(original.score).toBe(71);
  });
  it('ignores star ratings and rating counts even if an adapter supplies extra fields', () => {
    const plain = { id: 'one', seriesId: 'series', number: 1, craft: craft(60) };
    const rated = { ...plain, rating: 5, ratingCount: 9_999_999, ratings: [5, 5, 5], stars: 5,
      craft: { ...plain.craft, averageRating: 5, ratingCount: 9_999_999 } };
    expect(scoreBook(rated)).toEqual(scoreBook(plain));
    rated.rating = 1; rated.ratingCount = 0; rated.craft.averageRating = 1;
    expect(scoreBook(rated)).toEqual(scoreBook(plain));
  });
  it('does not accept duplicated evidence identifiers as independent voices', () => {
    const fraudulent = dimension(90, .95, { evidenceIds: Array(10).fill('same-reader') });
    expect(() => scoreCraft({ dimensions: { prose: fraudulent, editing: fraudulent }, relevantVoices: 10 })).toThrow(/counts/);
  });
  it('does not let weak excluded dimensions supply the missing independent voices', () => {
    const strong = dimension(90, .9, { evidenceIds: voiceIds.slice(0, 3), positiveVoices: 3, judgedVoices: 10 });
    const weak = dimension(90, .2, { evidenceIds: voiceIds.slice(3), positiveVoices: 7, judgedVoices: 10 });
    const result = scoreCraft({ relevantVoices: 10, dimensions: { prose: strong, editing: strong, coherence: weak } });
    expect(result.dimensions).toHaveLength(2);
    expect(result.score).toBeNull();
  });
  it('rejects padding the evidence list with irrelevant reviews or understating the whole sample', () => {
    const padded = dimension(90, .9, { positiveVoices: 3 });
    expect(() => scoreCraft({ relevantVoices: 10, dimensions: { prose: padded } })).toThrow(/counts/);
    expect(() => scoreCraft({ relevantVoices: 1, dimensions: { prose: dimension() } })).toThrow(/whole quality sample/);
  });
  it('rejects impossible counts, nonfinite scores and invalid confidence rather than silently clamping', () => {
    for (const patch of [{ score: NaN }, { score: 101 }, { confidence: 1.1 }, { positiveVoices: -1 },
      { uncertainVoices: -1 }, { uncertainVoices: 0.5 }, { judgedVoices: 2 }]) {
      expect(() => scoreCraft({ dimensions: { prose: dimension(80, .95, patch) }, relevantVoices: 10 })).toThrow();
    }
  });
  it('omits an isolated aspect claim instead of letting one review establish it', () => {
    const input = craft(80); input.dimensions.prose = dimension(0, .95, { positiveVoices: 0, negativeVoices: 1, evidenceIds: ['one'], judgedVoices: 10 });
    const scored = scoreCraft(input);
    expect(scored.score).toBe(80);
    expect(scored.missingDimensions).toContain('prose');
  });
});

describe('separate craftsmanship and personalized ranking', () => {
  const explicit = { verdict: 'present' as const, confidence: 1, evidenceIds: ['publisher-disclosure'] };
  it('keeps erotica orthogonal to craft and caps overlapping content penalties', () => {
    const plain = book(), erotic = book('book-1', 80, { content: { explicit, harem: explicit, sexualized: explicit } });
    expect(erotic.craft).toEqual(plain.craft);
    expect(erotic.index.score).toBe(70);
    expect(erotic.index.adjustments).toHaveLength(1);
    expect(erotic.index.adjustments[0]).toMatchObject({ kind: 'content-fit', points: -10 });
  });
  it('can disable all content preferences without changing any evidence', () => {
    const erotic = book('book-1', 80, { content: { explicit, harem: explicit, sexualized: explicit } },
      { avoidExplicit: false, avoidHarem: false, avoidSexualizedMarketing: false });
    expect(erotic.index.score).toBe(80);
    expect(erotic.index.adjustments).toEqual([]);
  });
  it('does not penalize unknown, unsupported or weak content observations', () => {
    for (const signal of [{ ...explicit, verdict: 'unknown' as const }, { ...explicit, confidence: .5 }, { ...explicit, evidenceIds: [] }]) {
      expect(book('book-1', 80, { content: { explicit: signal } }).index.score).toBe(80);
    }
  });
  it('caps renown at five points and never uses it to invent missing craft', () => {
    const renown = { score: 100, confidence: 1, evidenceIds: ['independent-award'], basis: 'independent-recognition' as const };
    const known = book('book-1', 80, { renown });
    expect(known.craft.score).toBe(80); expect(known.index.score).toBe(85);
    expect(book('book-1', 80, { craft: { dimensions: {}, relevantVoices: 0 }, renown }).index.score).toBeNull();
    expect(book('book-1', 80, { renown }, { useRenown: false }).index.score).toBe(80);
  });
  it('does not reward unsupported name recognition', () => {
    const renown = { score: 100, confidence: 1, evidenceIds: [], basis: 'editorial-reference' as const };
    expect(book('book-1', 80, { renown }).index.score).toBe(80);
  });
  it('bounds personalized scores within the reported 0–100 scale', () => {
    const renown = { score: 100, confidence: 1, evidenceIds: ['award'], basis: 'independent-recognition' as const };
    expect(book('book-1', 99, { renown }).index.score).toBe(100);
    expect(book('book-1', 2, { content: { explicit } }).index.score).toBe(0);
  });
});

describe('production chronology cannot launder audio releases into writing speed', () => {
  it('ignores a rapid audio back catalogue even if mislabeled first publication', () => {
    const input = rapid(); input.releases = input.releases.map(row => ({ ...row, format: 'audiobook' }));
    const assessment = assessProduction(input);
    expect(assessment).toMatchObject({ status: 'unknown', originalWorks: 0, eligibleForRiskAdjustment: false });
    expect(book('book-1', 20, { production: input }).index.score).toBe(20);
  });
  it('does not treat print or ebook edition dates as first publication', () => {
    const input = rapid(); input.releases = input.releases.map(row => ({ ...row, role: 'edition-release', format: 'print' }));
    expect(assessProduction(input).originalWorks).toBe(0);
  });
  it('deduplicates multiple editions of a work before measuring intervals', () => {
    const first = original('one', '2025-01-01');
    const assessment = assessProduction(rapid({ releases: [first, { ...first, format: 'print' }, { ...first }, original('two', '2026-01-01')] }));
    expect(assessment.originalWorks).toBe(2);
    expect(assessment.intervalsDays).toEqual([365]);
    expect(assessment.status).toBe('insufficient');
  });
  it('withholds conflicting, invalid, future, unsupported and unverified dates', () => {
    const releases = [original('conflict', '2025-01-01'), original('conflict', '2025-03-01'),
      original('invalid', '2025-02-30'), original('future', '2030-01-01'), original('no-proof', '2025-01-01', { evidenceIds: [] }),
      original('unchecked', '2025-01-01', { verified: false }), original('real', '2025-06-01')];
    const assessment = assessProduction(rapid({ releases }));
    expect(assessment.originalWorks).toBe(1);
    expect(assessment.evidenceIds).not.toContain('source-conflict');
  });
  it('requires multiple short intervals, not just a short interval selected from a long history', () => {
    const assessment = assessProduction(rapid({ releases: [original('one', '2022-01-01'), original('two', '2024-01-01'), original('three', '2024-02-01')] }));
    expect(assessment.shortIntervals).toBe(1);
    expect(assessment.status).toBe('ordinary');
  });
  it('does not infer effort or quality from rapid releases without corroborating craft problems', () => {
    const assessment = assessProduction(rapid());
    expect(assessment.status).toBe('rapid');
    const good = book('book-1', 90, { production: rapid() });
    expect(good.index.score).toBe(90);
    expect(good.index.adjustments).toEqual([]);
    expect(good.craft.score).toBe(90);
  });
  it('requires evidence that batching is excluded, not an unchecked boolean', () => {
    const noEvidence = rapid({ backlogEvidenceIds: [] }), notExcluded = rapid({ backlogExcluded: false });
    for (const input of [noEvidence, notExcluded]) {
      expect(assessProduction(input).status).toBe('rapid');
      expect(assessProduction(input).eligibleForRiskAdjustment).toBe(false);
      expect(book('book-1', 20, { production: input }).index.score).toBe(20);
    }
  });
  it('applies only a capped personalized risk adjustment when cadence and craft problems are both evidenced', () => {
    const poor = book('book-1', 20, { production: rapid() });
    expect(poor.craft.score).toBe(20);
    expect(poor.index.score).toBeLessThan(20);
    expect(poor.index.score).toBeGreaterThanOrEqual(15);
    expect(poor.index.adjustments[0].evidenceIds).toContain('author-confirms-no-batched-backlog');
    expect(poor.index.adjustments[0].evidenceIds).toContain('review-0');
  });
  it('does not use pacing alone to justify a production-risk penalty', () => {
    const input = craft(80); input.dimensions.pacing = dimension(0);
    const slow = book('book-1', 80, { craft: input, production: rapid() });
    expect(slow.index.score).toBe(slow.craft.score);
    expect(slow.craftConcerns).toEqual([]);
  });
});

describe('book, series and author boundaries', () => {
  it('does not call one reviewed starter book a representative full-series assessment', () => {
    const result = scoreSeries({ id: 'series', books: [book()], knownWorkCount: 10 });
    expect(result.craft.score).toBe(80);
    expect(result.coverage).toMatchObject({ assessed: 1, known: 10, share: .1, catalogComplete: false, scope: 'assessed-books' });
    expect(result.craft.confidence).toBeLessThanOrEqual(.1);
    expect(result.craft.range[0]).toBeLessThan(10);
    expect(result.craft.range[1]).toBeGreaterThan(90);
    expect(result.craft.status).toBe('provisional');
  });
  it('gives each series one author-level vote, even if one has a hundred books', () => {
    const prolific = scoreSeries({ id: 'series', books: Array.from({ length: 100 }, (_, i) => book(`book-${i}`, 60)) });
    const short = scoreSeries({ id: 'other', books: [book('other-1', 90, { seriesId: 'other' })] });
    expect(scoreAuthor({ id: 'author', series: [prolific, short] }).craft.score).toBe(75);
    expect(scoreAuthor({ id: 'author', series: [short, prolific] }).craft.score).toBe(75);
  });
  it('deduplicates exact member identities and refuses conflicting or foreign ones', () => {
    const first = book(), other = book('book-2', 20);
    expect(scoreSeries({ id: 'series', books: [first, first, other] }).craft.score).toBe(50);
    expect(() => scoreSeries({ id: 'series', books: [first, { ...first, number: 2 }] })).toThrow(/Conflicting/);
    expect(() => scoreSeries({ id: 'wrong', books: [first] })).toThrow(/another series/);
  });
  it('never folds unknown children in as poor scores or turns catalog incompleteness into bad craft', () => {
    const known = book(), unknown = book('book-2', 80, { craft: { dimensions: {}, relevantVoices: 0 } });
    const withUnknown = scoreSeries({ id: 'series', books: [known, unknown] });
    expect(withUnknown.craft.score).toBe(80);
    expect(withUnknown.coverage.assessed).toBe(1);
    expect(withUnknown.craft.confidence).toBeLessThan(known.craft.confidence);
    expect(scoreAuthor({ id: 'author', series: [] }).craft.score).toBeNull();
  });
  it('carries personalized child adjustments as an equal average rather than a blanket author or series label', () => {
    const explicit = { verdict: 'present' as const, confidence: 1, evidenceIds: ['disclosure'] };
    const one = book('book-1', 80, { content: { explicit } }), two = book('book-2', 80);
    const series = scoreSeries({ id: 'series', books: [one, two] });
    expect(series.craft.score).toBe(80); expect(series.index.score).toBe(75);
    expect(series.index.adjustments).toHaveLength(1);
    expect(series.index.adjustments[0]).toMatchObject({ kind: 'content-fit', points: -5, evidenceIds: ['disclosure'] });
    const neutral = scoreSeries({ id: 'other', books: [book('other-1', 80, { seriesId: 'other' })] });
    const author = scoreAuthor({ id: 'author', series: [series, neutral] });
    expect(author.craft.score).toBe(80); expect(author.index.score).toBe(77.5);
    expect(one.craft.score).toBe(80);
  });
  it('replaces rather than double-counts an adjustment directly evidenced at the parent', () => {
    const explicit = { verdict: 'present' as const, confidence: 1, evidenceIds: ['disclosure'] };
    const one = book('book-1', 80, { content: { explicit } });
    const series = scoreSeries({ id: 'series', books: [one], content: { explicit } });
    expect(series.index.score).toBe(70);
    expect(series.index.adjustments.filter(item => item.kind === 'content-fit')).toHaveLength(1);
  });
  it('requires consistent preference profiles before reusing child ranking adjustments', () => {
    expect(() => scoreSeries({ id: 'series', books: [book()] }, { avoidExplicit: false })).toThrow(/same quality preferences/);
    const child = book('book-1', 80, {}, { avoidExplicit: false });
    expect(scoreSeries({ id: 'series', books: [child] }, { avoidExplicit: false }).index.score).toBe(80);
  });
  it('makes output deterministic under member order and does not mutate the inputs', () => {
    const a = book(), b = book('book-2', 20), before = JSON.stringify([a, b]);
    expect(scoreSeries({ id: 'series', books: [a, b] })).toEqual(scoreSeries({ id: 'series', books: [b, a] }));
    expect(JSON.stringify([a, b])).toBe(before);
  });
});

describe('evidenced series trajectory', () => {
  it('detects a later decline while keeping the full sampled score separate', () => {
    const books = [book('book-4', 55), book('book-2', 88), book('book-1', 92), book('book-3', 65)];
    const result = scoreSeries({ id: 'series', books });
    expect(result.craft.score).toBe(75);
    expect(result.trend).toMatchObject({ status: 'declining', early: 90, late: 60, change: -30,
      earlyWorkIds: ['book-1', 'book-2'], lateWorkIds: ['book-3', 'book-4'] });
  });
  it('does not invent a trajectory from one book, duplicate volume numbers, or unnumbered books', () => {
    expect(seriesTrend([book()]).status).toBe('insufficient');
    expect(seriesTrend([book(), book('book-2', 80, { number: 1 }), book('book-3'), book('book-4')]).status).toBe('insufficient');
    expect(seriesTrend([book(), book('book-2'), book('book-3'), book('book-4', 20, { number: null })]).status).toBe('insufficient');
  });
  it('does not compare early prose praise with unrelated later editing criticism', () => {
    const early = ['book-1', 'book-2'].map(id => book(id, 90, { craft: craft(90, .95, ['prose', 'coherence']) }));
    const late = ['book-3', 'book-4'].map(id => book(id, 30, { craft: craft(30, .95, ['editing', 'repetition']) }));
    expect(seriesTrend([...early, ...late]).status).toBe('insufficient');
  });
  it('withholds a confident decline when the early/late sensitivity ranges overlap', () => {
    const books = [book('book-1', 80, { craft: craft(80, .5) }), book('book-2', 80, { craft: craft(80, .5) }),
      book('book-3', 60, { craft: craft(60, .5) }), book('book-4', 60, { craft: craft(60, .5) })];
    const result = seriesTrend(books);
    expect(result.change).toBe(-20);
    expect(result.status).toBe('similar');
    expect(result.explanation).toContain('no clearly separated change');
  });
});
