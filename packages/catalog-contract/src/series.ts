import { bookPopularity, collapsePlaceholderDuplicates, normalizeIdentity, searchBooks, type CatalogBook } from './catalog.js';
import { isAudioCoverageCurrent, type AudioCoverage } from './audio-coverage.js';
import { explicitEditionKind } from './edition.js';

/** One mainline entry in a series. Editions of the same entry share a work. */
export interface CatalogWork {
	id: string;
	title: string;
	number: number | null;
	bookId: string;
	editionIds: string[];
	audioReleaseDate: string | null;
	verified: boolean;
	/** False only for a volume that exists in print or ebook with no audiobook edition.
	 * Omitted means audio exists, which is what `groupSeries` produces. */
	hasAudio?: boolean;
}
export interface CatalogSeries {
	id: string;
	title: string;
	author: string;
	aliases: string[];
	description: string;
	features?: string[];
	featureEvidence?: import('./catalog.js').FeatureEvidence;
	genres: string[];
	coverBookId: string;
	works: CatalogWork[];
	curated: boolean;
	/** Whether the STORY is finished. Says nothing about how much of it exists in audio. */
	status: 'ongoing' | 'complete' | 'unknown';
	/** Reviewed audio bibliography assessment. Deliberately separate from `status`: a finished
	 * story can still be part-way through audio production, and an ongoing one fully covered.
	 * It carries its own expiry, so it is re-checked at render time, never trusted as shipped. */
	audioCoverage?: AudioCoverage;
	sourceUrls: string[];
	updatedAt: string | null;
}

/** A volume with no audiobook edition never puts a listener behind. */
export function workHasAudio(work: CatalogWork): boolean {
	return work.hasAudio !== false;
}
export function audioAvailable(work: CatalogWork, today = new Date().toISOString().slice(0, 10)): boolean {
	return workHasAudio(work) && !!work.audioReleaseDate && work.audioReleaseDate <= today;
}
/** Audio is coming but has not landed yet. */
export function audioUpcoming(work: CatalogWork, today = new Date().toISOString().slice(0, 10)): boolean {
	return workHasAudio(work) && !!work.audioReleaseDate && work.audioReleaseDate > today;
}
/** An audiobook exists but we have no date, so we cannot claim a listener is current. */
export function audioUndated(work: CatalogWork): boolean {
	return workHasAudio(work) && !work.audioReleaseDate;
}

export interface WorkRelease {
	state: 'released' | 'scheduled' | 'unknown';
	date: string | null;
	/** The state came from reviewed coverage rather than a catalogued row date. */
	verified: boolean;
}
/** The single answer to "is this audiobook out?", used by progress, bulk actions and labels
 * alike. They disagreed before: progress trusted coverage while marking and the row controls
 * trusted `work.audioReleaseDate`, so a stale future row date on a verified-released book left
 * a reader unable to mark it and therefore unable to ever be current.
 *
 * Coverage is authoritative and its dates are not the row's. A verified release is durable; a
 * schedule needs its own freshness; a work coverage flags or does not vouch for reads as unknown
 * rather than inheriting an old date. Only a missing or unusable manifest falls back to the
 * catalogued date — a merely stale or incomplete coverage does NOT — so an unmanifested
 * catalogue is not flattened to all-unknown while a corrected date is never resurrected. */
