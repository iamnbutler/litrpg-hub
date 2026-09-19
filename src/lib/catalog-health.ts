/** Public inspector snapshot. These scores describe catalog evidence, never a book's quality. */
export type HealthStatus = 'present' | 'missing' | 'unknown' | 'stale';

export interface HealthCheck {
	id: string;
	label: string;
	status: HealthStatus;
	/** Some relevant data is retained; it may still be stale, thin, or unverified. */
	available: boolean;
	explanation: string;
	sourceUrl: string | null;
	observedAt: string | null;
	dueAt: string | null;
}
export interface HealthScore {
	percent: number;
	earned: number;
	possible: number;
	explanation: string;
}
export interface HealthIssue { code: string; status: Exclude<HealthStatus, 'present'>; message: string }
export interface HealthSource {
	url: string;
	status: HealthStatus;
	checkedAt: string | null;
	fetchedAt: string | null;
	nextCheckAt: string | null;
}
export interface HealthReader {
	retainedCount: number;
	/** Exactly the deduplicated, substantive, spoiler-filtered, capped model input. */
	selectedCount: number;
	eligible: boolean;
	minimum: number;
	currentTraits: boolean;
	observation: 'published' | 'corrected' | 'withheld' | 'missing';
	sourceUrls: string[];
}
export interface HealthCover {
	url: string | null;
	cached: boolean;
	hashVerified: boolean;
	bytes: number | null;
	observationCurrent: boolean;
	checkedAt: string | null;
}
export interface HealthAudio {
	retainedEditionCount: number;
	confirmedEditionCount: number;
	state: 'released' | 'scheduled' | 'undated' | 'unverified' | 'none';
	/** Verified audio evidence only; never a print/ebook date or an unverified row date. */
	releaseDate: string | null;
}
export interface HealthFlags {
	sourceDescription: boolean;
	summary: boolean;
	metadataExtracted: boolean;
	metadataReviewed: boolean;
	audiobook: boolean;
	audioVerified: boolean;
	audioDateVerified: boolean;
	coverAsset: boolean;
	coverReviewed: boolean;
	readerSample: boolean;
	readerAdequate: boolean;
}
export interface WorkHealth {
	id: string;
	seriesId: string;
	number: number | null;
	title: string;
	author: string;
	formats: string[];
	publicationStatus: 'released' | 'announced' | 'unknown';
	completeness: HealthScore;
	evidenceQuality: HealthScore;
	checks: HealthCheck[];
	issues: HealthIssue[];
	flags: HealthFlags;
	audio: HealthAudio;
	reader: HealthReader;
	cover: HealthCover;
	sources: HealthSource[];
}
export interface HealthVolumeGap {
	number: number;
	/** Numbering alone suggests investigation, never a manufactured missing book. */
	evidence: 'reviewed-bibliography' | 'observed-numbering';
	status: 'missing' | 'unknown' | 'stale';
	explanation: string;
	sourceUrls: string[];
}
export interface HealthBibliography {
	status: HealthStatus;
	audioCoverageStatus: 'verified' | 'incomplete' | 'unknown' | 'stale';
	expectedNumbers: number[];
	missingWorkNumbers: number[];
	reviewedAt: string | null;
	validUntil: string | null;
	sourceUrls: string[];
	/** Even a current ongoing list cannot establish that the story or audio series is finished. */
	explanation: string;
}
export interface SeriesHealth {
	id: string;
	title: string;
	author: string;
	workIds: string[];
	knownWorks: number;
	confirmedAudioWorks: number;
	completeness: HealthScore;
	evidenceQuality: HealthScore;
	checks: HealthCheck[];
	issues: HealthIssue[];
	missingVolumes: HealthVolumeGap[];
	bibliography: HealthBibliography;
	sources: HealthSource[];
}
export interface CatalogHealth {
	schemaVersion: 1;
	generatedAt: string;
	definitions: { completeness: string; evidenceQuality: string; readerAdequacy: string; audio: string; cover: string; bibliography: string };
	thresholds: { sourceDescriptionChars: number; readerVoices: number; readerBodyChars: number; readerCap: number; coverFreshnessDays: number };
	totals: {
		series: number; works: number; confirmedAudioWorks: number; verifiedAudioDates: number;
		coverAssets: number; reviewedMetadata: number; adequateReaderSamples: number;
		meanCompleteness: number; meanEvidenceQuality: number;
	};
	series: SeriesHealth[];
	works: WorkHealth[];
}
