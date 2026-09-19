import { describe, expect, it } from 'vitest';
import { defaultFilters, passesFilters, type CatalogBook, type ContentSignal } from './catalog.js';
import { groupSeries, mainlineWorks, searchSeries, latestAudioRelease, matchingAudiobooks, resolveSeriesRef, seriesGaps, seriesStarter, seriesTitle, sideWorks, workRelease, workIndex, type CatalogSeries, type CatalogWork } from './series.js';
import { eligibleSeriesEntries, seriesEntry } from './recommendations.js';
import type { AudioCoverage } from './audio-coverage.js';
import {
	emptyLibrary, followSeries, libraryExport, markReadThrough, markSeriesRead, mergeLibraries, migrateLibrary, parseLibrary,
	parseLibraryExport, parseSeriesLibrary, seriesProgress, setWorkRating, setWorkStatus, workEntry,
	type Library, type SeriesLibrary
} from './library.js';

const TODAY = '2026-09-18';
const unknownSignal = (): ContentSignal => ({ verdict: 'unknown', confidence: 0, source: 'unknown', note: '' });
const content = (): CatalogBook['content'] => ({
	sexualized: unknownSignal(), explicit: unknownSignal(), harem: unknownSignal(),
	aiNarration: unknownSignal(), aiWriting: unknownSignal(), quality: unknownSignal()
});
const makeBook = (fields: Partial<CatalogBook> = {}): CatalogBook => ({
	id: 'BOOK000001', title: 'Dungeon Crawler Carl', subtitle: '', author: 'Matt Dinniman', narrator: 'Jeff Hays',
	series: 'Dungeon Crawler Carl', seriesKey: 'dcc--mattdinniman', seriesNumber: 1, releaseDate: '2021-01-28',
	coverUrl: null, runtimeMinutes: 900, subgenres: ['litrpg'], description: 'A dungeon, a cat, and a lot of noise.',
	url: null, rating: 4.8, ratingCount: 5000, edition: 'audiobook', scope: 'indexed',
	sources: [{ name: 'audible', fetchedAt: '2026-09-01T00:00:00.000Z' }], issues: [], assessment: null, content: content(),
	...fields
});
/** Two ASINs per volume is the normal shape of this catalog, so fixtures mirror it. */
const volume = (n: number, title: string, releaseDate: string | null, extra: Partial<CatalogBook> = {}) => [
	makeBook({ id: `ASIN${n}A`, seriesNumber: n, title, releaseDate, ratingCount: 5000, ...extra }),
	makeBook({ id: `ASIN${n}B`, seriesNumber: n, title, releaseDate, ratingCount: 10, ...extra })
];
const only = (series: CatalogSeries[]) => {
	expect(series).toHaveLength(1);
	return series[0];
};
const NOW = '2026-09-18T12:00:00.000Z';
/** Reviewed audio coverage, still inside its freshness window. Not `status`, which is about the
 * story: a finished story is routinely still mid-way through audio production. Without this the
 * app will not claim currency, so read-state tests say so explicitly rather than by accident. */
const covered = (series: CatalogSeries, over: Partial<AudioCoverage> = {}): CatalogSeries => {
	// Mirror the assessor: the window is capped at the next scheduled release, so a schedule
	// can never outlive the evidence that predicted it.
	const nextRelease = mainlineWorks(series)
		.flatMap((w) => (w.audioReleaseDate && w.audioReleaseDate > TODAY ? [`${w.audioReleaseDate}T00:00:00.000Z`] : []))
		.sort()[0];
	return ({
	...series,
	audioCoverage: {
		status: 'verified', current: true, assessedAt: '2026-09-18T00:00:00.000Z',
		manifestId: 'manifest-1', scope: 'numbered-mainline', language: 'en', marketplaces: ['US'],
		verifiedAt: '2026-09-17T00:00:00.000Z', validUntil: [nextRelease, '2026-09-24T00:00:00.000Z'].filter(Boolean).sort()[0],
		expectedNumbers: mainlineWorks(series).map((w) => w.number!).filter((n) => n != null),
		releasedWorkIds: mainlineWorks(series).filter((w) => w.audioReleaseDate && w.audioReleaseDate <= TODAY).map((w) => w.id),
		scheduledWorkIds: mainlineWorks(series).filter((w) => w.audioReleaseDate && w.audioReleaseDate > TODAY).map((w) => w.id),
		works: [], sourceUrls: [], issues: [], ...over
	}
});
};
const finished = covered;

describe('series grouping', () => {
	it('treats both ASINs of one volume as a single work so progress is not double counted', () => {
		const series = only(groupSeries([...volume(1, 'Dungeon Crawler Carl', '2021-01-28'), ...volume(2, "Carl's Doomsday Scenario", '2021-04-22')]));
		expect(series.works).toHaveLength(2);
		expect(series.works[0].editionIds.sort()).toEqual(['ASIN1A', 'ASIN1B']);
		expect(series.works[0].bookId).toBe('ASIN1A');
	});
	it('keeps full-cast editions and collections out of the mainline volume count', () => {
		const series = only(groupSeries([
			...volume(1, 'Dungeon Crawler Carl', '2021-01-28'),
			makeBook({ id: 'DRAMA1', title: 'Dungeon Crawler Carl: Full Cast', edition: 'dramatized', seriesNumber: 1, releaseDate: '2025-06-01' }),
			makeBook({ id: 'COLL1', title: 'Dungeon Crawler Carl: Books 1-3', edition: 'collection', seriesNumber: null, releaseDate: '2024-01-01' })
		]));
		expect(series.works).toHaveLength(1);
		expect(series.works.flatMap((w) => w.editionIds)).not.toContain('DRAMA1');
		expect(series.works.flatMap((w) => w.editionIds)).not.toContain('COLL1');
	});
	it('files unnumbered anthologies as side entries rather than extra mainline books', () => {
		const series = only(groupSeries([
			...volume(1, 'A Thousand Li: The First Step', '2020-01-01'),
			...volume(2, 'A Thousand Li: The First Stop', '2020-06-01'),
			makeBook({ id: 'SHORTS', title: 'Short Story Anthology, Volume 1', seriesNumber: null, releaseDate: '2020-03-01' })
		]));
		expect(mainlineWorks(series).map((w) => w.number)).toEqual([1, 2]);
		expect(sideWorks(series).map((w) => w.title)).toEqual(['Short Story Anthology, Volume 1']);
	});
	it('treats an entirely unnumbered series as mainline so a standalone is still trackable', () => {
		const series = only(groupSeries([makeBook({ id: 'SOLO', seriesNumber: null, title: 'A standalone' })]));
		expect(mainlineWorks(series)).toHaveLength(1);
		expect(sideWorks(series)).toHaveLength(0);
	});
	it('reports volume numbers the catalog is missing without inventing them', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(4, 'Four', '2023-01-01')]));
		expect(seriesGaps(series)).toEqual([2, 3]);
		expect(series.works.map((w) => w.number)).toEqual([1, 4]);
	});
	it('searches series by narrator and alias as well as title', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01')]));
		const books = new Map([['ASIN1A', makeBook({ id: 'ASIN1A', narrator: 'Jeff Hays' })]]);
		expect(searchSeries([{ ...series, aliases: ['crawler'] }], books, 'jeff hays')).toHaveLength(1);
		expect(searchSeries([{ ...series, aliases: ['crawler'] }], books, 'crawler')).toHaveLength(1);
		expect(searchSeries([series], books, 'nonexistent')).toHaveLength(0);
	});
	it('resolves any edition id back to its series and work', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01')]));
		const index = workIndex([series]);
		expect(index.get('ASIN1B')?.work.id).toBe(series.works[0].id);
		expect(index.get('ASIN1B')?.series.id).toBe(series.id);
	});
});

const carl = () => only(groupSeries([
	...volume(1, 'Dungeon Crawler Carl', '2021-01-28'),
	...volume(2, "Carl's Doomsday Scenario", '2021-04-22'),
	...volume(3, "The Dungeon Anarchist's Cookbook", '2021-05-14')
]));