export function workRelease(series: CatalogSeries, work: CatalogWork, now = new Date().toISOString()): WorkRelease {
	const coverage = series.audioCoverage;
	const fromRow = (): WorkRelease => (!workHasAudio(work) || !work.audioReleaseDate
		? { state: 'unknown', date: null, verified: false }
		: { state: work.audioReleaseDate <= now.slice(0, 10) ? 'released' : 'scheduled', date: work.audioReleaseDate, verified: false });

	// Only a genuinely absent or unusable manifest defers to the catalogued row date. Anything
	// else has already corrected these rows, and falling back would resurrect what it corrected.
	const unusable = !coverage || coverage.manifestId === null
		|| coverage.issues.some((problem) => problem.code === 'missing-manifest' || problem.code === 'invalid-manifest');
	if (unusable) return fromRow();

	const covered = coverage!.works.find((entry) => entry.workId === work.id);
	const flagged = coverage!.issues.some((problem) => problem.workId === work.id);

	// A verified release is durable. Evidence ageing does not un-publish an audiobook, so this
	// survives the coverage going stale or another book making the coverage incomplete.
	if (covered?.state === 'released' || coverage!.releasedWorkIds.includes(work.id)) {
		return { state: 'released', date: covered?.releaseDate ?? null, verified: true };
	}
	// A schedule is a claim about the future. It needs its own freshness, and it must never
	// become "released" merely because the clock passed the date with no new observation.
	if (covered?.state === 'scheduled' || coverage!.scheduledWorkIds.includes(work.id)) {
		const fresh = isAudioCoverageCurrent(coverage, now) && !flagged;
		return { state: fresh ? 'scheduled' : 'unknown', date: covered?.releaseDate ?? null, verified: true };
	}
	// A work the reviewed list flags, or simply does not vouch for, keeps no inherited date.
	return { state: 'unknown', date: null, verified: true };
}
export const workReleased = (series: CatalogSeries, work: CatalogWork, now?: string) => workRelease(series, work, now).state === 'released';

/** Numbered volumes carry the story. Anthologies, shorts and side entries arrive unnumbered
 * and must never make a caught-up listener look behind. A series with no numbering at all
 * (a standalone, or one the source never numbered) treats everything it has as mainline. */
const COLLECTION_TITLE = /omnibus|compilation|box ?set|complete (series|collection|saga|compilation)|books? \d+\s*(?:[-–—]|through|thru|to)\s*\d+|novellas? \d+\s*[-–—]\s*\d+/i;
/** Prefer the real volume over an omnibus that claims the same number. A bundle is usually
 * titled after the series itself — "Glendaria Awakens Trilogy" beside "Dungeon Player" — so a
 * work whose title just restates the series name is the weaker candidate. */
const preferMainline = (series: CatalogSeries) => {
	const seriesName = normalizeIdentity(series.title ?? '');
	const restatesSeries = (work: CatalogWork) => seriesName.length > 0 && normalizeIdentity(work.title) === seriesName;
	return (a: CatalogWork, b: CatalogWork) =>
		Number(b.verified) - Number(a.verified) ||
		Number(COLLECTION_TITLE.test(a.title)) - Number(COLLECTION_TITLE.test(b.title)) ||
		Number(restatesSeries(a)) - Number(restatesSeries(b)) ||
		b.editionIds.length - a.editionIds.length ||
		a.title.length - b.title.length ||
		a.id.localeCompare(b.id);
};

export function mainlineWorks(series: CatalogSeries): CatalogWork[] {
	const numbered = series.works.filter((w) => w.number != null);
	if (!numbered.length) return series.works;
	// A compilation listed as volume 1 alongside the real volume 1 would otherwise add a second
	// mainline book, inflating the denominator so the series can never read as fully read.
	const byNumber = new Map<number, CatalogWork[]>();
	for (const work of numbered) byNumber.set(work.number!, [...(byNumber.get(work.number!) ?? []), work]);
	return [...byNumber.values()]
		.map((group) => (group.length === 1 ? group[0] : [...group].sort(preferMainline(series))[0]))
		.sort((a, b) => a.number! - b.number! || a.title.localeCompare(b.title));
}
export function sideWorks(series: CatalogSeries): CatalogWork[] {
	const mainline = new Set(mainlineWorks(series).map((w) => w.id));
	return series.works.filter((w) => !mainline.has(w.id));
}

