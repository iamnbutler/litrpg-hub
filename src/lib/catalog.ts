/** Shared, serializable catalog contract. No browser or server dependencies. */
export type Verdict = 'present' | 'absent' | 'unknown';
export interface ContentSignal {
	verdict: Verdict;
	confidence: number;
	source: 'publisher' | 'jev' | 'vision' | 'manual' | 'unknown';
	note: string;
}
export const tasteLabels = {
	stats: 'Crunchy stats', action: 'Action', humor: 'Humor', cozy: 'Cozy vibes',
	worldbuilding: 'Worldbuilding', crafting: 'Crafting & building', politics: 'Schemes & politics', teamwork: 'Found family'
} as const;
export type Taste = keyof typeof tasteLabels;
export type TasteProfile = Partial<Record<Taste, { value: number; confidence: number }>>;
export interface Assessment {
	model: string;
	evaluatedAt: string;
	inputHash: string;
	taste: TasteProfile;
	genre: { value: 'litrpg' | 'progression' | 'adjacent' | 'unrelated' | 'unknown'; confidence: number };
	explicit: ContentSignal;
	harem: ContentSignal;
	quality: ContentSignal;
}
/** Cover evidence is separate from claims about the book's contents. */
export interface CoverAssessment {
    model: string;
    evaluatedAt: string;
    imageHash: string;
    rubricVersion: string;
    coverUrl: string;
    level: 'none' | 'suggestive' | 'sexualized' | 'explicit' | 'unknown';
    confidence: number;
    observations: string[];
    signal: ContentSignal;
}
/** Bump when feature meanings change; a model change alone does not invalidate review. */
export const FEATURE_TAXONOMY_VERSION = 'catalog-features-v1';
export interface FeatureEvidence { sourceUrl: string; additionalSourceUrls?: string[]; reviewedAt: string; taxonomyVersion: string }
export interface CatalogBook {
	id: string;
	workId?: string;
	descriptionSource?: { name:string; url:string; checkedAt:string; kind:'editorial-summary'; reviewedAt?:string };
	/** Positive, source-reviewed features. A missing tag does not establish absence. */
	features?: string[];
	featureEvidence?: FeatureEvidence;
	readerContext?: import('./reader-context.js').ReaderContext;
	title: string;
	subtitle: string;
	series: string;
	seriesKey: string;
	seriesNumber: number | null;
	author: string;
	narrator: string | null;
	releaseDate: string | null;
	coverUrl: string | null;
	runtimeMinutes: number | null;
	subgenres: string[];
	description: string;
	url: string | null;
	rating: number | null;
	ratingCount: number;
	edition: 'audiobook' | 'dramatized' | 'collection' | 'podcast';
	scope: 'indexed' | 'review';
	content: { sexualized: ContentSignal; explicit: ContentSignal; harem: ContentSignal; aiNarration: ContentSignal; aiWriting: ContentSignal; quality: ContentSignal };
	assessment: Assessment | null;
	coverAssessment?: CoverAssessment | null;
	sources: { name: string; fetchedAt: string; url?:string }[];
	issues: string[];
}
export interface Catalog {
	version: 1;
	generatedAt: string;
	sourceSnapshotAt: string | null;
	stats: { books: number; series: number; assessed: number; needsReview: number; staleSources: number };
	books: CatalogBook[];
	series?: import('./series.js').CatalogSeries[];
}
export interface ReaderFilters {
	hideSexualized: boolean;
	hideExplicit: boolean;
	hideHarem: boolean;
	hideAiNarration: boolean;
	hideAiWriting: boolean;
	hideQualityFlags: boolean;
	hideUnknown: boolean;
}
export const defaultFilters: ReaderFilters = {
	hideSexualized: true, hideExplicit: true, hideHarem: true, hideAiNarration: true,
	hideAiWriting: true, hideQualityFlags: false, hideUnknown: false
};
export const genreLabels: Record<string, string> = {
	litrpg: 'LitRPG', progression: 'Progression fantasy', cultivation: 'Cultivation', dungeon: 'Dungeons',
	isekai: 'Isekai', 'tower-climbing': 'Tower climbing', 'system-apocalypse': 'System apocalypse',
	'base-building': 'Base building', 'time-loop': 'Time loop', academy: 'Academy', crafting: 'Crafting',
	'monster-mc': 'Monster MC', wuxia: 'Wuxia'
};