describe('migrating a v1 shelf', () => {
	it('carries edition-keyed reads forward and follows the series they belong to', () => {
		const series = carl();
		const legacy: Library = { ASIN1B: { status: 'read', rating: 5, updatedAt: '2025-03-01T00:00:00.000Z' } };
		const migrated = migrateLibrary(legacy, [series]);
		expect(migrated.version).toBe(2);
		expect(migrated.series[series.id].followedAt).toBe('2025-03-01T00:00:00.000Z');
		// The read was recorded against the less popular ASIN; the work still counts as read.
		expect(workEntry(migrated, series.works[0])?.status).toBe('read');
		expect(workEntry(migrated, series.works[0])?.rating).toBe(5);
		expect(seriesProgress(migrated, series, NOW).read).toBe(1);
	});
	it('leaves the v1 record untouched so it stays a working backup', () => {
		const series = carl();
		const legacy: Library = { ASIN1A: { status: 'read', rating: null, updatedAt: '2025-03-01T00:00:00.000Z' } };
		const snapshot = structuredClone(legacy);
		const migrated = migrateLibrary(legacy, [series]);
		migrated.books.ASIN2A = { status: 'read', rating: null, updatedAt: '2026-01-01T00:00:00.000Z' };
		expect(legacy).toEqual(snapshot);
	});
	it('keeps history for books that no longer match any series', () => {
		const migrated = migrateLibrary({ GONE123: { status: 'read', rating: 4, updatedAt: '2024-01-01T00:00:00.000Z' } }, [carl()]);
		expect(migrated.books.GONE123.rating).toBe(4);
		expect(migrated.series).toEqual({});
	});
	it('does not re-import v1 once a v2 record exists', () => {
		const series = carl();
		const current = setWorkStatus(emptyLibrary(), series, series.works[0], 'read', '2026-05-01T00:00:00.000Z');
		const migrated = migrateLibrary({ ASIN3A: { status: 'read', rating: null, updatedAt: '2020-01-01T00:00:00.000Z' } }, [series], current);
		expect(migrated.books.ASIN3A).toBeUndefined();
		expect(seriesProgress(migrated, series, NOW).read).toBe(1);
	});
	it('moves a followed series onto its canonical id when the catalog renames it', () => {
		const series = { ...carl(), id: 'dcc-canonical', aliases: ['dcc--mattdinniman'] };
		const current: SeriesLibrary = { version: 2, series: { 'dcc--mattdinniman': { followedAt: '2025-01-01T00:00:00.000Z' } }, books: {} };
		const migrated = migrateLibrary({}, [series], current);
		expect(migrated.series['dcc-canonical'].followedAt).toBe('2025-01-01T00:00:00.000Z');
		expect(migrated.series['dcc--mattdinniman']).toBeUndefined();
	});
	it('is idempotent', () => {
		const series = carl();
		const legacy: Library = { ASIN1A: { status: 'read', rating: null, updatedAt: '2025-03-01T00:00:00.000Z' } };
		const once = migrateLibrary(legacy, [series]);
		expect(migrateLibrary(legacy, [series], once)).toEqual(once);
	});
});

describe('up to date on released audiobooks', () => {
	it('is up to date only once every released volume is read', () => {
		const series = finished(carl());
		let library = emptyLibrary();
		expect(seriesProgress(library, series, NOW).state).toBe('not-started');
		library = setWorkStatus(library, series, series.works[0], 'read');
		expect(seriesProgress(library, series, NOW)).toMatchObject({ read: 1, total: 3, remaining: 2, caughtUp: false, state: 'in-progress' });
		library = markSeriesRead(library, series, TODAY);
		expect(seriesProgress(library, series, NOW)).toMatchObject({ read: 3, remaining: 0, caughtUp: true, state: 'caught-up', nextUnread: null });
	});
	it('does not turn a scheduled book into a released one just because the clock advanced', () => {
		const base = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2026-09-20')]));
		const series = covered(base, { releasedWorkIds: [base.works[0].id], scheduledWorkIds: [base.works[1].id] });
		const library = markSeriesRead(emptyLibrary(), series, NOW);
		expect(seriesProgress(library, series, NOW)).toMatchObject({ caughtUp: true, total: 1, upcoming: 1 });

		// Past the scheduled date with no new observation: unknown, never auto-released.
		const later = '2026-09-21T12:00:00.000Z';
		expect(workRelease(series, base.works[1], later)).toMatchObject({ state: 'unknown', verified: true });
		expect(seriesProgress(library, series, later)).toMatchObject({ caughtUp: false, total: 1 });

		// Only a fresh assessment that verifies the release puts it back on the reader's plate.
		const reassessed = covered(base, {
			releasedWorkIds: base.works.map((w) => w.id), scheduledWorkIds: [],
			assessedAt: '2026-09-21T00:00:00.000Z', validUntil: '2026-09-28T00:00:00.000Z'
		});
		expect(seriesProgress(library, reassessed, later)).toMatchObject({ caughtUp: false, total: 2, read: 1, remaining: 1 });
	});
	it('does not count an announced volume as something to catch up on', () => {
		const series = finished(only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2027-01-01')])));
		const library = setWorkStatus(emptyLibrary(), series, series.works[0], 'read');
		expect(seriesProgress(library, series, NOW).caughtUp).toBe(true);
	});
	it('never lets an ebook-only volume put a listener behind', () => {
		const series = carl();
		const withEbook: CatalogSeries = { ...finished(series), works: [...series.works, { id: 'work-ebook-4', title: 'Four', number: 4, bookId: 'EBOOK4', editionIds: ['EBOOK4'], audioReleaseDate: null, verified: true, hasAudio: false }] };
		const library = markSeriesRead(emptyLibrary(), withEbook, TODAY);
		expect(seriesGaps(withEbook)).toEqual([]);
		expect(seriesProgress(library, withEbook, NOW)).toMatchObject({ caughtUp: true, total: 3, undated: 0 });
	});
	it('will not claim up to date while a volume is missing from the catalog', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(3, 'Three', '2023-01-01')]));
		const library = markSeriesRead(emptyLibrary(), series, TODAY);
		const progress = seriesProgress(library, series, NOW);
		// The reader has finished everything we hold, so they are not "behind" either.
		expect(progress).toMatchObject({ read: 2, total: 2, caughtUp: false, gaps: [2], state: 'caught-up-partial' });
		expect(progress.unresolved).toContain('Book 2 is missing from the catalog');
	});
	it('will not claim up to date while an audiobook has no known release date', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', null)]));
		const library = markSeriesRead(emptyLibrary(), series, TODAY);
		expect(seriesProgress(library, series, NOW)).toMatchObject({ caughtUp: false, undated: 1, state: 'caught-up-partial' });
		// Reading it resolves that ambiguity, but currency still needs reviewed coverage.
		const after = setWorkStatus(library, series, series.works.find((w) => w.number === 2)!, 'read');
		expect(seriesProgress(after, series, NOW)).toMatchObject({ caughtUp: false, undated: 0, state: 'caught-up-partial' });
		// Coverage can vouch for a release our own row never dated.
		const vouched = covered(series, { releasedWorkIds: series.works.map((w) => w.id) });
		expect(seriesProgress(after, vouched, NOW)).toMatchObject({ caughtUp: true, state: 'caught-up' });
	});
	it('keeps side stories out of the mainline count but will not claim up to date while one is unread', () => {
		const series = only(groupSeries([
			...volume(1, 'One', '2021-01-01'),
			makeBook({ id: 'SHORTS', title: 'Short Story Anthology', seriesNumber: null, releaseDate: '2021-06-01' })
		]));
		let library = markSeriesRead(emptyLibrary(), series, TODAY);
		// The anthology never inflates the mainline total, but bulk marking does cover it.
		expect(seriesProgress(library, series, NOW)).toMatchObject({ total: 1, side: { read: 1, total: 1 } });
		library = setWorkStatus(library, series, sideWorks(series)[0], '');
		// Without reviewed coverage an unnumbered entry may be a mainline volume the source
		// failed to number, so we stop short of claiming currency.
		const progress = seriesProgress(library, series, NOW);
		expect(progress).toMatchObject({ caughtUp: false, total: 1, state: 'caught-up-partial', side: { read: 0, total: 1 } });
		expect(progress.unresolved).toContain('1 unnumbered entry is unread');
		// A reviewed manifest scopes the series to its numbered mainline, so a side story is
		// out of scope and cannot hold back currency.
		expect(seriesProgress(library, covered(series), NOW)).toMatchObject({ caughtUp: true, state: 'caught-up' });
	});
	it('separates being current from being behind', () => {
		const behind = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2022-01-01')]));
		expect(seriesProgress(setWorkStatus(emptyLibrary(), behind, behind.works[0], 'read'), behind, NOW)).toMatchObject({ state: 'in-progress', remaining: 1 });
		const partial = only(groupSeries([...volume(2, 'Two', '2022-01-01')]));
		expect(seriesProgress(markSeriesRead(emptyLibrary(), partial, NOW), partial, NOW)).toMatchObject({ state: 'caught-up-partial', remaining: 0, nextUnread: null });
	});
	it('marks a series in progress while a volume is being listened to', () => {
		const series = carl();
		const library = setWorkStatus(emptyLibrary(), series, series.works[0], 'reading');
		expect(seriesProgress(library, series, NOW).state).toBe('in-progress');
	});
});

