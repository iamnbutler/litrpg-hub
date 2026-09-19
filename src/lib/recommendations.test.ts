import { describe, expect, it } from 'vitest';
import { defaultFilters, passesFilters, recommend, type CatalogBook, type ContentSignal } from './catalog.js';
import { eligibleSeriesEntries, recommendSeries, seriesEntry } from './recommendations.js';
import type { CatalogSeries, CatalogWork } from './series.js';
import { buildSeriesContentIndex, passesDiscoveryFilters } from './series-content.js';
import { emptyLibrary, markSeriesRead, seriesProgress } from './library.js';

const unknown = (): ContentSignal => ({ verdict: 'unknown', confidence: 0, source: 'unknown', note: '' });
const content = (): CatalogBook['content'] => ({ sexualized: unknown(), explicit: unknown(), harem: unknown(), aiNarration: unknown(), aiWriting: unknown(), quality: unknown() });
const book = (fields: Partial<CatalogBook> = {}): CatalogBook => ({
	id: 'FIRST', title: 'The First Book', subtitle: '', author: 'Test Author', narrator: 'Narrator',
	series: 'Test Series', seriesKey: 'test-series', seriesNumber: 1, releaseDate: '2025-01-01',
	coverUrl: 'https://images.example/first.jpg', runtimeMinutes: 600, subgenres: ['litrpg'], description: 'A game-like world and a new adventure.',
	url: null, rating: 4.5, ratingCount: 100, edition: 'audiobook', scope: 'indexed', assessment: null,
	content: content(), sources: [{ name: 'publisher', fetchedAt: '2026-01-01' }], issues: [], ...fields
});
const work = (book: CatalogBook, fields: Partial<CatalogWork> = {}): CatalogWork => ({
	id: `work-${book.id}`, title: book.title, number: book.seriesNumber, bookId: book.id,
	editionIds: [book.id], audioReleaseDate: book.releaseDate, verified: true, hasAudio: true, ...fields
});
const series = (books: CatalogBook[], fields: Partial<CatalogSeries> = {}): CatalogSeries => ({
	id: books[0].seriesKey, title: books[0].series, author: books[0].author, aliases: [], description: '', genres: ['litrpg'],
	coverBookId: books[0].id, works: books.map(book => work(book)), curated: true, status: 'ongoing', sourceUrls: [], updatedAt: null, ...fields
});
const index = (...books: CatalogBook[]) => new Map(books.map(book => [book.id, book]));
function flagged(book: CatalogBook, field: keyof CatalogBook['content'] = 'harem'): CatalogBook {
	return { ...book, content: { ...book.content, [field]: { verdict: 'present', confidence: 1, source: 'publisher', note: 'Explicit source disclosure.' } } };
}
const seed = () => book({ id: 'SEED', seriesKey: 'seed-series', series: 'Seed Series', author: 'Seed Author' });

