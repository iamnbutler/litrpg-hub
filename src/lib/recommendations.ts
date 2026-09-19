import {
	bookPopularity, collapsePlaceholderDuplicates, defaultFilters, recommend,
	type CatalogBook, type ReaderFilters, type Recommendation, type TasteWeights
} from './catalog.js';
import { workHasAudio, workIndex, type CatalogSeries, type CatalogWork } from './series.js';
import { explicitEditionKind, hasExplicitLaterVolume } from './edition.js';
import { buildSeriesContentIndex, passesDiscoveryFilters, type SeriesContentIndex } from './series-content.js';

export interface SeriesEntry {
	/** The original, complete series. Eligibility never changes reading progress. */
	series: CatalogSeries;
	work: CatalogWork;
	/** Render this edition: it is the exact book that passed the reader's preferences. */
	book: CatalogBook;
}
export interface SeriesEntryOptions {
	filters?: ReaderFilters;
	includeUnclassified?: boolean;
	seriesContent?: SeriesContentIndex;
}
export interface SeriesRecommendation extends SeriesEntry {
	score: number;
	reasons: string[];
	method: Recommendation['method'];
}
export interface SeriesRecommendationOptions extends SeriesEntryOptions {
	weights?: TasteWeights;
	limit?: number;
}

/** Discovery requires volume 1, not merely the earliest volume we happened to collect.
 * A genuinely unnumbered single-work series is also a usable starting point.
 * Do not use this gate to hide followed series from the reader's library. */
export function seriesEntry(series: CatalogSeries, books: ReadonlyMap<string, CatalogBook>, options: SeriesEntryOptions = {}): SeriesEntry | null {
	const numbered = series.works.some(work => work.number != null);
	const work = numbered ? series.works.find(work => work.number === 1) : series.works.length === 1 ? series.works[0] : undefined;
	if (!work || !workHasAudio(work)) return null;
	// Legacy listings can omit the structured series number even while their title
	// explicitly says "Volume 9". That is missing identity, not a standalone.
	if (!numbered && hasExplicitLaterVolume(work)) return null;

	// Resolve the starting work before applying preferences. Only another full audio
	// edition of that same work may replace a blocked or missing representative.
	const editions = [...new Set([work.bookId, ...work.editionIds])]
		.flatMap(id => {
			const book = books.get(id);
			return book?.edition === 'audiobook' && !explicitEditionKind(book) &&
				(numbered || !hasExplicitLaterVolume(book)) ? [book] : [];
		});
	// A thin backfill alias must not bypass a flag on its substantive counterpart.
	const context = options.seriesContent ?? buildSeriesContentIndex([series], books);
	const eligible = collapsePlaceholderDuplicates(editions).filter(book =>
		(options.includeUnclassified || book.scope === 'indexed') && passesDiscoveryFilters(book, options.filters ?? defaultFilters, context));
	const book = eligible.find(book => book.id === work.bookId) ?? eligible.sort((a, b) =>
		bookPopularity(b) - bookPopularity(a) || Number(!a.coverUrl) - Number(!b.coverUrl) || a.id.localeCompare(b.id))[0];
	return book ? { series, work, book } : null;
}

/** One eligible entry per canonical series, before ranking or applying a result limit. */
export function eligibleSeriesEntries(series: readonly CatalogSeries[], books: ReadonlyMap<string, CatalogBook>, options: SeriesEntryOptions = {}): SeriesEntry[] {
	const entries = new Map<string, SeriesEntry>();
	const withContext = { ...options, seriesContent: options.seriesContent ?? buildSeriesContentIndex(series, books) };
	for (const candidate of series) {
		if (entries.has(candidate.id)) continue;
		const entry = seriesEntry(candidate, books, withContext);
		if (entry) entries.set(candidate.id, entry);
	}
	return [...entries.values()];
}

/** Reuse the existing scoring, but rank canonical starting works and retain their
 * eligible representative instead of remapping a filtered book to an unfiltered cover. */
export function recommendSeries(seed: CatalogBook, series: readonly CatalogSeries[], books: ReadonlyMap<string, CatalogBook>, options: SeriesRecommendationOptions = {}): SeriesRecommendation[] {
	const entries = eligibleSeriesEntries(series, books, options);
	const bySeries = new Map(entries.map(entry => [entry.series.id, entry]));
	const index = workIndex([...series], [seed]);
	const seedSeriesId = index.get(seed.id)?.series.id ?? (seed.workId ? index.get(seed.workId)?.series.id : undefined) ?? seed.seriesKey;
	// Canonical IDs also collapse old retailer aliases; canonical author credits keep
	// publisher bylines from defeating the existing author-diversity limit.
	const candidates = entries.map(entry => ({ ...entry.book, seriesKey: entry.series.id, author: entry.series.author }));
	return recommend({ ...seed, seriesKey: seedSeriesId }, candidates, options.weights, Math.max(0, options.limit ?? 12)).map(result => ({
		...bySeries.get(result.book.seriesKey)!, score: result.score, reasons: result.reasons, method: result.method
	}));
}