describe('following and per-book controls', () => {
	it('follows a series when a book is marked and keeps history after unfollowing', () => {
		const series = carl();
		let library = setWorkRating(emptyLibrary(), series, series.works[0], 5, '2026-01-01T00:00:00.000Z');
		expect(library.series[series.id]).toBeDefined();
		library = setWorkStatus(library, series, series.works[1], 'read', '2026-02-01T00:00:00.000Z');
		library = followSeries(library, series.id, false);
		expect(library.series[series.id]).toBeUndefined();
		expect(workEntry(library, series.works[0])?.rating).toBe(5);
		expect(seriesProgress(library, series, NOW).read).toBe(2);
	});
	it('keeps a rating when the status changes and keeps the status when the rating changes', () => {
		const series = carl();
		let library = setWorkRating(emptyLibrary(), series, series.works[0], 4);
		expect(workEntry(library, series.works[0])).toMatchObject({ status: 'read', rating: 4 });
		library = setWorkStatus(library, series, series.works[0], 'paused');
		expect(workEntry(library, series.works[0])).toMatchObject({ status: 'paused', rating: 4 });
		library = setWorkRating(library, series, series.works[0], 2);
		expect(workEntry(library, series.works[0])).toMatchObject({ status: 'paused', rating: 2 });
	});
	it('clears every edition alias so an old read cannot reappear', () => {
		const series = carl();
		const legacy: Library = { ASIN1B: { status: 'read', rating: null, updatedAt: '2025-01-01T00:00:00.000Z' } };
		let library = migrateLibrary(legacy, [series]);
		library = setWorkStatus(library, series, series.works[0], '');
		expect(workEntry(library, series.works[0])).toBeUndefined();
		expect(seriesProgress(library, series, NOW).read).toBe(0);
	});
	it('does not follow a series just because a stale entry was cleared', () => {
		const series = carl();
		const library = setWorkStatus(emptyLibrary(), series, series.works[0], '');
		expect(library.series[series.id]).toBeUndefined();
	});
	it('marks only released volumes in bulk and preserves existing ratings', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2027-01-01')]));
		let library = setWorkRating(emptyLibrary(), series, series.works[0], 3);
		library = markSeriesRead(library, series, TODAY);
		expect(workEntry(library, series.works[0])).toMatchObject({ status: 'read', rating: 3 });
		expect(workEntry(library, series.works[1])).toBeUndefined();
	});
});

describe('stored and exported records', () => {
	it('round trips a v2 export', () => {
		const series = carl();
		const library = markSeriesRead(emptyLibrary(), series, TODAY);
		const restored = parseLibraryExport(JSON.parse(JSON.stringify(libraryExport(library))), [series]);
		expect(restored).toEqual(library);
	});
	it('accepts the original v1 shelf export', () => {
		const series = carl();
		const restored = parseLibraryExport({ version: 1, exportedAt: '2025-01-01T00:00:00.000Z', library: { ASIN2A: { status: 'read', rating: 4, updatedAt: '2025-01-01T00:00:00.000Z' } } }, [series]);
		expect(restored?.version).toBe(2);
		expect(seriesProgress(restored!, series, NOW).read).toBe(1);
	});
	it('rejects a file that is not a library export', () => {
		expect(parseLibraryExport({ version: 3, library: {} }, [])).toBeNull();
		expect(parseLibraryExport({ books: [] }, [])).toBeNull();
		expect(parseSeriesLibrary({ version: 2, series: [], books: {} })).toBeNull();
	});
	it('merges an import without losing newer local progress', () => {
		const series = carl();
		const local = setWorkStatus(emptyLibrary(), series, series.works[0], 'read', '2026-06-01T00:00:00.000Z');
		const incoming = setWorkStatus(emptyLibrary(), series, series.works[0], 'want', '2025-01-01T00:00:00.000Z');
		const merged = mergeLibraries(local, incoming);
		expect(workEntry(merged, series.works[0])?.status).toBe('read');
		expect(merged.series[series.id].followedAt).toBe('2025-01-01T00:00:00.000Z');
	});
	it('rejects unsafe ids and out of range ratings from stored data', () => {
		// Parsed from JSON so `__proto__` is a real own key, the way a hostile export would carry it.
		const parsed = parseLibrary(JSON.parse(`{
			"__proto__": { "status": "read", "rating": 5, "updatedAt": "2025-01-01T00:00:00.000Z" },
			"constructor": { "status": "read", "rating": 5, "updatedAt": "2025-01-01T00:00:00.000Z" },
			"bad id!": { "status": "read", "rating": 5, "updatedAt": "2025-01-01T00:00:00.000Z" },
			"GOOD1": { "status": "nonsense", "rating": 5, "updatedAt": "2025-01-01T00:00:00.000Z" },
			"GOOD2": { "status": "read", "rating": 99, "updatedAt": "2025-01-01T00:00:00.000Z" }
		}`));
		expect(Object.keys(parsed)).toEqual(['GOOD2']);
		expect(parsed.GOOD2.rating).toBeNull();
		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
	});
});

describe('joining a series part-way through', () => {
	it('records everything up to the chosen volume in one action', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2022-01-01'), ...volume(3, 'Three', '2023-01-01')]));
		const library = markReadThrough(emptyLibrary(), series, series.works[1], TODAY);
		expect(seriesProgress(library, series, NOW)).toMatchObject({ read: 2, remaining: 1, state: 'in-progress' });
		expect(workEntry(library, series.works[2])).toBeUndefined();
		expect(library.series[series.id]).toBeDefined();
	});
	it('never marks an unreleased audiobook even when it sits before the cutoff', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2027-01-01'), ...volume(3, 'Three', '2023-01-01')]));
		const library = markReadThrough(emptyLibrary(), series, series.works[2], TODAY);
		expect(workEntry(library, series.works.find((w) => w.number === 2)!)).toBeUndefined();
		expect(seriesProgress(library, series, NOW).read).toBe(2);
	});
	it('leaves unnumbered side entries alone', () => {
		const series = only(groupSeries([
			...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2022-01-01'),
			makeBook({ id: 'SHORTS', title: 'Anthology', seriesNumber: null, releaseDate: '2021-06-01' })
		]));
		const library = markReadThrough(emptyLibrary(), series, mainlineWorks(series)[1], TODAY);
		expect(workEntry(library, sideWorks(series)[0])).toBeUndefined();
		expect(seriesProgress(library, series, NOW).read).toBe(2);
	});
	it('preserves ratings already recorded on earlier volumes', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2022-01-01')]));
		let library = setWorkRating(emptyLibrary(), series, series.works[0], 5);
		library = markReadThrough(library, series, series.works[1], TODAY);
		expect(workEntry(library, series.works[0])).toMatchObject({ status: 'read', rating: 5 });
	});
});

