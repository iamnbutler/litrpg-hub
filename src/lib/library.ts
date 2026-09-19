import { defaultFilters, normalizeIdentity, type CatalogBook, type ReaderFilters } from './catalog.js';
import { mainlineWorks, seriesGaps, workHasAudio, workRelease, workReleased, type CatalogSeries, type CatalogWork } from './series.js';
import { isAudioCoverageCurrent } from './audio-coverage.js';

export const storageKeys = {
	legacyLibrary: 'litrpg-hub:library:v1',
	library: 'litrpg-hub:library:v2',
	filters: 'litrpg-hub:filters:v1',
	/** Signed-out readers only. A signed-in reader's age claim lives on their account. */
	adult: 'litrpg-hub:adult:v1'
} as const;

export type ShelfStatus = 'want' | 'reading' | 'read' | 'paused';
export const shelfLabels: Record<ShelfStatus, string> = { want: 'Want to read', reading: 'Listening', read: 'Read', paused: 'On hold' };
export interface ShelfEntry {
	status: ShelfStatus; rating: number | null; updatedAt: string;
	/** Which volume this was recorded against, independent of whatever id held it at the time.
	 * Work ids are re-minted as the catalog is enriched; this survives that. */
	work?: { series: string; number: number | null };
}
/** Keyed by work id, and by edition id for anything saved before series existed. */
export type Library = Record<string, ShelfEntry>;

const reservedId = (id: string) => ['__proto__', 'constructor', 'prototype'].includes(id);
/** Source edition ids are not always ASIN shaped, so allow the punctuation stable ids use
 * while still refusing keys that would reach Object.prototype. */
const safeId = (id: string) => /^[A-Za-z0-9._:-]{1,128}$/.test(id) && !reservedId(id);

export function parseLibrary(value: unknown): Library {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const result: Library = {};
	for (const [id, entry] of Object.entries(value)) {
		if (!entry || typeof entry !== 'object' || !Object.hasOwn(shelfLabels, entry.status) || !safeId(id)) continue;
		const hint = entry.work;
		// Volume numbers are not always integers — 0.5 prequels and 10.5 novellas are common.
		const validHint = hint && typeof hint === 'object' && typeof hint.series === 'string' && safeId(hint.series)
			&& (hint.number === null || hint.number === undefined || Number.isFinite(hint.number));
		result[id] = {
			status: entry.status,
			rating: Number.isInteger(entry.rating) && entry.rating >= 1 && entry.rating <= 5 ? entry.rating : null,
			updatedAt: typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt)) ? entry.updatedAt : new Date().toISOString(),
			...(validHint ? { work: { series: hint.series as string, number: (hint.number ?? null) as number | null } } : {})
		};
	}
	return result;
}
export function parseFilters(value: unknown): ReaderFilters {
	const result = { ...defaultFilters };
	if (!value || typeof value !== 'object') return result;
	for (const key of Object.keys(result) as (keyof ReaderFilters)[]) {
		const v = (value as Record<string, unknown>)[key];
		if (typeof v === 'boolean') result[key] = v;
	}
	return result;
}

export interface SeriesLibrary { version: 2; series: Record<string, { followedAt: string }>; books: Library }
export const emptyLibrary = (): SeriesLibrary => ({ version: 2, series: {}, books: {} });

export function parseSeriesLibrary(value: unknown): SeriesLibrary | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const data = value as Partial<SeriesLibrary>;
	if (data.version !== 2 || !data.series || typeof data.series !== 'object' || Array.isArray(data.series) || !data.books || typeof data.books !== 'object' || Array.isArray(data.books)) return null;
	const result = emptyLibrary();
	result.books = parseLibrary(data.books);
	for (const [id, entry] of Object.entries(data.series)) {
		if (safeId(id) && entry && typeof entry.followedAt === 'string' && Number.isFinite(Date.parse(entry.followedAt))) result.series[id] = { followedAt: entry.followedAt };
	}
	return result;
}

const allWorkIds = (work: CatalogWork) => [work.id, work.bookId, ...work.editionIds];

/** The id `groupSeries` synthesises before a series has canonical works. Generated, never
 * parsed, so a series id containing hyphens can't be misread. */
const legacyWorkId = (seriesId: string, number: number | null, title: string) =>
	`work-legacy-${seriesId}-${number ?? ''}-${normalizeIdentity(title.split(':')[0]).slice(0, 70)}`;

/** Enriching a series re-mints its work ids, which strands progress saved under the old ones.
 * Re-home any entry that no longer resolves: first by the provenance hint on the entry, then
 * by regenerating the synthesized ids this app would have produced for the series' former
 * names. Matching is always series + volume number, so unrelated books never merge. */
