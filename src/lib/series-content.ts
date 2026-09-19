import { passesFilters, signalIsPresent, type CatalogBook, type ReaderFilters } from './catalog.js';
import { explicitEditionKind } from './edition.js';
import type { CatalogSeries } from './series.js';

/** A fact about the catalogued series, not a verdict about every book in it. */
export interface SeriesHaremDisclosure {
	seriesId: string;
	supportingEditionIds: string[];
	supportingWorkIds: string[];
}
/** Edition IDs point to the exact supporting evidence in the complete catalog. */
export type SeriesContentIndex = ReadonlyMap<string, SeriesHaremDisclosure>;

export function buildSeriesContentIndex(series: readonly CatalogSeries[], books: ReadonlyMap<string, CatalogBook>): SeriesContentIndex {
	const seriesIds = new Set(series.map(s => s.id));
	const membership = new Map<string, { seriesId: string; workId: string } | null>();
	for (const parent of series) for (const work of parent.works) {
		for (const id of new Set([work.bookId, ...work.editionIds])) {
			const existing = membership.get(id);
			// Conflicting membership is not evidence that two series share content.
			membership.set(id, membership.has(id) && (!existing || existing.seriesId !== parent.id || existing.workId !== work.id)
				? null : { seriesId: parent.id, workId: work.id });
		}
	}
	const members = new Map<string, { seriesId: string; workId?: string }>();
	const evidence = new Map<string, SeriesHaremDisclosure>();
	for (const book of books.values()) {
		const member = membership.has(book.id) ? membership.get(book.id)
			: seriesIds.has(book.seriesKey) ? { seriesId: book.seriesKey } : null;
		if (!member) continue;
		members.set(book.id, member);
		// Author defaults, cover observations and model guesses cannot create this fact.
		// Collections can be filtered, but do not establish evidence for their components.
		if (!('workId' in member) || !member.workId || book.edition !== 'audiobook' || explicitEditionKind(book)
			|| book.content.harem.source !== 'publisher' || !signalIsPresent(book.content.harem)) continue;
		const fact = evidence.get(member.seriesId) ?? { seriesId: member.seriesId, supportingEditionIds: [], supportingWorkIds: [] };
		fact.supportingEditionIds.push(book.id);
		fact.supportingWorkIds.push(member.workId);
		evidence.set(member.seriesId, fact);
	}
	for (const fact of evidence.values()) {
		fact.supportingEditionIds.sort();
		fact.supportingWorkIds = [...new Set(fact.supportingWorkIds)].sort();
	}
	return new Map([...members].flatMap(([id, member]) => {
		const fact = evidence.get(member.seriesId);
		return fact ? [[id, fact] as const] : [];
	}));
}

/** Preferences apply to discovery and releases, never to library membership or progress.
 * An affirmative statement about this book takes precedence over a sibling's disclosure. */
export function passesDiscoveryFilters(book: CatalogBook, filters: ReaderFilters, context: SeriesContentIndex): boolean {
	if (!passesFilters(book, filters)) return false;
	if (!filters.hideHarem || !context.has(book.id)) return true;
	return book.content.harem.verdict === 'absent' && book.content.harem.confidence >= 0.8;
}
