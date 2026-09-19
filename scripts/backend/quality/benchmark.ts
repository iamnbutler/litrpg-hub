import { readFileSync } from 'node:fs';
import { scoreAuthor, scoreBook, scoreSeries } from './scoring.js';
import type { QualityReport } from './pipeline.js';
import type { AuthorQualityInput, BookQualityInput, CraftDimension, CraftInput, QualityPreferences, SeriesQualityInput } from './types.js';

interface Profile { scores: Partial<Record<CraftDimension, number>>; confidence: number; voices: number }
type FixtureBook = Omit<BookQualityInput, 'craft'> & { craftProfile: string };
type FixtureSeries = Omit<SeriesQualityInput, 'books'> & { books: FixtureBook[] };
type FixtureAuthor = Omit<AuthorQualityInput, 'series'> & { series: FixtureSeries[] };
interface Expected {
  craftMin?: number; craftMax?: number; craftScore?: number | null; indexScore?: number | null;
  indexLessThanCraft?: boolean; noAdjustmentKind?: string; sameCraftAs?: string; sameIndexAs?: string; trend?: string;
}
interface Registry {
  version: number;
  anchors: { id: string; entityType: 'book' | 'series' | 'author'; entityId: string; title: string;
    target: { min: number; max: number; basis: string }; trendHypothesis?: { direction: string; basis: string } }[];
  syntheticCraftProfiles: Record<string, Profile>;
  syntheticControls: { id: string; synthetic: true; kind: 'book' | 'series' | 'author';
    input: FixtureBook | FixtureSeries | FixtureAuthor; preferences: Partial<QualityPreferences>; expected: Expected }[];
  openGaps: unknown[];
}
export const qualityBenchmarks = JSON.parse(readFileSync(new URL('./benchmarks.json', import.meta.url), 'utf8')) as Registry;

/** Synthetic profiles are built here, never in the database or production scoring path. */
function fixtureCraft(book: FixtureBook, registry: Registry): CraftInput {
  const p = registry.syntheticCraftProfiles[book.craftProfile];
  if (!p || !Number.isSafeInteger(p.voices) || p.voices < 0) throw new Error('Invalid synthetic benchmark profile.');
  const evidenceIds = Array.from({ length: p.voices }, (_, i) => `synthetic:${book.id}:voice-${i + 1}`);
  return { relevantVoices: p.voices, dimensions: Object.fromEntries(Object.entries(p.scores).map(([dimension, score]) => [dimension, {
    score, confidence: p.confidence, evidenceIds,
    positiveVoices: score >= 60 ? p.voices : 0, negativeVoices: score < 40 ? p.voices : 0,
    mixedVoices: score >= 40 && score < 60 ? p.voices : 0, judgedVoices: p.voices
  }])) };
}

export function runSyntheticBenchmarks(registry: Registry = qualityBenchmarks) {
  const results = registry.syntheticControls.map(fixture => {
    if (!fixture.synthetic || !fixture.input.id.startsWith('synthetic:')) throw new Error('Real evidence is forbidden in synthetic benchmarks.');
    const book = (b: FixtureBook) => scoreBook({ ...b, craft: fixtureCraft(b, registry) }, fixture.preferences);
    const series = (s: FixtureSeries) => scoreSeries({ ...s, books: s.books.map(book) }, fixture.preferences);
    const result = fixture.kind === 'book' ? book(fixture.input as FixtureBook)
      : fixture.kind === 'series' ? series(fixture.input as FixtureSeries)
        : scoreAuthor({ ...fixture.input as FixtureAuthor, series: (fixture.input as FixtureAuthor).series.map(series) }, fixture.preferences);
    return { id: fixture.id, kind: fixture.kind, expected: fixture.expected, result };
  });
  return results.map(({ id, kind, expected: e, result: r }) => {
    const failures: string[] = [];
    if (e.craftMin !== undefined && (r.craft.score === null || r.craft.score < e.craftMin)) failures.push('craft below expected range');
    if (e.craftMax !== undefined && (r.craft.score === null || r.craft.score > e.craftMax)) failures.push('craft above expected range');
    if (Object.hasOwn(e, 'craftScore') && r.craft.score !== e.craftScore) failures.push('craft value mismatch');
    if (Object.hasOwn(e, 'indexScore') && r.index.score !== e.indexScore) failures.push('index value mismatch');
    if (e.indexLessThanCraft && !(r.index.score !== null && r.craft.score !== null && r.index.score < r.craft.score)) failures.push('content preference did not change fit');
    if (e.noAdjustmentKind && r.index.adjustments.some(a => a.kind === e.noAdjustmentKind)) failures.push(`unexpected ${e.noAdjustmentKind} adjustment`);
    if (e.trend && (!('trend' in r) || r.trend.status !== e.trend)) failures.push('trend mismatch');
    if (e.sameCraftAs && r.craft.score !== results.find(v => v.id === e.sameCraftAs)?.result.craft.score) failures.push('craft invariance failed');
    if (e.sameIndexAs && r.index.score !== results.find(v => v.id === e.sameIndexAs)?.result.index.score) failures.push('index invariance failed');
    return { id, kind, synthetic: true, passed: failures.length === 0, craft: r.craft.score, index: r.index.score, failures };
  });
}

export function benchmarkQuality(report: QualityReport, registry: Registry = qualityBenchmarks) {
  const controls = runSyntheticBenchmarks(registry);
  const anchors = registry.anchors.map(anchor => {
    const rows = anchor.entityType === 'book' ? report.books : anchor.entityType === 'series' ? report.series : report.authors;
    const result = rows.find(row => row.id === anchor.entityId);
    const score = result?.craft.score ?? null;
    const coverage = result && 'coverage' in result ? result.coverage.share : null;
    const distance = score === null ? null : Math.max(0, anchor.target.min - score, score - anchor.target.max);
    return { id: anchor.id, entityId: anchor.entityId, title: anchor.title, target: anchor.target,
      measuredCraft: score, measuredIndex: result?.index.score ?? null, confidence: result?.craft.confidence ?? 0,
      knownCatalogShareAssessed: coverage,
      comparison: score === null ? 'unscored' : distance === 0 ? 'within-proposed-band' : 'outside-proposed-band',
      distanceFromBand: distance,
      evidenceAdequateForCalibration: !!result && result.craft.status === 'supported' && (coverage === null || coverage >= 0.5),
      trend: result && 'trend' in result ? result.trend : null,
      ...(anchor.trendHypothesis ? { trendHypothesis: anchor.trendHypothesis } : {}) };
  });
  const measured = anchors.filter(a => a.measuredCraft !== null);
  return { version: registry.version, generatedAt: report.generatedAt, scoringVersion: report.version,
    interpretation: 'Calibration targets are subjective proposed ranges, never training inputs or overwritten scores. Synthetic controls test mechanics, not real-world accuracy.',
    summary: { syntheticPassed: controls.filter(c => c.passed).length, syntheticTotal: controls.length,
      anchorsMeasured: measured.length, anchorsTotal: anchors.length,
      anchorsWithinBand: measured.filter(a => a.distanceFromBand === 0).length,
      anchorsWithAdequateEvidence: anchors.filter(a => a.evidenceAdequateForCalibration).length,
      meanDistanceFromProposedBands: measured.length ? Math.round(measured.reduce((s, a) => s + a.distanceFromBand!, 0) / measured.length * 100) / 100 : null },
    anchors, controls, openGaps: registry.openGaps };
}
