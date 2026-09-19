/** The scoring boundary deliberately has no star ratings or rating-count fields. */
export const craftDimensions = ['prose', 'editing', 'coherence', 'structure', 'pacing', 'repetition'] as const;
export type CraftDimension = typeof craftDimensions[number];

/** Evidence is a retained, independently deduplicated review, not a model receipt. */
export interface DimensionEvidence {
  score: number;
  confidence: number;
  evidenceIds: readonly string[];
  positiveVoices: number;
  negativeVoices: number;
  mixedVoices: number;
  /** Direction uncertain between adjacent grades; not a reader explicitly reporting mixed execution. Omitted legacy values mean zero. */
  uncertainVoices?: number;
  judgedVoices: number;
}
export interface CraftInput {
  dimensions: Partial<Record<CraftDimension, DimensionEvidence>>;
  /** Unique relevant voices across all dimensions, never the sum of dimension counts. */
  relevantVoices: number;
}
export interface DimensionScore extends DimensionEvidence {
  dimension: CraftDimension;
  weight: number;
}
export interface ScoreEstimate {
  score: number | null;
  confidence: number;
  coverage: number;
  /** Sensitivity bounds, NOT a statistically calibrated confidence interval. */
  range: [number, number];
  status: 'unknown' | 'insufficient' | 'provisional' | 'supported';
}
export interface CraftScore extends ScoreEstimate {
  dimensions: DimensionScore[];
  relevantVoices: number;
  missingDimensions: CraftDimension[];
  reasons: string[];
}
export interface EvidenceSignal {
  verdict: 'present' | 'absent' | 'unknown';
  confidence: number;
  evidenceIds: readonly string[];
}
export interface ContentSignals {
  explicit?: EvidenceSignal;
  harem?: EvidenceSignal;
  sexualized?: EvidenceSignal;
}
export interface RenownEvidence {
  /** Reviewed renown strength, not sales, stars, or a model recognizing the name. */
  score: number;
  confidence: number;
  evidenceIds: readonly string[];
  basis: 'independent-recognition' | 'editorial-reference';
}
export interface ReleaseEvidence {
  workId: string;
  date: string;
  format: 'ebook' | 'print' | 'web-serial' | 'audiobook' | 'dramatized' | 'unknown';
  /** A source must establish first publication; an edition's date cannot do this. */
  role: 'first-publication' | 'edition-release' | 'unknown';
  verified: boolean;
  evidenceIds: readonly string[];
}
export interface ProductionInput {
  releases: readonly ReleaseEvidence[];
  /** Explicit evidence excludes serial/back-catalogue/translation/reissue batching. */
  backlogExcluded: boolean;
  backlogEvidenceIds?: readonly string[];
  asOf: string;
}
export interface ProductionAssessment {
  status: 'unknown' | 'insufficient' | 'ordinary' | 'rapid';
  originalWorks: number;
  intervalsDays: number[];
  medianDays: number | null;
  shortIntervals: number;
  backlogExcluded: boolean;
  eligibleForRiskAdjustment: boolean;
  evidenceIds: string[];
  reasons: string[];
}
export interface QualityPreferences {
  avoidExplicit: boolean;
  avoidHarem: boolean;
  avoidSexualizedMarketing: boolean;
  useRenown: boolean;
  useCorroboratedProductionRisk: boolean;
}
export interface IndexAdjustment {
  kind: 'content-fit' | 'renown' | 'production-risk';
  points: number;
  evidenceIds: string[];
  explanation: string;
}
export interface CraftConcern {
  dimension: CraftDimension;
  score: number;
  confidence: number;
  evidenceIds: string[];
}
export interface QualityIndex {
  score: number | null;
  baseCraft: number | null;
  adjustments: IndexAdjustment[];
  preferences: QualityPreferences;
}
export interface QualityModifiers {
  content?: ContentSignals;
  renown?: RenownEvidence;
  production?: ProductionInput;
}
export interface BookQualityInput extends QualityModifiers {
  id: string;
  seriesId: string;
  number: number | null;
  craft: CraftInput;
}
export interface BookQualityScore {
  id: string;
  seriesId: string;
  number: number | null;
  version: string;
  craft: CraftScore;
  index: QualityIndex;
  production: ProductionAssessment;
  craftConcerns: CraftConcern[];
}
export interface AggregationCoverage {
  assessed: number;
  known: number;
  share: number;
  /** Even 100% of known books does not prove the catalog is complete. */
  catalogComplete: boolean;
  scope: 'assessed-books' | 'assessed-series';
}
export interface SeriesTrend {
  status: 'insufficient' | 'declining' | 'improving' | 'similar';
  early: number | null;
  late: number | null;
  change: number | null;
  earlyWorkIds: string[];
  lateWorkIds: string[];
  explanation: string;
}
export interface SeriesQualityInput extends QualityModifiers {
  id: string;
  books: readonly BookQualityScore[];
  /** May exceed books.length when the adapter already knows absent volumes. */
  knownWorkCount?: number;
  catalogComplete?: boolean;
}
export interface SeriesQualityScore {
  id: string;
  version: string;
  craft: ScoreEstimate;
  index: QualityIndex;
  production: ProductionAssessment;
  craftConcerns: CraftConcern[];
  coverage: AggregationCoverage;
  trend: SeriesTrend;
  bookIds: string[];
  reasons: string[];
}
export interface AuthorQualityInput extends QualityModifiers {
  id: string;
  series: readonly SeriesQualityScore[];
  knownSeriesCount?: number;
  catalogComplete?: boolean;
}
export interface AuthorQualityScore {
  id: string;
  version: string;
  craft: ScoreEstimate;
  index: QualityIndex;
  production: ProductionAssessment;
  craftConcerns: CraftConcern[];
  coverage: AggregationCoverage;
  seriesIds: string[];
  reasons: string[];
}