describe('series-level harem preferences', () => {
	it('uses a later publisher disclosure for discovery without changing any book classification or library progress', () => {
		const first = book(), second = flagged(book({ id: 'SECOND', seriesNumber: 2 }));
		const candidate = series([first, second]), books = index(first, second), before = structuredClone([candidate, first, second]);
		const context = buildSeriesContentIndex([candidate], books);
		expect(passesFilters(first, defaultFilters)).toBe(true);
		expect(passesDiscoveryFilters(first, defaultFilters, context)).toBe(false);
		expect(eligibleSeriesEntries([candidate], books)).toEqual([]);
		expect(recommendSeries(seed(), [candidate], books)).toEqual([]);
		expect(seriesEntry(candidate, books, { filters: { ...defaultFilters, hideHarem: false } })?.book).toBe(first);
		const library = markSeriesRead(emptyLibrary(), candidate, '2026-09-19');
		expect(seriesProgress(library, candidate, '2026-09-19T12:00:00.000Z')).toMatchObject({ read: 2, total: 2 });
		expect([candidate, first, second]).toEqual(before);
	});

	it('keeps a book-specific absence verdict, but not an uncertain absence', () => {
		const first = book(), second = flagged(book({ id: 'SECOND', seriesNumber: 2 }));
		first.content.harem = { verdict: 'absent', confidence: 0.9, source: 'publisher', note: 'No harem.' };
		const candidate = series([first, second]), books = index(first, second);
		expect(seriesEntry(candidate, books)?.book).toBe(first);
		first.content.harem.confidence = 0.6;
		expect(seriesEntry(candidate, books)).toBeNull();
	});

	it('filters a collection belonging to the series without treating its label as evidence about its components', () => {
		const first = book(), later = flagged(book({ id: 'LATER', seriesNumber: 2 }));
		const bundle = book({ id: 'BUNDLE', title: 'Books 1–3', edition: 'collection' });
		const candidate = series([first, later]), books = index(first, later, bundle);
		expect(passesDiscoveryFilters(bundle, defaultFilters, buildSeriesContentIndex([candidate], books))).toBe(false);
		const bundleOnly = buildSeriesContentIndex([series([first])], index(first, flagged(bundle)));
		expect(bundleOnly.size).toBe(0);
	});

	it.each(['jev', 'manual', 'vision', 'unknown'] as const)('does not turn a %s harem signal into a publisher series fact', source => {
		const first = book(), later = flagged(book({ id: 'LATER', seriesNumber: 2 }));
		later.content.harem.source = source;
		expect(seriesEntry(series([first, later]), index(first, later))?.book).toBe(first);
	});

	it.each(['sexualized', 'explicit', 'aiNarration', 'aiWriting', 'quality'] as const)('keeps %s evidence on its own edition', field => {
		const first = book(), later = flagged(book({ id: 'LATER', seriesNumber: 2 }), field);
		expect(buildSeriesContentIndex([series([first, later])], index(first, later)).size).toBe(0);
	});

	it('uses canonical edition membership across an old series key, preserving exact evidence and deduplicating works', () => {
		const first = book(), later = flagged(book({ id: 'LATER', seriesNumber: 2 }));
		const alternate = flagged(book({ id: 'ALT', seriesNumber: 2, seriesKey: 'old-key' }));
		const candidate = series([first, later], { works: [work(first), work(later, { editionIds: [later.id, alternate.id] })] });
		const context = buildSeriesContentIndex([candidate], index(first, later, alternate));
		expect(context.get(first.id)).toEqual({ seriesId: candidate.id, supportingEditionIds: ['ALT', 'LATER'], supportingWorkIds: ['work-LATER'] });
		expect(context.get(alternate.id)).toBe(context.get(first.id));
	});

	it('does not spread to another series by the same author or a same-named series by another author', () => {
		const first = flagged(book()), sameAuthor = book({ id: 'OTHER', seriesKey: 'different-series' });
		const sameTitle = book({ id: 'OTHER-AUTHOR', seriesKey: 'test-series-other-author', author: 'Other Author' });
		const books = index(first, sameAuthor, sameTitle);
		const entries = eligibleSeriesEntries([series([first]), series([sameAuthor]), series([sameTitle])], books);
		expect(entries.map(e => e.book.id)).toEqual([sameAuthor.id, sameTitle.id]);
	});

	it('ignores weak publisher evidence and ambiguous edition membership', () => {
		const first = book(), later = flagged(book({ id: 'LATER', seriesNumber: 2 }));
		later.content.harem.confidence = 0.7;
		const candidate = series([first, later]), books = index(first, later);
		expect(buildSeriesContentIndex([candidate], books).size).toBe(0);
		later.content.harem.confidence = 1;
		const conflicting = series([later], { id: 'conflicting-series' });
		expect(buildSeriesContentIndex([candidate, conflicting], books).size).toBe(0);
	});
});