describe('hidden duplicate editions', () => {
	// A placeholder carries no sources, runtime or ratings, so the catalog hides it from listings.
	const placeholder = (id: string, n: number, title: string, date: string) =>
		makeBook({ id, seriesNumber: n, title, releaseDate: date, sources: [], runtimeMinutes: null, ratingCount: 0, rating: null });

	it('keeps a hidden duplicate as an edition alias so a saved read survives', () => {
		const series = finished(only(groupSeries([...volume(1, 'One', '2021-01-01'), placeholder('OLD1', 1, 'One', '2021-01-01')])));
		expect(series.works).toHaveLength(1);
		expect(series.works[0].editionIds).toContain('OLD1');
		// The read was recorded against the id the catalog later hid.
		const migrated = migrateLibrary({ OLD1: { status: 'read', rating: 4, updatedAt: '2025-01-01T00:00:00.000Z' } }, [series]);
		expect(workEntry(migrated, series.works[0])).toMatchObject({ status: 'read', rating: 4 });
		expect(seriesProgress(migrated, series, NOW)).toMatchObject({ read: 1, caughtUp: true });
	});
	it('never lets a hidden duplicate become the representative edition', () => {
		const series = only(groupSeries([placeholder('OLD1', 1, 'One', '2021-01-01'), ...volume(1, 'One', '2021-01-01')]));
		expect(series.works[0].bookId).toBe('ASIN1A');
		expect(series.coverBookId).toBe('ASIN1A');
	});
	it('does not fold a different volume into the same work', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01'), placeholder('OLD2', 2, 'Two', '2022-01-01')]));
		expect(series.works).toHaveLength(2);
		expect(series.works[0].editionIds).not.toContain('OLD2');
	});
	it('still yields a usable work when every edition is a placeholder', () => {
		const series = only(groupSeries([placeholder('OLD1', 1, 'One', '2021-01-01')]));
		expect(series.works[0].bookId).toBe('OLD1');
		expect(series.works[0].audioReleaseDate).toBe('2021-01-01');
	});
});

describe('reconciling an incomplete supplied series list', () => {
	const base = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2022-01-01')]));
	// The shape the exporter can ship: a real audiobook edition missing from the work's aliases.
	const stripped: CatalogSeries = { ...base, works: base.works.map((w) => ({ ...w, editionIds: w.editionIds.filter((id) => id !== 'ASIN2B') })) };
	const orphan = makeBook({ id: 'ASIN2B', seriesNumber: 2, title: 'Two', releaseDate: '2022-01-01' });

	it('leaves the orphan unresolvable when only the supplied list is used', () => {
		expect(workIndex([stripped]).has('ASIN2B')).toBe(false);
	});
	it('reattaches it to the right volume when the catalog books are supplied', () => {
		const index = workIndex([stripped], [orphan]);
		expect(index.get('ASIN2B')?.work.number).toBe(2);
		expect(index.get('ASIN2B')?.series.id).toBe(stripped.id);
	});
	it('refuses to attach a book from a different series or an unnumbered one', () => {
		const foreign = makeBook({ id: 'OTHER1', seriesKey: 'somethingelse--author', seriesNumber: 2, title: 'Two' });
		const unnumbered = makeBook({ id: 'NONUM', seriesNumber: null, title: 'Two' });
		const missingVolume = makeBook({ id: 'VOL9', seriesNumber: 9, title: 'Nine' });
		const index = workIndex([stripped], [foreign, unnumbered, missingVolume]);
		expect(index.has('OTHER1')).toBe(false);
		expect(index.has('NONUM')).toBe(false);
		expect(index.has('VOL9')).toBe(false);
	});
	it('never overrides an id the supplied list already claims', () => {
		const index = workIndex([base], [makeBook({ id: 'ASIN1B', seriesNumber: 2, title: 'Two' })]);
		expect(index.get('ASIN1B')?.work.number).toBe(1);
	});
});

describe('progressive enrichment from synthesized works to canonical works', () => {
	const books = [...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2022-01-01')];
	const legacySeries = only(groupSeries(books));
	/** What root ships once the series is seeded: new id, new work ids, old names kept as aliases. */
	const canonical: CatalogSeries = {
		...legacySeries, id: 'dungeon-crawler-carl', aliases: [legacySeries.id],
		works: legacySeries.works.map((w) => ({ ...w, id: `work-dcc-${w.number}`, verified: true }))
	};

	it('carries a read and its rating onto the canonical work', () => {
		let v2 = setWorkStatus(emptyLibrary(), legacySeries, legacySeries.works[0], 'read', '2026-01-01T00:00:00.000Z');
		v2 = setWorkRating(v2, legacySeries, legacySeries.works[0], 5, '2026-01-02T00:00:00.000Z');
		expect(Object.keys(v2.books)[0]).toMatch(/^work-legacy-/);

		const migrated = migrateLibrary({}, [canonical], v2);
		expect(workEntry(migrated, canonical.works[0])).toMatchObject({ status: 'read', rating: 5 });
		expect(migrated.series['dungeon-crawler-carl']).toBeDefined();
		expect(seriesProgress(migrated, canonical, NOW).read).toBe(1);
		// The synthesized id was this app's own invention, so it is not kept around.
		expect(Object.keys(migrated.books).some((k) => k.startsWith('work-legacy-'))).toBe(false);
	});
	it('recovers an entry written before provenance hints existed', () => {
		let v2 = setWorkStatus(emptyLibrary(), legacySeries, legacySeries.works[1], 'read', '2026-01-01T00:00:00.000Z');
		// Strip the hint: this is the shape already sitting in a browser from an earlier build.
		v2 = { ...v2, books: Object.fromEntries(Object.entries(v2.books).map(([k, e]) => [k, { status: e.status, rating: e.rating, updatedAt: e.updatedAt }])) };
		const migrated = migrateLibrary({}, [canonical], v2);
		expect(workEntry(migrated, canonical.works[1])?.status).toBe('read');
	});
	it('survives a second re-mint, because the hint travels with the entry', () => {
		const v2 = setWorkStatus(emptyLibrary(), legacySeries, legacySeries.works[0], 'read', '2026-01-01T00:00:00.000Z');
		const once = migrateLibrary({}, [canonical], v2);
		const remixed: CatalogSeries = { ...canonical, id: 'dcc-v3', aliases: ['dungeon-crawler-carl'], works: canonical.works.map((w) => ({ ...w, id: `work-v3-${w.number}` })) };
		const twice = migrateLibrary({}, [remixed], once);
		expect(workEntry(twice, remixed.works[0])?.status).toBe('read');
		expect(migrateLibrary({}, [remixed], twice)).toEqual(twice);
	});
	it('never moves progress onto an unrelated series', () => {
		const v2 = setWorkStatus(emptyLibrary(), legacySeries, legacySeries.works[0], 'read', '2026-01-01T00:00:00.000Z');
		const stranger: CatalogSeries = { ...canonical, id: 'a-different-series', aliases: [], title: 'Something Else' };
		const migrated = migrateLibrary({}, [stranger], v2);
		expect(workEntry(migrated, stranger.works[0])).toBeUndefined();
	});
	it('does not overwrite newer progress already on the canonical work', () => {
		const old = setWorkStatus(emptyLibrary(), legacySeries, legacySeries.works[0], 'want', '2025-01-01T00:00:00.000Z');
		const merged: SeriesLibrary = { ...old, books: { ...old.books, 'work-dcc-1': { status: 'read', rating: 4, updatedAt: '2026-06-01T00:00:00.000Z' } } };
		const migrated = migrateLibrary({}, [canonical], merged);
		expect(workEntry(migrated, canonical.works[0])).toMatchObject({ status: 'read', rating: 4 });
	});
	it('keeps unresolved source ids instead of deleting them', () => {
		const v2: SeriesLibrary = { version: 2, series: {}, books: { B0UNKNOWN1: { status: 'read', rating: null, updatedAt: '2025-01-01T00:00:00.000Z' } } };
		expect(migrateLibrary({}, [canonical], v2).books.B0UNKNOWN1).toBeDefined();
	});
});

describe('fractional volume numbers', () => {
	it('keeps the reconciliation hint for a 0.5 or 10.5 volume', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01'), makeBook({ id: 'HALF', seriesNumber: 10.5, title: 'A novella', releaseDate: '2022-01-01' })]));
		const half = series.works.find((w) => w.number === 10.5)!;
		const saved = setWorkStatus(emptyLibrary(), series, half, 'read', '2026-01-01T00:00:00.000Z');
		// Survives a storage round trip — the hint is what re-homes it after an id re-mint.
		const reloaded = parseSeriesLibrary(JSON.parse(JSON.stringify(saved)))!;
		expect(reloaded.books[half.id].work).toEqual({ series: series.id, number: 10.5 });

		const remint: CatalogSeries = { ...series, id: 'canonical', aliases: [series.id], works: series.works.map((w) => ({ ...w, id: `work-new-${w.number}` })) };
		const migrated = migrateLibrary({}, [remint], reloaded);
		expect(workEntry(migrated, remint.works.find((w) => w.number === 10.5)!)?.status).toBe('read');
	});
	it('does not treat a fractional volume as a missing whole number', () => {
		const series = only(groupSeries([...volume(1, 'One', '2021-01-01'), makeBook({ id: 'HALF', seriesNumber: 1.5, title: 'Novella', releaseDate: '2021-06-01' }), ...volume(2, 'Two', '2022-01-01')]));
		expect(seriesGaps(series)).toEqual([]);
	});
});