function rehomeOrphans(record: SeriesLibrary, catalog: CatalogSeries[], catalogBooks?: ReadonlyMap<string, CatalogBook>): SeriesLibrary {
	if (!catalog.length) return record;
	const resolvable = new Set<string>();
	for (const s of catalog) for (const w of s.works) for (const id of allWorkIds(w)) resolvable.add(id);
	const orphans = Object.keys(record.books).filter((id) => !resolvable.has(id));
	if (!orphans.length) return record;

	const synthesized = new Map<string, { series: CatalogSeries; work: CatalogWork }>();
	for (const series of catalog) {
		const names = [series.id, ...series.aliases];
		for (const work of series.works) {
			// The id was built from the EDITION's title and number. Enrichment may since have
			// retitled or renumbered the work, so regenerate from the editions too.
			const titles = new Set([work.title]);
			const numbers = new Set<number | null>([work.number]);
			for (const id of catalogBooks ? [work.bookId, ...work.editionIds] : []) {
				const book = catalogBooks!.get(id);
				if (!book) continue;
				titles.add(book.title);
				numbers.add(book.seriesNumber);
			}
			for (const name of names) for (const title of titles) for (const number of numbers) {
				if (number != null) synthesized.set(legacyWorkId(name, number, title), { series, work });
			}
		}
	}
	/** Mirrors `workIndex`'s reconciliation: an audiobook the exporter left out of every work
	 * still resolves by series + volume number, so progress saved against its id is adopted
	 * rather than left depending on every call site remembering a fallback. */
	const byCatalogBook = (id: string) => {
		const book = catalogBooks?.get(id);
		if (!book || book.edition !== 'audiobook' || book.seriesNumber == null) return undefined;
		const series = catalog.find((s) => s.id === book.seriesKey || s.aliases.includes(book.seriesKey));
		const work = series?.works.find((w) => w.number === book.seriesNumber);
		return series && work ? { series, work } : undefined;
	};
	const byHint = (hint: ShelfEntry['work']) => {
		if (!hint) return undefined;
		const series = catalog.find((s) => s.id === hint.series || s.aliases.includes(hint.series));
		const work = series?.works.find((w) => w.number === hint.number);
		return series && work ? { series, work } : undefined;
	};

	const books = { ...record.books };
	for (const id of orphans) {
		const entry = books[id];
		const target = byHint(entry.work) ?? synthesized.get(id) ?? byCatalogBook(id);
		if (!target) continue;
		const existing = books[target.work.id];
		if (!existing || Date.parse(entry.updatedAt) >= Date.parse(existing.updatedAt)) {
			books[target.work.id] = { ...entry, work: { series: target.series.id, number: target.work.number } };
		}
		// Only ids this app synthesised are dropped. Real source ids stay as aliases forever.
		if (id.startsWith('work-legacy-')) delete books[id];
	}
	return { ...record, books };
}

/** Keep edition-keyed history intact; new actions are saved against stable work IDs.
 * The v1 record is never written to again, so it stays a usable backup. */
export function migrateLibrary(legacy: Library, catalog: CatalogSeries[], current: SeriesLibrary | null = null, books?: ReadonlyMap<string, CatalogBook>): SeriesLibrary {
	const result = current ? { ...current, series: { ...current.series }, books: { ...current.books } } : { ...emptyLibrary(), books: { ...legacy } };
	if (!current) {
		// Anything already tracked implies the reader cares about the series it belongs to.
		for (const series of catalog) {
			const stamps = series.works.flatMap((w) => allWorkIds(w).flatMap((id) => (legacy[id] ? [legacy[id].updatedAt] : []))).sort();
			if (stamps.length) result.series[series.id] = { followedAt: stamps[0] };
		}
		return rehomeOrphans(result, catalog, books);
	}
	for (const [id, entry] of Object.entries(result.series)) {
		const canonical = catalog.find((s) => s.id === id || s.aliases.includes(id));
		if (!canonical || canonical.id === id) continue;
		const existing = result.series[canonical.id];
		result.series[canonical.id] = existing && existing.followedAt < entry.followedAt ? existing : entry;
		delete result.series[id];
	}
	return rehomeOrphans(result, catalog, books);
}

/** Progress recorded against any edition of a work counts for the work. The most recent entry
 * wins whichever id holds it, so an imported read against an old ASIN is not shadowed by a
 * staler entry on the canonical work id. The canonical id only breaks ties. */