describe('canonical series entries for discovery', () => {
	it('does not let Wolf King’s Lair volume 4 surface a blocked first-volume cover', () => {
		const first = flagged(book({ id: 'WOLF1', title: "The Wolf King's Lair 1", seriesKey: 'wolf', series: "The Wolf King's Lair" }));
		const fourth = book({ id: 'WOLF4', title: "The Wolf King's Lair 4", seriesKey: 'wolf', series: first.series, seriesNumber: 4 });
		const candidate = series([first, fourth]), books = index(first, fourth);
		expect(passesFilters(fourth, defaultFilters)).toBe(true);
		expect(seriesEntry(candidate, books)).toBeNull();
		expect(recommendSeries(seed(), [candidate], books)).toEqual([]);
		expect(seriesEntry(candidate, books, { filters: { ...defaultFilters, hideHarem: false } })?.book).toBe(first);
	});

	it('does not use Quest and Conquer volume 3 when only volumes 2 and 3 are known', () => {
		const second = flagged(book({ id: 'QUEST2', title: 'Quest and Conquer 2', seriesKey: 'quest', series: 'Quest and Conquer', seriesNumber: 2 }));
		const third = book({ id: 'QUEST3', title: 'Quest and Conquer 3', seriesKey: 'quest', series: second.series, seriesNumber: 3 });
		const candidate = series([second, third]), books = index(second, third);
		expect(seriesEntry(candidate, books)).toBeNull();
		expect(seriesEntry(candidate, books, { filters: { ...defaultFilters, hideHarem: false } })).toBeNull();
	});

	it.each([2, 3, 10])('rejects a later-volume-only series starting at volume %i', number => {
		const later = book({ seriesNumber: number });
		expect(seriesEntry(series([later]), index(later))).toBeNull();
	});

	it('finds volume 1 even when the supplied works are out of order and leaves the full series untouched', () => {
		const first = book(), second = flagged(book({ id: 'SECOND', seriesNumber: 2 }), 'sexualized');
		const candidate = series([second, first]), before = structuredClone(candidate);
		const entry = seriesEntry(candidate, index(first, second))!;
		expect(entry.book).toBe(first);
		expect(entry.series).toBe(candidate);
		expect(entry.series.works).toHaveLength(2);
		expect(candidate).toEqual(before);
	});

	it('does not replace a missing first-volume record with a later audiobook', () => {
		const first = book(), second = book({ id: 'SECOND', seriesNumber: 2 });
		expect(seriesEntry(series([first, second]), index(second))).toBeNull();
	});

	it('returns the exact eligible alternate audio edition of the first work', () => {
		const first = flagged(book(), 'sexualized');
		const alternate = book({ id: 'ALT-FIRST', coverUrl: 'https://images.example/alternate.jpg', narrator: 'Another narrator', ratingCount: 5 });
		const second = book({ id: 'SECOND', seriesNumber: 2, ratingCount: 100_000 });
		const startingWork = work(first, { editionIds: [first.id, alternate.id] });
		const candidate = series([first, second], { works: [startingWork, work(second)] });
		const entry = seriesEntry(candidate, index(first, alternate, second))!;
		expect(entry.work).toBe(startingWork);
		expect(entry.book).toBe(alternate);
		expect(passesFilters(entry.book, defaultFilters)).toBe(true);
		expect(entry.series.coverBookId).toBe(first.id);
		expect(recommendSeries(seed(), [candidate], index(first, alternate, second))[0].book).toBe(alternate);
	});

	it('can use an alternate starting edition when the preferred edition is absent', () => {
		const first = book(), alternate = book({ id: 'ALTERNATE' });
		const candidate = series([first], { works: [work(first, { editionIds: [first.id, alternate.id] })] });
		expect(seriesEntry(candidate, index(alternate))?.book).toBe(alternate);
	});

	it('never substitutes a dramatization or collection for the first full audiobook', () => {
		const first = flagged(book()), drama = book({ id: 'DRAMA', edition: 'dramatized' }), collection = book({ id: 'BOX', edition: 'collection' });
		const candidate = series([first], { works: [work(first, { editionIds: [first.id, drama.id, collection.id] })] });
		expect(seriesEntry(candidate, index(first, drama, collection))).toBeNull();
	});

	it('does not treat an audio-less first work as a recommendation entry', () => {
		const first = book();
		expect(seriesEntry(series([first], { works: [work(first, { hasAudio: false })] }), index(first))).toBeNull();
	});

	it('accepts a single unnumbered standalone but does not guess the order of an unnumbered multi-work series', () => {
		const standalone = book({ id: 'SOLO', seriesNumber: null, series: '', seriesKey: 'SOLO' });
		expect(seriesEntry(series([standalone]), index(standalone))?.book).toBe(standalone);
		const another = book({ id: 'ANOTHER', seriesNumber: null });
		expect(seriesEntry(series([standalone, another]), index(standalone, another))).toBeNull();
	});

	it('does not let an unnumbered side story replace a missing numbered first volume', () => {
		const side = book({ id: 'STORIES', seriesNumber: null }), second = book({ id: 'SECOND', seriesNumber: 2 });
		expect(seriesEntry(series([side, second]), index(side, second))).toBeNull();
	});

	it('preserves default unknown-content behavior and the explicit strict-unknown option', () => {
		const first = book(), candidate = series([first]), books = index(first);
		expect(seriesEntry(candidate, books)?.book).toBe(first);
		expect(seriesEntry(candidate, books, { filters: { ...defaultFilters, hideUnknown: true } })).toBeNull();
	});

	it('respects the include-unclassified preference for the starting work instead of selecting a classified sequel', () => {
		const first = book({ scope: 'review' }), second = book({ id: 'SECOND', seriesNumber: 2 });
		const candidate = series([first, second]), books = index(first, second);
		expect(seriesEntry(candidate, books)).toBeNull();
		expect(seriesEntry(candidate, books, { includeUnclassified: true })?.book).toBe(first);
	});

	it('does not let an unflagged backfill alias bypass the substantive edition’s content flag', () => {
		const first = flagged(book());
		const placeholder = book({ id: 'PLACEHOLDER', rating: null, ratingCount: 0, runtimeMinutes: null, sources: [] });
		const candidate = series([first], { works: [work(first, { editionIds: [first.id, placeholder.id] })] });
		expect(seriesEntry(candidate, index(first, placeholder))).toBeNull();
	});
});