describe('progress precedence across ids', () => {
	it('prefers the newest entry even when it sits on an alias, not the canonical id', () => {
		const series = carl();
		const work = series.works[0];
		const stale = setWorkStatus(emptyLibrary(), series, work, 'want', '2025-01-01T00:00:00.000Z');
		// An import lands a newer read against the original ASIN rather than the work id.
		const withImport: SeriesLibrary = { ...stale, books: { ...stale.books, ASIN1B: { status: 'read', rating: 5, updatedAt: '2026-06-01T00:00:00.000Z' } } };
		expect(workEntry(withImport, work)).toMatchObject({ status: 'read', rating: 5 });
		expect(seriesProgress(withImport, series, NOW).read).toBe(1);
	});
	it('still prefers the canonical id when timestamps tie', () => {
		const series = carl();
		const work = series.works[0];
		const same = '2026-01-01T00:00:00.000Z';
		const library: SeriesLibrary = { version: 2, series: {}, books: { [work.id]: { status: 'read', rating: null, updatedAt: same }, ASIN1B: { status: 'want', rating: null, updatedAt: same } } };
		expect(workEntry(library, work)?.status).toBe('read');
	});
});

describe('history preservation regressions from real catalog shapes', () => {
	it('recovers a read on a Path of Ascension ASIN the exporter left out of every work', () => {
		// The live shape: real audiobook ASINs absent from editionIds (B0BS1B2FTH, B0C1R8Q7FQ, B0CK4N9HG5).
		const catalogBooks = [2, 3, 4].map((n) => makeBook({ id: `ASIN${n}A`, seriesKey: 'the-path-of-ascension', series: 'The Path of Ascension', seriesNumber: n, title: `Path ${n}`, releaseDate: `202${n}-01-01` }));
		const orphans = [
			makeBook({ id: 'B0BS1B2FTH', seriesKey: 'the-path-of-ascension', series: 'The Path of Ascension', seriesNumber: 2, title: 'Path 2', releaseDate: '2022-01-01' }),
			makeBook({ id: 'B0C1R8Q7FQ', seriesKey: 'the-path-of-ascension', series: 'The Path of Ascension', seriesNumber: 3, title: 'Path 3', releaseDate: '2023-01-01' })
		];
		const shipped: CatalogSeries = { ...only(groupSeries(catalogBooks)), id: 'the-path-of-ascension' };
		expect(workIndex([shipped]).has('B0BS1B2FTH')).toBe(false);

		const index = workIndex([shipped], [...catalogBooks, ...orphans]);
		const hit = index.get('B0BS1B2FTH')!;
		expect(hit.work.number).toBe(2);
		// A read saved against the orphaned ASIN resolves once the work carries it.
		const withAlias = { ...hit.work, editionIds: [...hit.work.editionIds, 'B0BS1B2FTH'] };
		expect(workEntry({ version: 2, series: {}, books: { B0BS1B2FTH: { status: 'read', rating: 3, updatedAt: '2026-01-01T00:00:00.000Z' } } }, withAlias)).toMatchObject({ status: 'read', rating: 3 });
	});
	it('tolerates a stale alias pointing at an ASIN no longer in the catalog', () => {
		const series = carl();
		const withGhost: CatalogWork = { ...series.works[0], editionIds: [...series.works[0].editionIds, 'B0GHOSTOLD'] };
		const library = setWorkStatus(emptyLibrary(), series, withGhost, 'read', '2026-01-01T00:00:00.000Z');
		expect(workEntry(library, withGhost)?.status).toBe('read');
		expect(workEntry(library, series.works[0])?.status).toBe('read');
	});
	it('preserves the real Azarinth Healer book 6 read through migration and re-mint', () => {
		// The live shape: only books 1 and 6 catalogued, so books 2-5 are missing.
		const az = only(groupSeries([
			makeBook({ id: 'B08NZY1234', seriesKey: 'azarinth-healer', series: 'Azarinth Healer', author: 'Rhaegar', seriesNumber: 1, title: 'Azarinth Healer, Book One', releaseDate: '2020-06-01' }),
			makeBook({ id: 'B0GJFN4C4Q', seriesKey: 'azarinth-healer', series: 'Azarinth Healer', author: 'Rhaegar', seriesNumber: 6, title: 'Azarinth Healer, Book Six', releaseDate: '2026-02-03' })
		]));
		expect(seriesGaps(az)).toEqual([2, 3, 4, 5]);

		// Nate's actual v1 record: a read keyed by the raw ASIN.
		const migrated = migrateLibrary({ B0GJFN4C4Q: { status: 'read', rating: null, updatedAt: '2026-09-01T00:00:00.000Z' } }, [az]);
		const six = az.works.find((w) => w.number === 6)!;
		expect(workEntry(migrated, six)?.status).toBe('read');
		expect(migrated.series[az.id]).toBeDefined();

		const progress = seriesProgress(migrated, az, NOW);
		expect(progress).toMatchObject({ read: 1, total: 2, caughtUp: false, state: 'in-progress' });
		expect(progress.unresolved).toContain('Book 2, 3, 4, 5 are missing from the catalog');

		// Root later seeds the series: new id, new work ids, old id kept as an alias.
		const seeded: CatalogSeries = { ...az, id: 'azarinth-healer-canonical', aliases: [az.id], works: az.works.map((w) => ({ ...w, id: `work-az-${w.number}`, verified: true })) };
		const after = migrateLibrary({}, [seeded], migrated);
		expect(workEntry(after, seeded.works.find((w) => w.number === 6)!)?.status).toBe('read');
		expect(after.series['azarinth-healer-canonical']).toBeDefined();
	});
	it('will not claim currency for an ongoing series holding only its first book', () => {
		// Awaken Online in the live catalog: curated true, status ongoing, one work.
		const ao: CatalogSeries = { ...only(groupSeries([...volume(1, 'Awaken Online: Catharsis', '2017-01-01')])), status: 'ongoing', curated: true };
		const progress = seriesProgress(markSeriesRead(emptyLibrary(), ao, NOW), ao, NOW);
		expect(progress).toMatchObject({ read: 1, total: 1, caughtUp: false, state: 'caught-up-partial', sourceComplete: false });
		expect(progress.unresolved).toEqual(['we can’t confirm this series’ audiobook list is complete']);
	});
});