export function workEntry(library: SeriesLibrary, work: CatalogWork): ShelfEntry | undefined {
	let best: ShelfEntry | undefined;
	for (const id of allWorkIds(work)) {
		const entry = library.books[id];
		if (!entry) continue;
		if (!best) { best = entry; continue; }
		const newer = Date.parse(entry.updatedAt) - Date.parse(best.updatedAt);
		if (newer > 0 || (newer === 0 && id === work.id)) best = entry;
	}
	return best;
}
export const isFollowing = (library: SeriesLibrary, seriesId: string): boolean => !!library.series[seriesId];

export function followSeries(library: SeriesLibrary, seriesId: string, follow = true, now = new Date().toISOString()): SeriesLibrary {
	const next = { ...library, series: { ...library.series } };
	if (follow) next.series[seriesId] ??= { followedAt: now };
	// Unfollowing only drops the subscription. Read history and ratings stay put.
	else delete next.series[seriesId];
	return next;
}

export function setWorkStatus(library: SeriesLibrary, series: CatalogSeries, work: CatalogWork, status: ShelfStatus | '', now = new Date().toISOString()): SeriesLibrary {
	const next = followSeries(library, series.id, !!status || isFollowing(library, series.id), now);
	next.books = { ...library.books };
	if (status) next.books[work.id] = { status, rating: workEntry(library, work)?.rating ?? null, updatedAt: now, work: { series: series.id, number: work.number } };
	// Explicitly clearing progress removes all edition aliases for this work, preventing an old read from reappearing.
	else for (const id of allWorkIds(work)) delete next.books[id];
	return next;
}
export function setWorkRating(library: SeriesLibrary, series: CatalogSeries, work: CatalogWork, rating: number, now = new Date().toISOString()): SeriesLibrary {
	const next = followSeries(library, series.id, true, now);
	next.books = { ...library.books, [work.id]: { status: workEntry(library, work)?.status ?? 'read', rating: rating >= 1 && rating <= 5 ? Math.round(rating) : null, updatedAt: now, work: { series: series.id, number: work.number } } };
	return next;
}

/** Bulk action covers released audiobooks only. Announced volumes are left alone. */
export function markSeriesRead(library: SeriesLibrary, series: CatalogSeries, at = new Date().toISOString(), now = new Date().toISOString()): SeriesLibrary {
	let result = followSeries(library, series.id, true, now);
	for (const work of series.works) if (workReleased(series, work, at) && workEntry(result, work)?.status !== 'read') result = setWorkStatus(result, series, work, 'read', now);
	return result;
}

/** Readers almost always find this app part-way through a series they have been listening to
 * for years. Recording "I'm through Book 7" in one action is the difference between adopting
 * the library and abandoning it. Only released audiobooks up to and including the chosen
 * volume are touched; anything after it, and any unnumbered side entry, is left alone. */
export function markReadThrough(library: SeriesLibrary, series: CatalogSeries, work: CatalogWork, at = new Date().toISOString(), now = new Date().toISOString()): SeriesLibrary {
	const mainline = mainlineWorks(series);
	const cutoff = mainline.findIndex((w) => w.id === work.id);
	if (cutoff < 0) return setWorkStatus(library, series, work, 'read', now);
	let result = followSeries(library, series.id, true, now);
	for (const w of mainline.slice(0, cutoff + 1)) {
		if (workReleased(series, w, at) && workEntry(result, w)?.status !== 'read') result = setWorkStatus(result, series, w, 'read', now);
	}
	return result;
}

export type SeriesState = 'caught-up' | 'caught-up-partial' | 'in-progress' | 'not-started';
export interface SeriesProgress {
	read: number; total: number; remaining: number; undated: number; upcoming: number;
	gaps: number[]; caughtUp: boolean; nextUnread: CatalogWork | null; side: { read: number; total: number };
	/** Reviewed audio coverage is present AND still current, re-checked at render time. */
	sourceComplete: boolean;
	/** Everything the catalog knows about is read, but something is unresolved. */
	unresolved: string[]; state: SeriesState;
}
/** "Up to date" is a claim about the reader, and it is only made on reviewed evidence that the
 * audiobook list itself is complete and still fresh. Coverage carries its own expiry, so it is
 * re-checked here rather than trusted as exported: a `current: true` shipped last month is not
 * timeless. `now` may be a plain date, in which case coverage can never be current — a
 * date-only caller cannot establish freshness, and guessing would be the false positive.
 * Scheduled audio is never counted as unread. */