describe('series recommendations', () => {
	it('excludes every edition and later volume of the seed’s canonical series, even with an old seed alias', () => {
		const first = book(), later = book({ id: 'LATER', seriesNumber: 3, seriesKey: 'old-retailer-alias' });
		const ownSeries = series([first], { works: [work(first), work(later)] });
		const other = book({ id: 'OTHER', seriesKey: 'other-series', series: 'Other Series', author: 'Another Author' });
		const results = recommendSeries(later, [ownSeries, series([other])], index(first, later, other));
		expect(results.map(result => result.book.id)).toEqual([other.id]);
	});

	it('deduplicates canonical series and excludes unmapped collection entries before applying the limit', () => {
		const a = book({ id: 'A', seriesKey: 'a', author: 'Author A', ratingCount: 10_000 });
		const b = book({ id: 'B', seriesKey: 'b', author: 'Author B', ratingCount: 1_000 });
		const c = book({ id: 'C', seriesKey: 'c', author: 'Author C', ratingCount: 100 });
		const omnibus = book({ id: 'OMNIBUS', seriesKey: 'box', edition: 'collection', ratingCount: 1_000_000 });
		const aSeries = series([a]), all = [series([omnibus]), aSeries, structuredClone(aSeries), series([b]), series([c])], books = index(a, b, c, omnibus);
		expect(eligibleSeriesEntries(all, books).map(entry => entry.series.id)).toEqual(['a', 'b', 'c']);
		const results = recommendSeries(seed(), all, books, { limit: 2 });
		expect(results.map(result => result.series.id)).toEqual(['a', 'b']);
		expect(results[0].series).toBe(aSeries);
		expect(results[0].book).toBe(a);
	});

	it('keeps the existing score, method, and reasons for eligible canonical starters', () => {
		const first = book(), candidate = series([first]), chosenSeed = seed();
		const expected = recommend(chosenSeed, [first])[0];
		const actual = recommendSeries(chosenSeed, [candidate], index(first))[0];
		expect(actual).toMatchObject({ score: expected.score, method: expected.method, reasons: expected.reasons });
		expect(actual.book).toBe(first);
		expect(recommendSeries(chosenSeed, [candidate], index(first), { limit: 0 })).toEqual([]);
	});
});