describe('content filters and discovery', () => {
	const flagged = (): CatalogBook['content'] => ({ ...content(), harem: { verdict: 'present', confidence: 0.95, source: 'jev', note: 'harem' } });
	const books = [
		makeBook({ id: 'WOLF1', seriesKey: 'wolf', series: "The Wolf King's Lair", seriesNumber: 1, title: 'Wolf 1', releaseDate: '2021-01-01', content: flagged() }),
		makeBook({ id: 'WOLF4', seriesKey: 'wolf', series: "The Wolf King's Lair", seriesNumber: 4, title: 'Wolf 4', releaseDate: '2024-01-01' })
	];
	const series = only(groupSeries(books));
	const index = new Map(books.map((b) => [b.id, b]));
	const visible = (b: CatalogBook) => passesFilters(b, defaultFilters);

	it('represents a series by its first mainline volume in the library', () => {
		expect(seriesStarter(series, index)?.id).toBe('WOLF1');
	});
	it('hides a series whose first book is filtered out, even though a later volume passes', () => {
		// The leak: the series listed on WOLF4 while the card rendered harem-flagged WOLF1.
		expect(visible(books[1])).toBe(true);
		expect(seriesEntry(series, index, { filters: defaultFilters })).toBeNull();
	});
	it('shows the series, rendering volume 1, once the filter is turned off', () => {
		const entry = seriesEntry(series, index, { filters: { ...defaultFilters, hideHarem: false } });
		expect(entry?.book.id).toBe('WOLF1');
	});
	it('renders exactly the book that passed the filters, never a re-derived cover', () => {
		const eligible = eligibleSeriesEntries([series], index, { filters: { ...defaultFilters, hideHarem: false } });
		expect(eligible.map((e) => e.book.id)).toEqual(['WOLF1']);
		expect(eligible.every((e) => passesFilters(e.book, { ...defaultFilters, hideHarem: false }))).toBe(true);
	});
	it('still tracks progress across the whole series regardless of filters', () => {
		const library = markSeriesRead(emptyLibrary(), series, TODAY);
		expect(seriesProgress(library, series, NOW).read).toBe(2);
	});
});

describe('standalone books arriving as one-work series', () => {
	it('falls back to the book title rather than rendering a blank name', () => {
		// The live shape: 1796 supplied series are standalone books with an empty series name.
		const solo = makeBook({ id: '0062882856', seriesKey: '0062882856', series: '', title: 'Super Human', author: 'Dave Asprey', seriesNumber: null });
		const series = only(groupSeries([solo]));
		expect(series.title).toBe('Super Human');
		expect(seriesTitle(series, new Map([[solo.id, solo]]))).toBe('Super Human');
	});
	it('repairs a supplied series whose title is blank', () => {
		const solo = makeBook({ id: 'SOLO1', seriesKey: 'SOLO1', series: '', title: 'The Dutch House', seriesNumber: null });
		const supplied: CatalogSeries = { ...only(groupSeries([solo])), title: '   ' };
		expect(seriesTitle(supplied, new Map([[solo.id, solo]]))).toBe('The Dutch House');
	});
	it('never returns an empty string even with nothing to fall back on', () => {
		const series: CatalogSeries = { ...carl(), title: '', coverBookId: 'MISSING', works: [] };
		expect(seriesTitle(series, new Map())).toBe('Untitled');
	});
});

describe('story completion is not audio completion', () => {
	const series = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2022-01-01')]));

	it('does not claim currency for a finished story whose audio list is unverified', () => {
		// A completed series is routinely still mid-way through audio production, so story
		// status must never license "up to date" on its own.
		const storyDone: CatalogSeries = { ...series, status: 'complete' };
		const progress = seriesProgress(markSeriesRead(emptyLibrary(), storyDone, NOW), storyDone, NOW);
		expect(progress).toMatchObject({ read: 2, caughtUp: false, state: 'caught-up-partial', sourceComplete: false });
		expect(progress.unresolved).toEqual(['we can’t confirm this series’ audiobook list is complete']);
	});
	it('claims currency once audio coverage is asserted, even while the story is ongoing', () => {
		const audioDone: CatalogSeries = covered({ ...series, status: 'ongoing' });
		expect(seriesProgress(markSeriesRead(emptyLibrary(), audioDone, TODAY), audioDone, NOW)).toMatchObject({ caughtUp: true, state: 'caught-up', sourceComplete: true });
	});
	it('treats an absent assertion as not complete', () => {
		expect(seriesProgress(markSeriesRead(emptyLibrary(), series, NOW), series, NOW).sourceComplete).toBe(false);
	});
	it('still refuses currency when audio is asserted complete but a volume is missing', () => {
		const gappy: CatalogSeries = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(3, 'Three', '2023-01-01')]));
		const progress = seriesProgress(markSeriesRead(emptyLibrary(), gappy, NOW), gappy, NOW);
		expect(progress.caughtUp).toBe(false);
		expect(progress.unresolved).toContain('Book 2 is missing from the catalog');
	});
});

describe('review regressions', () => {
	it('preserves a supplied audio-coverage assertion through grouping', () => {
		// Dropped before: the fallback path copied every other supplied field but this one,
		// which would have made the confident state unreachable even once root emits it.
		const books = [...volume(1, 'One', '2021-01-01')];
		const coverage = covered(only(groupSeries(books))).audioCoverage!;
		const grouped = groupSeries(books, [{ id: 'dcc--mattdinniman', audioCoverage: coverage }])[0];
		expect(grouped.audioCoverage?.manifestId).toBe('manifest-1');
		expect(seriesProgress(markSeriesRead(emptyLibrary(), grouped, NOW), grouped, NOW)).toMatchObject({ caughtUp: true, state: 'caught-up' });
	});

	it('adopts a read saved against an audiobook the exporter left out of every work', () => {
		// workIndex reconciles this id, but the work's alias list deliberately does not contain
		// it, so workEntry alone cannot see the entry.
		const orphan = makeBook({ id: 'B0ORPHAN1', seriesNumber: 2, title: 'Two', releaseDate: '2022-01-01' });
		const shipped = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2022-01-01')]));
		const two = shipped.works.find((w) => w.number === 2)!;
		expect(workIndex([shipped]).has('B0ORPHAN1')).toBe(false);

		const stranded: SeriesLibrary = { version: 2, series: {}, books: { B0ORPHAN1: { status: 'read', rating: 4, updatedAt: '2026-01-01T00:00:00.000Z' } } };
		expect(workEntry(stranded, two)).toBeUndefined();

		const books = new Map([[orphan.id, orphan]]);
		const rehomed = migrateLibrary({}, [shipped], stranded, books);
		expect(workEntry(rehomed, two)).toMatchObject({ status: 'read', rating: 4 });
		// A real source id is an alias forever; only ids we synthesised are removed.
		expect(rehomed.books.B0ORPHAN1).toBeDefined();
	});

	it('re-homes a v2 export imported after the work ids were re-minted', () => {
		const legacySeries = carl();
		const exported = setWorkStatus(emptyLibrary(), legacySeries, legacySeries.works[0], 'read', '2026-01-01T00:00:00.000Z');
		const canonical: CatalogSeries = { ...legacySeries, id: 'dcc-canonical', aliases: [legacySeries.id], works: legacySeries.works.map((w) => ({ ...w, id: `work-dcc-${w.number}` })) };
		const payload = JSON.parse(JSON.stringify(libraryExport(exported)));
		const imported = parseLibraryExport(payload, [canonical])!;
		expect(workEntry(imported, canonical.works[0])?.status).toBe('read');
		expect(imported.series['dcc-canonical']).toBeDefined();
	});

	it('does not let an omnibus sharing a volume number inflate the denominator', () => {
		// Live shape: "The Station Core" and "Station Cores Complete Compilation" both volume 1.
		const books = [
			...volume(1, 'The Station Core', '2021-01-01'),
			makeBook({ id: 'OMNI1', seriesNumber: 1, title: 'Station Cores Complete Compilation', releaseDate: '2023-01-01' }),
			...volume(2, 'Station Cores Two', '2022-01-01')
		];
		const series = finished(only(groupSeries(books)));
		expect(mainlineWorks(series).map((w) => w.number)).toEqual([1, 2]);
		expect(mainlineWorks(series)[0].title).toBe('The Station Core');
		expect(sideWorks(series).map((w) => w.title)).toEqual(['Station Cores Complete Compilation']);
		// Two real volumes, not three.
		expect(seriesProgress(emptyLibrary(), series, NOW).total).toBe(2);
		const read = setWorkStatus(setWorkStatus(emptyLibrary(), series, mainlineWorks(series)[0], 'read'), series, mainlineWorks(series)[1], 'read');
		expect(seriesProgress(read, series, NOW).remaining).toBe(0);
	});

	it('re-homes by the edition title even after enrichment retitled the work', () => {
		const legacySeries = only(groupSeries([...volume(1, 'Original Edition Title', '2021-01-01')]));
		const saved = setWorkStatus(emptyLibrary(), legacySeries, legacySeries.works[0], 'read', '2026-01-01T00:00:00.000Z');
		// Strip the hint so only the regeneration path can recover it.
		const preHint: SeriesLibrary = { ...saved, books: Object.fromEntries(Object.entries(saved.books).map(([k, e]) => [k, { status: e.status, rating: e.rating, updatedAt: e.updatedAt }])) };
		const renamed: CatalogSeries = {
			...legacySeries, id: 'canonical-id', aliases: [legacySeries.id],
			works: legacySeries.works.map((w) => ({ ...w, id: 'work-canon-1', title: 'A Completely Different Canonical Title' }))
		};
		const catalogBooks = new Map([['ASIN1A', makeBook({ id: 'ASIN1A', seriesNumber: 1, title: 'Original Edition Title' })]]);
		expect(workEntry(migrateLibrary({}, [renamed], preHint), renamed.works[0])).toBeUndefined();
		expect(workEntry(migrateLibrary({}, [renamed], preHint, catalogBooks), renamed.works[0])?.status).toBe('read');
	});
});