export function seriesProgress(library: SeriesLibrary, series: CatalogSeries, now = new Date().toISOString()): SeriesProgress {
	const today = now.slice(0, 10);
	const mainline = mainlineWorks(series);
	const isRead = (w: CatalogWork) => workEntry(library, w)?.status === 'read';
	const release = (w: CatalogWork) => workRelease(series, w, now);
	const coverage = series.audioCoverage;
	const coverageCurrent = isAudioCoverageCurrent(coverage, now);
	const byId = new Map(series.works.map((w) => [w.id, w]));
	// A verified release we cannot resolve to a work is unread by definition: we have no record.
	const unmatched = coverageCurrent ? coverage!.releasedWorkIds.filter((id) => !byId.has(id)).length : 0;
	// A work current coverage does not vouch for must not inherit its old catalogued date.
	// A print/ebook-only volume is rightly absent from an AUDIO bibliography, so its absence
	// is not a gap in the coverage.
	const unvouched = coverageCurrent ? mainline.filter((w) => workHasAudio(w) && release(w).state === 'unknown').length : 0;

	const available = mainline.filter((w) => release(w).state === 'released');
	const read = available.filter(isRead).length;
	const undated = coverageCurrent ? 0 : mainline.filter((w) => release(w).state === 'unknown' && !isRead(w)).length;
	const upcoming = mainline.filter((w) => release(w).state === 'scheduled').length;
	const gaps = coverageCurrent ? [] : seriesGaps(series);
	const mainlineIds = new Set(mainline.map((w) => w.id));
	const side = series.works.filter((w) => !mainlineIds.has(w.id) && release(w).state === 'released');
	const sideRead = side.filter(isRead).length;

	const unresolved = coverageCurrent
		? [
			...(unmatched ? [`${unmatched} audiobook${unmatched === 1 ? ' is' : 's are'} missing from this list`] : []),
			...(unvouched ? [`${unvouched} book${unvouched === 1 ? ' here has' : 's here have'} not been confirmed as an audiobook`] : [])
		]
		: [
			...(gaps.length ? [`Book ${gaps.join(', ')} ${gaps.length === 1 ? 'is' : 'are'} missing from this list`] : []),
			...(undated ? [`${undated} audiobook${undated === 1 ? ' has' : 's have'} no confirmed release date`] : []),
			...(side.length - sideRead ? [`${side.length - sideRead} side entr${side.length - sideRead === 1 ? 'y is' : 'ies are'} unread`] : []),
			'This list may be incomplete'
		];

	const finished = available.length > 0 && read === available.length;
	const caughtUp = coverageCurrent && !unresolved.length && finished;
	return {
		read, total: available.length, remaining: available.length - read, undated, upcoming, gaps,
		caughtUp, nextUnread: available.find((w) => !isRead(w)) ?? null,
		side: { read: sideRead, total: side.length }, sourceComplete: coverageCurrent, unresolved,
		state: finished
			? caughtUp ? 'caught-up' : 'caught-up-partial'
			: read > 0 || series.works.some((w) => workEntry(library, w)?.status === 'reading') ? 'in-progress' : 'not-started'
	};
}

export interface LibraryExport { version: 2; exportedAt: string; library: SeriesLibrary }
export const libraryExport = (library: SeriesLibrary, exportedAt = new Date().toISOString()): LibraryExport => ({ version: 2, exportedAt, library });

/** Accepts both the original shelf export and the series export. */
export function parseLibraryExport(value: unknown, catalog: CatalogSeries[], books?: ReadonlyMap<string, CatalogBook>): SeriesLibrary | null {
	if (!value || typeof value !== 'object') return null;
	const data = value as { version?: unknown; library?: unknown };
	// Canonicalise and re-home: the exporting machine's work ids may predate an enrichment.
	if (data.version === 2) { const parsed = parseSeriesLibrary(data.library); return parsed && migrateLibrary({}, catalog, parsed, books); }
	if (data.version === 1 && data.library && typeof data.library === 'object') return migrateLibrary(parseLibrary(data.library), catalog, null, books);
	return null;
}

/** Later edits win per book; a series stays followed from the earliest date either side knows. */
export function mergeLibraries(base: SeriesLibrary, incoming: SeriesLibrary): SeriesLibrary {
	const result: SeriesLibrary = { version: 2, series: { ...base.series }, books: { ...base.books } };
	for (const [id, entry] of Object.entries(incoming.series)) {
		const existing = result.series[id];
		result.series[id] = existing && existing.followedAt < entry.followedAt ? existing : entry;
	}
	for (const [id, entry] of Object.entries(incoming.books)) {
		const existing = result.books[id];
		if (!existing || Date.parse(entry.updatedAt) >= Date.parse(existing.updatedAt)) result.books[id] = entry;
	}
	return result;
}