describe('legacy listings with missing or incorrect edition identity', () => {
	const laterListings = [
		['B0GPFR9QN9', 'Beef Cutlets and the Bandit King\'s Treasure', 'Campfire Cooking in Another World with My Absurd Skill, Volume 10'],
		['B0GPSFGSSB', 'The Last Portal Jumper: Book 5', 'A LitRPG Progression Fantasy Series'],
		['B0GVGGP2DL', 'Unintended Cultivator: Volume 9', ''],
		['B0GVZKWGPY', '7th Time Loop: The Villainess Enjoys a Carefree Life Married to Her Worst Enemy!, Vol. 3', 'Light Novel'],
		['B0GVZP44TB', 'Trapped in a Dating Sim: Otome Games Are Tough for Us, Too!, Vol. 3', 'Light Novel'],
		['B0GW14J2K7', 'Totally Spiritual 3: An Urban Fantasy LitRPG', 'Totally Spiritual, Book 3'],
		['B0GW16SCR8', 'Journey to the Bees: A Dungeon-Core LitRPG', 'The Bee Dungeon, Book 4'],
		['B0GW1852CQ', 'Undying Depths', 'A Time Regression LitRPG (Fate Alchemist, Book 2)'],
		['B0GW1FRDZD', 'The Warden\'s Reign', 'A Blood Magic Lycanthrope LitRPG (Wolf of the Blood Moon, Book 5)']
	];

	it.each(laterListings)('does not recommend unnumbered later-volume listing %s', (id, title, subtitle) => {
		const later = book({ id, title, subtitle, series: '', seriesKey: id, seriesNumber: null });
		const candidate = series([later]), books = index(later), before = structuredClone(candidate);
		expect(seriesEntry(candidate, books)).toBeNull();
		expect(recommendSeries(seed(), [candidate], books)).toEqual([]);
		// Discovery changes neither membership nor saved IDs used by library progress.
		expect(candidate).toEqual(before);
		expect(books.get(id)).toBe(later);
	});

	it.each(['Book IV', 'Volume IX', 'Part II'])('also rejects an unnumbered %s', subtitle => {
		const later = book({ title: 'A New Journey', subtitle, seriesNumber: null });
		expect(seriesEntry(series([later]), index(later))).toBeNull();
	});

	it.each([
		['Way of the Immortals: The Complete 4-Book Series', 'Isekai Cultivation Fantasy'],
		['Dungeon Exploiters Bundle', 'The Complete GameLit Series'],
		['In Other Worlds - A LitRPG, GameLit, and Fantasy Podcast', ''],
		['Don’t Gaslight Me, Jesus: A Dungeon Crawler Carl Podcast', ''],
		['2026 LitRPG Anthology', '']
	])('rejects misclassified audiobook %s', (title, subtitle) => {
		for (const seriesNumber of [null, 1]) {
			const listing = book({ title, subtitle, seriesNumber, edition: 'audiobook' });
			expect(seriesEntry(series([listing]), index(listing))).toBeNull();
			expect(recommendSeries(seed(), [series([listing])], index(listing))).toEqual([]);
		}
	});

	it.each([
		['12 Miles Below', 'A Progression Fantasy'],
		['Operation Bounce House', ''],
		['The Book of the Dead', ''],
		['Stratus Online: Awakening', 'A LitRPG Series, Book 1'],
		['A New Journey', 'Book I'],
		['A New Journey', 'Part I']
	])('keeps legitimate unnumbered entry %s without assigning a volume', (title, subtitle) => {
		const first = book({ title, subtitle, seriesNumber: null });
		const candidate = series([first]), entry = seriesEntry(candidate, index(first));
		expect(entry?.book).toBe(first);
		expect(entry?.work.number).toBeNull();
		expect(candidate.works[0].number).toBeNull();
	});

	it('retains a legitimate first-volume edition when a bundled alias is present', () => {
		const first = book(), bundle = book({ id: 'BUNDLE', title: 'Test Series: Books 1–3', ratingCount: 1_000_000 });
		const candidate = series([first], { works: [work(first, { bookId: bundle.id, editionIds: [first.id, bundle.id] })] });
		expect(seriesEntry(candidate, index(first, bundle))?.book).toBe(first);
		expect(candidate.works[0].editionIds).toEqual([first.id, bundle.id]);
	});

	it('keeps The Wandering Inn first audiobook despite its internal Parts 1 and 2 label', () => {
		const first = book({ id: '1774240327', title: 'The Wandering Inn', subtitle: 'The Wandering Inn Series, Book 1: Parts 1 and 2' });
		expect(seriesEntry(series([first]), index(first))?.book).toBe(first);
	});
});