describe('picking the real volume over a bundle', () => {
	it('rejects a bundle that just restates the series name', () => {
		// Live shape: "Glendaria Awakens Trilogy" sits at volume 1 beside "Dungeon Player".
		const books = [
			makeBook({ id: 'REAL1', seriesKey: 'glendaria', series: 'Glendaria Awakens Trilogy', seriesNumber: 1, title: 'Dungeon Player', releaseDate: '2019-01-01' }),
			makeBook({ id: 'BUNDLE', seriesKey: 'glendaria', series: 'Glendaria Awakens Trilogy', seriesNumber: 1, title: 'Glendaria Awakens Trilogy', releaseDate: '2021-01-01' }),
			makeBook({ id: 'REAL2', seriesKey: 'glendaria', series: 'Glendaria Awakens Trilogy', seriesNumber: 2, title: 'Dungeon Crisis', releaseDate: '2020-01-01' })
		];
		const series = only(groupSeries(books));
		expect(mainlineWorks(series).map((w) => w.title)).toEqual(['Dungeon Player', 'Dungeon Crisis']);
		expect(sideWorks(series).map((w) => w.title)).toEqual(['Glendaria Awakens Trilogy']);
	});
	it('still prefers a verified work over an unverified one', () => {
		const series = only(groupSeries([...volume(1, 'Plain', '2021-01-01'), makeBook({ id: 'OTHER', seriesNumber: 1, title: 'Alternate', releaseDate: '2021-01-01' })]));
		const withVerified: CatalogSeries = { ...series, works: series.works.map((w, i) => ({ ...w, verified: i === 1 })) };
		expect(mainlineWorks(withVerified)[0].id).toBe(series.works[1].id);
	});
});

describe('audio coverage is re-checked, never trusted as shipped', () => {
	const series = () => only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2022-01-01')]));
	const allRead = (s: CatalogSeries) => markSeriesRead(emptyLibrary(), s, TODAY);

	it('refuses a shipped current:true once validUntil has passed', () => {
		// The export said current at assessment time; that claim is not timeless.
		const expired = covered(series(), { validUntil: '2026-09-18T06:00:00.000Z' });
		const progress = seriesProgress(allRead(expired), expired, NOW);
		expect(progress).toMatchObject({ caughtUp: false, sourceComplete: false, state: 'caught-up-partial' });
		expect(progress.unresolved).toContain('we can’t confirm this series’ audiobook list is complete');
	});
	it('refuses coverage whose window closes exactly now, since the bound is exclusive', () => {
		const boundary = covered(series(), { validUntil: NOW });
		expect(seriesProgress(allRead(boundary), boundary, NOW).caughtUp).toBe(false);
	});
	it('refuses a window that expires when the next book lands', () => {
		// validUntil is capped at the next scheduled release, so the day it ships we stop claiming.
		const s = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2026-09-20')]));
		const capped = covered(s, { validUntil: '2026-09-20T00:00:00.000Z', releasedWorkIds: [s.works[0].id], scheduledWorkIds: [s.works[1].id] });
		const library = markSeriesRead(emptyLibrary(), capped, TODAY);
		expect(seriesProgress(library, capped, NOW)).toMatchObject({ caughtUp: true, upcoming: 1 });
		expect(seriesProgress(library, capped, '2026-09-20T09:00:00.000Z').caughtUp).toBe(false);
	});
	it('never claims currency from a date-only caller', () => {
		// A plain date cannot establish freshness, and guessing would be the false positive.
		const s = covered(series());
		expect(seriesProgress(allRead(s), s, TODAY)).toMatchObject({ caughtUp: false, sourceComplete: false });
	});
	it('rejects any status other than verified', () => {
		for (const status of ['incomplete', 'unknown', 'stale'] as const) {
			const s = covered(series(), { status });
			expect(seriesProgress(allRead(s), s, NOW).caughtUp).toBe(false);
		}
		const notCurrent = covered(series(), { current: false });
		expect(seriesProgress(allRead(notCurrent), notCurrent, NOW).caughtUp).toBe(false);
	});
	it('will not claim currency when a verified release is missing from the catalog', () => {
		const s = covered(series(), { releasedWorkIds: [series().works[0].id, 'work-we-do-not-have'] });
		const progress = seriesProgress(allRead(s), s, NOW);
		expect(progress.caughtUp).toBe(false);
		expect(progress.unresolved).toContain('1 verified audiobook is missing from the catalog');
	});
	it('does not count a scheduled book as unread', () => {
		const s = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2027-01-01')]));
		const withCoverage = covered(s, { releasedWorkIds: [s.works[0].id], scheduledWorkIds: [s.works[1].id] });
		const library = setWorkStatus(emptyLibrary(), withCoverage, s.works[0], 'read');
		expect(seriesProgress(library, withCoverage, NOW)).toMatchObject({ caughtUp: true, total: 1, upcoming: 1, remaining: 0 });
	});
	it('will not claim currency while a catalogued volume is outside the reviewed list', () => {
		const s = series();
		const narrow = covered(s, { releasedWorkIds: [s.works[0].id], scheduledWorkIds: [] });
		const library = setWorkStatus(emptyLibrary(), narrow, s.works[0], 'read');
		const progress = seriesProgress(library, narrow, NOW);
		expect(progress).toMatchObject({ total: 1, read: 1, caughtUp: false });
		expect(progress.unresolved).toContain('1 catalogued volume is not covered by the reviewed audio list');
	});
});