/** Group only full audiobooks. Adaptations and collections remain in the releases catalog. */
export function groupSeries(books: CatalogBook[], overrides: Partial<CatalogSeries>[] = [], canonical: Map<string, CatalogWork> = new Map()): CatalogSeries[] {
	const groups = new Map<string, CatalogBook[]>();
	// An explicit retailer Podcast type is not a full audiobook, whatever the edition column
	// says, so it can never become a mainline volume.
	const audio = books.filter((b) => b.edition === 'audiobook' && explicitEditionKind(b) !== 'podcast');
	// Collapse duplicates per work rather than up front. A hidden placeholder must still
	// contribute its id as an edition alias, or a read saved against that id disappears.
	// It is only ever an alias: it can never become the work's representative edition.
	const substantive = new Set(collapsePlaceholderDuplicates(audio).map((b) => b.id));
	for (const book of audio) {
		const key = book.seriesKey || book.id;
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(book);
	}
	return [...groups].map(([id, entries]) => {
		const supplied = overrides.find((s) => s.id === id);
		const byWork = new Map<string, CatalogBook[]>();
		for (const book of entries) {
			// Unverified titles with conflicting volume numbers remain separate until reviewed.
			const key = book.workId ?? `work-legacy-${id}-${book.seriesNumber ?? book.id}-${normalizeIdentity(book.title.split(':')[0]).slice(0, 70)}`;
			(byWork.get(key) ?? byWork.set(key, []).get(key)!).push(book);
		}
		const works: CatalogWork[] = [...byWork]
			.map(([workId, editions]) => {
				// Facts come from real editions; ids come from every edition, hidden ones included.
				const real = editions.filter((b) => substantive.has(b.id));
				const pool = real.length ? real : editions;
				const best = [...pool].sort((a, b) => bookPopularity(b) - bookPopularity(a) || Number(!a.coverUrl) - Number(!b.coverUrl) || a.id.localeCompare(b.id))[0];
				const known = canonical.get(workId);
				const date = pool.flatMap((b) => (b.releaseDate ? [b.releaseDate] : [])).sort()[0] ?? null;
				return {
					id: workId,
					title: known?.title ?? best.title,
					number: known?.number ?? best.seriesNumber,
					bookId: best.id,
					editionIds: [...new Set([...(known?.editionIds ?? []), ...editions.map((b) => b.id)])],
					audioReleaseDate: date,
					verified: known?.verified ?? false,
					hasAudio: true
				};
			})
			.sort((a, b) => (a.number ?? 9999) - (b.number ?? 9999) || (a.audioReleaseDate ?? '').localeCompare(b.audioReleaseDate ?? '') || a.title.localeCompare(b.title));
		const first = entries.find((b) => b.id === works[0]?.bookId) ?? entries[0];
		return {
			id,
			title: supplied?.title || first.series || first.title,
			author: supplied?.author ?? first.author,
			aliases: supplied?.aliases ?? [],
			description: supplied?.description ?? '',
			features: supplied?.features,
			featureEvidence: supplied?.featureEvidence,
			genres: supplied?.genres ?? [...new Set(entries.flatMap((b) => b.subgenres))],
			coverBookId: works[0]?.bookId ?? first.id,
			works,
			curated: supplied?.curated ?? false,
			status: supplied?.status ?? 'unknown',
			audioCoverage: supplied?.audioCoverage,
			sourceUrls: supplied?.sourceUrls ?? [],
			updatedAt: supplied?.updatedAt ?? null
		};
	});
}

/** Volume numbers the catalog is missing outright. A gap means we cannot assert a listener
 * is current, because the missing volume may already be out. Never fill these in. */
export function seriesGaps(series: CatalogSeries): number[] {
	const nums = series.works.map((w) => w.number).filter((n): n is number => n != null && Number.isInteger(n) && n > 0 && n < 200);
	if (!nums.length) return [];
	const known = new Set(nums);
	return Array.from({ length: Math.max(...nums) }, (_, i) => i + 1).filter((n) => !known.has(n));
}

export function searchSeries(series: CatalogSeries[], books: Map<string, CatalogBook>, query: string): CatalogSeries[] {
	const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
	if (!terms.length) return series;
	return series.filter((s) => {
		const haystack = [s.title, s.author, ...s.aliases, ...s.genres, ...s.works.flatMap((w) => [w.title, books.get(w.bookId)?.narrator ?? ''])].join(' ').toLowerCase();
		return terms.every((t) => haystack.includes(t));
	});
}

/** Resolve any catalog book id — work id or edition id — back to its series and work.
 *
 * Pass `books` to reconcile audiobooks the supplied series list left out. An edition missing
 * from every work is not cosmetic: a read saved against that id stops counting and the reader
 * silently loses progress. Reconciliation is deliberately narrow — same series, same volume
 * number, audiobook only — so it can never join unrelated titles that share a name. */