export function normalizeIdentity(value: string): string {
	return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
export function seriesIdentity(series: string, author: string): string {
	// Audible sometimes appends a publisher or a pen-name expansion to author credits.
	const primaryAuthor = author.split(',')[0].replace(/\([^)]*\)/g, '').trim();
	return `${normalizeIdentity(series)}--${normalizeIdentity(primaryAuthor) || 'unknown'}`;
}
export function validReleaseDate(value: string | null | undefined, now = new Date()): string | null {
	if (!value || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return null;
	const date = value.slice(0, 10);
	const parsed = new Date(`${date}T12:00:00Z`);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
	const year = parsed.getUTCFullYear();
	return year >= 1900 && year <= now.getUTCFullYear() + 3 ? date : null;
}
export function signalIsPresent(signal: ContentSignal | undefined): boolean {
	return signal?.verdict === 'present' && signal.confidence >= (['jev', 'vision'].includes(signal.source) ? 0.8 : 0.9);
}
export function passesFilters(book: CatalogBook, filters: ReaderFilters): boolean {
	const checks: [boolean, ContentSignal][] = [
		[filters.hideSexualized, book.content.sexualized], [filters.hideExplicit, book.content.explicit], [filters.hideHarem, book.content.harem],
		[filters.hideAiNarration, book.content.aiNarration], [filters.hideAiWriting, book.content.aiWriting],
		[filters.hideQualityFlags, book.content.quality]
	];
	return checks.every(([enabled, signal]) => !enabled || (!signalIsPresent(signal) &&
		(!filters.hideUnknown || (signal?.verdict === 'absent' && signal.confidence >= 0.8))));
}
export function bookPopularity(book: CatalogBook): number {
	const votes = book.ratingCount;
	const bayesian = ((book.rating ?? 4.2) * votes + 4.2 * 50) / (votes + 50);
	return bayesian * Math.log2(2 + votes);
}
/** Hide an old backfill placeholder only when a matching, richer edition exists.
 * Raw records stay in the catalog so saved IDs and source history still resolve.
 */
export function collapsePlaceholderDuplicates(books: CatalogBook[]): CatalogBook[] {
	const key = (b: CatalogBook) => [b.seriesKey, b.seriesNumber ?? '', normalizeIdentity(b.title), b.edition,
		b.releaseDate ?? '', normalizeIdentity((b.narrator ?? '').split(',')[0])].join('|');
	const placeholder = (b: CatalogBook) => !b.sources.length && !b.runtimeMinutes && !b.ratingCount;
	const richer = new Set(books.filter(b => !placeholder(b)).map(key));
	return books.filter(b => !placeholder(b) || !richer.has(key(b)));
}
/** One entry point per series + author. Preserve editions in the full catalog. */
export function seriesStarters(books: CatalogBook[]): CatalogBook[] {
	const groups = new Map<string, CatalogBook[]>();
	for (const book of books) {
		const key = book.series ? book.seriesKey : book.id;
		groups.set(key, [...(groups.get(key) ?? []), book]);
	}
	return [...groups.values()].map((entries) => entries.sort((a, b) =>
		Number(a.edition !== 'audiobook') - Number(b.edition !== 'audiobook') ||
		(a.seriesNumber ?? 9999) - (b.seriesNumber ?? 9999) ||
		bookPopularity(b) - bookPopularity(a) || a.id.localeCompare(b.id)
	)[0]);
}
export function searchBooks(books: CatalogBook[], query: string): CatalogBook[] {
	const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
	return books.filter((b) => {
		const haystack = [b.title, b.series, b.author, b.narrator, b.subtitle, ...b.subgenres.map(g => genreLabels[g] ?? g)].join(' ').toLowerCase();
		return terms.every(term => haystack.includes(term));
	});
}
export interface Recommendation { book: CatalogBook; score: number; reasons: string[]; method: 'taste' | 'genres' }
export type TasteWeights = Partial<Record<Taste, number>>;
export { recommend } from './recommend.js';
export function displayDate(value: string | null, options: Intl.DateTimeFormatOptions = {}): string {
	return value ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC', ...options }).format(new Date(`${value.slice(0,10)}T12:00:00Z`)) : 'Date to be announced';
}
export function formatRuntime(minutes: number | null): string {
	if (!minutes) return 'Length unavailable';
	return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}