describe('coverage overrides the catalogued row date everywhere, not just in progress', () => {
	// Before this, progress trusted coverage while bulk marking and the row controls trusted
	// work.audioReleaseDate, so the two disagreed about what was released.
	const build = () => only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2022-01-01')]));

	it('treats a stale past row date as unreleased when coverage says it is scheduled', () => {
		const s = build();
		const corrected = covered(s, { releasedWorkIds: [s.works[0].id], scheduledWorkIds: [s.works[1].id] });
		expect(workRelease(corrected, s.works[1], NOW)).toMatchObject({ state: 'scheduled', verified: true });
		// Bulk marking must not mark it, and progress must not require it.
		const library = markSeriesRead(emptyLibrary(), corrected, NOW);
		expect(workEntry(library, s.works[1])).toBeUndefined();
		expect(seriesProgress(library, corrected, NOW)).toMatchObject({ total: 1, read: 1, upcoming: 1, caughtUp: true });
	});

	it('treats a stale future row date as released when coverage verifies it', () => {
		// The dead end this fixes: progress demanded the book, while the row control was
		// disabled and bulk marking skipped it, so the reader could never become current.
		const s = only(groupSeries([...volume(1, 'One', '2021-01-01'), ...volume(2, 'Two', '2027-01-01')]));
		const corrected = covered(s, { releasedWorkIds: s.works.map((w) => w.id), scheduledWorkIds: [] });
		expect(workRelease(corrected, s.works[1], NOW)).toMatchObject({ state: 'released', verified: true });
		const library = markSeriesRead(emptyLibrary(), corrected, NOW);
		expect(workEntry(library, s.works[1])?.status).toBe('read');
		expect(seriesProgress(library, corrected, NOW)).toMatchObject({ total: 2, read: 2, caughtUp: true });
	});

	it('refuses to inherit an old date for a work current coverage does not vouch for', () => {
		const s = build();
		const partial = covered(s, { releasedWorkIds: [s.works[0].id], scheduledWorkIds: [] });
		expect(workRelease(partial, s.works[1], NOW)).toEqual({ state: 'unknown', date: null, verified: true });
	});

	it('falls back to catalogued dates only when there is no usable manifest', () => {
		const s = build();
		expect(workRelease(s, s.works[0], NOW)).toMatchObject({ state: 'released', date: '2021-01-01', verified: false });
		// A coverage object that never established a manifest is not an override.
		const noManifest = covered(s, { manifestId: null, status: 'unknown', current: false, releasedWorkIds: [], scheduledWorkIds: [], issues: [{ code: 'missing-manifest', message: 'none' }] });
		expect(workRelease(noManifest, s.works[0], NOW)).toMatchObject({ state: 'released', date: '2021-01-01', verified: false });
	});

	it('keeps a verified release durable after the coverage goes stale', () => {
		// Evidence ageing does not un-publish an audiobook.
		const s = build();
		const expired = covered(s, { validUntil: '2026-09-18T06:00:00.000Z' });
		expect(workRelease(expired, s.works[0], NOW)).toMatchObject({ state: 'released', verified: true });
	});

	it('will not resurrect a corrected row date once the coverage expires', () => {
		// The silent pre-marking this prevents: coverage corrected a stale PAST row date to
		// scheduled; a week later the coverage expires and the old date reappears as released.
		const s = build();
		const expired = covered(s, {
			validUntil: '2026-09-18T06:00:00.000Z',
			releasedWorkIds: [s.works[0].id], scheduledWorkIds: [s.works[1].id]
		});
		expect(workRelease(expired, s.works[1], NOW)).toMatchObject({ state: 'unknown', verified: true });
		const library = markSeriesRead(emptyLibrary(), expired, NOW);
		expect(workEntry(library, s.works[1])).toBeUndefined();
	});

	it('does not let another book’s problem resurrect this one’s row date', () => {
		const s = build();
		const incomplete = covered(s, {
			status: 'incomplete', current: false,
			releasedWorkIds: [s.works[0].id], scheduledWorkIds: [s.works[1].id],
			issues: [{ code: 'missing-verified-audio', message: 'another book', workId: 'some-other-work' }]
		});
		expect(workRelease(incomplete, s.works[1], NOW)).toMatchObject({ state: 'unknown', verified: true });
		// The healthy book keeps its verified release despite the series being incomplete.
		expect(workRelease(incomplete, s.works[0], NOW)).toMatchObject({ state: 'released', verified: true });
	});

	it('refuses a work its own coverage issue flags, whatever the row says', () => {
		const s = build();
		for (const code of ['unknown-audio-date', 'release-not-reconfirmed', 'missing-verified-audio', 'expired-audio-schedule'] as const) {
			const flagged = covered(s, {
				releasedWorkIds: [s.works[0].id], scheduledWorkIds: [s.works[1].id],
				issues: [{ code: code as never, message: code, workId: s.works[1].id }]
			});
			expect(workRelease(flagged, s.works[1], NOW)).toMatchObject({ state: 'unknown', verified: true });
		}
	});

	it('reports the coverage release date rather than the catalogued one', () => {
		const s = build();
		const corrected = covered(s, {
			releasedWorkIds: s.works.map((w) => w.id), scheduledWorkIds: [],
			works: [{ workId: s.works[0].id, number: 1, state: 'released', releaseDate: '2021-06-15', editionIds: [] }]
		});
		expect(workRelease(corrected, s.works[0], NOW).date).toBe('2021-06-15');
		expect(latestAudioRelease(corrected, NOW)).toBe('2021-06-15');
	});
});

describe('resolving a series link shared before a rename', () => {
	const make = (id: string, aliases: string[]): CatalogSeries => ({ ...carl(), id, aliases });

	it('resolves a canonical id', () => {
		const s = make('he-who-fights-with-monsters', []);
		expect(resolveSeriesRef([s], 'he-who-fights-with-monsters')?.id).toBe('he-who-fights-with-monsters');
	});
	it('resolves the aliases that are dead links today', () => {
		// 116 such aliases ship in the catalogue; each previously showed "not in the catalog".
		const s = make('he-who-fights-with-monsters', ['HWFWM', 'hewhofightswithmonsters--shirtaloon']);
		expect(resolveSeriesRef([s], 'HWFWM')?.id).toBe('he-who-fights-with-monsters');
		expect(resolveSeriesRef([s], 'hewhofightswithmonsters--shirtaloon')?.id).toBe('he-who-fights-with-monsters');
	});
	it('never lets an alias shadow a real series id', () => {
		const real = make('noobtown', []);
		const impostor = make('other-series', ['noobtown']);
		expect(resolveSeriesRef([impostor, real], 'noobtown')?.id).toBe('noobtown');
	});
	it('refuses an alias two different series both claim', () => {
		const a = make('series-a', ['shared']);
		const b = make('series-b', ['shared']);
		expect(resolveSeriesRef([a, b], 'shared')).toBeNull();
	});
	it('tolerates a series claiming the same alias twice', () => {
		expect(resolveSeriesRef([make('series-a', ['dup', 'dup'])], 'dup')?.id).toBe('series-a');
	});
	it('returns null for an unknown or empty reference, and ignores malformed aliases', () => {
		const s = make('series-a', ['  ', null as never, 'ok']);
		expect(resolveSeriesRef([s], 'nope')).toBeNull();
		expect(resolveSeriesRef([s], '')).toBeNull();
		expect(resolveSeriesRef([s], 'ok')?.id).toBe('series-a');
	});
});

describe('matching editions when a search finds no series', () => {
	const pool = [
		makeBook({ id: 'A1', title: 'Bastion', seriesNumber: 1, subgenres: ['litrpg'], ratingCount: 500 }),
		makeBook({ id: 'A2', title: 'Bastion Two', seriesNumber: 2, subgenres: ['litrpg'], ratingCount: 9000 }),
		makeBook({ id: 'POD', title: 'The Bastion Black Performance Podcast', seriesNumber: null }),
		makeBook({ id: 'COLL', title: 'Bastion Omnibus', edition: 'collection', seriesNumber: null }),
		makeBook({ id: 'DRAMA', title: 'Bastion Full Cast', edition: 'dramatized', seriesNumber: null }),
		makeBook({ id: 'OTHER', title: 'Something Else', subgenres: ['cultivation'] })
	];

	it('returns audiobook editions only, excluding podcasts, collections and full cast', () => {
		expect(matchingAudiobooks(pool, 'bastion').map((b) => b.id)).toEqual(['A2', 'A1']);
	});
	it('ranks by popularity, so a later volume can surface — as an edition, not a starter', () => {
		// Deliberate: these are individual editions. Nothing here becomes a discovery entry.
		expect(matchingAudiobooks(pool, 'bastion')[0].id).toBe('A2');
	});
	it('honours the genre preference', () => {
		expect(matchingAudiobooks(pool, 'bastion', 'cultivation')).toEqual([]);
		expect(matchingAudiobooks(pool, 'something', 'cultivation').map((b) => b.id)).toEqual(['OTHER']);
	});
	it('returns nothing for an empty query, so it can never replace the index', () => {
		expect(matchingAudiobooks(pool, '')).toEqual([]);
		expect(matchingAudiobooks(pool, '   ')).toEqual([]);
	});
	it('respects the caller’s already-filtered pool', () => {
		// The page passes the same books the index uses, so hidden content stays hidden.
		expect(matchingAudiobooks(pool.filter((b) => b.id !== 'A2'), 'bastion').map((b) => b.id)).toEqual(['A1']);
	});
	it('caps the list', () => {
		const many = Array.from({ length: 40 }, (_, i) => makeBook({ id: `M${i}`, title: `Bastion ${i}` }));
		expect(matchingAudiobooks(many, 'bastion')).toHaveLength(24);
	});
});