export function workIndex(series: CatalogSeries[], books: CatalogBook[] = []): Map<string, { series: CatalogSeries; work: CatalogWork }> {
	const index = new Map<string, { series: CatalogSeries; work: CatalogWork }>();
	for (const s of series) for (const work of s.works) for (const id of [work.id, work.bookId, ...work.editionIds]) index.set(id, { series: s, work });
	if (!books.length) return index;
	const bySeries = new Map(series.map((s) => [s.id, s]));
	for (const book of books) {
		if (book.edition !== 'audiobook' || book.seriesNumber == null || index.has(book.id)) continue;
		const parent = bySeries.get(book.seriesKey);
		const work = parent?.works.find((w) => w.number === book.seriesNumber);
		if (parent && work) index.set(book.id, { series: parent, work });
	}
	return index;
}

/** A standalone book arrives as a one-work series with no series name. Fall back to the book's
 * own title so it never renders as a blank card. */
export function seriesTitle(series: CatalogSeries, books: Map<string, CatalogBook>): string {
	return series.title?.trim() || seriesStarter(series, books)?.title?.trim() || 'Untitled';
}

/** The book that stands for a series when discovery eligibility does not apply — the library,
 * where a followed series must stay visible whatever the reader's discovery preferences are.
 * Discovery itself uses `seriesEntry` from recommendations.ts, which resolves volume 1. */
export function seriesStarter(series: CatalogSeries, books: Map<string, CatalogBook>): CatalogBook | undefined {
	const first = mainlineWorks(series)[0] ?? series.works[0];
	return (first && books.get(first.bookId)) ?? books.get(series.coverBookId);
}
/** Individual audiobook editions matching a search, for when a real query finds no series.
 * Takes the already-filtered pool so every content, genre and review preference still applies.
 * These are editions, never discovery starters: they must not stand in for a missing book 1. */
export function matchingAudiobooks(visible: readonly CatalogBook[], query: string, genre = 'all', limit = 24): CatalogBook[] {
	if (!query.trim()) return [];
	const pool = visible.filter((book) => book.edition === 'audiobook' && explicitEditionKind(book) !== 'podcast'
		&& (genre === 'all' || book.subgenres.includes(genre)));
	return searchBooks(pool, query).sort((a, b) => bookPopularity(b) - bookPopularity(a) || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Resolve a series reference from a URL, which may be a canonical id or an alias left over
 * from before a rename. Collision-safe by construction: a canonical id always wins, an alias
 * that is itself some series' id is ignored so it can never shadow the real one, and an alias
 * claimed by two different series resolves to nothing rather than guessing. */
export function resolveSeriesRef(series: readonly CatalogSeries[], ref: string): CatalogSeries | null {
	if (!ref) return null;
	const byId = new Map(series.map((s) => [s.id, s]));
	const direct = byId.get(ref);
	if (direct) return direct;
	let found: CatalogSeries | null = null;
	for (const candidate of series) {
		for (const raw of candidate.aliases ?? []) {
			const alias = typeof raw === 'string' ? raw.trim() : '';
			if (alias !== ref || byId.has(alias)) continue;
			if (found && found.id !== candidate.id) return null;
			found = candidate;
		}
	}
	return found;
}

/** Rank a series by its strongest book so the cover grid leads with what people actually read. */
export function seriesPopularity(series: CatalogSeries, books: Map<string, CatalogBook>): number {
	return Math.max(0, ...series.works.flatMap((w) => {
		const book = books.get(w.bookId);
		return book ? [bookPopularity(book)] : [];
	}));
}
/** Most recent audiobook that has actually landed, for "last release" on a card. */
export function latestAudioRelease(series: CatalogSeries, now = new Date().toISOString()): string | null {
	return series.works.flatMap((w) => { const r = workRelease(series, w, now); return r.state === 'released' && r.date ? [r.date] : []; }).sort().pop() ?? null;
}
export function nextAudioRelease(series: CatalogSeries, now = new Date().toISOString()): CatalogWork | null {
	return series.works
		.flatMap((w) => { const r = workRelease(series, w, now); return r.state === 'scheduled' && r.date ? [{ work: w, date: r.date }] : []; })
		.sort((a, b) => a.date.localeCompare(b.date))[0]?.work ?? null;
}
