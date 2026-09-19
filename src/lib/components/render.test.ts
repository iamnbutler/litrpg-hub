import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { CatalogBook, ContentSignal } from '../catalog.js';
import { groupSeries } from '../series.js';
import { emptyLibrary, markSeriesRead, seriesProgress, setWorkStatus } from '../library.js';
import UpNextRow from './UpNextRow.svelte';
import SeriesTile from './SeriesTile.svelte';
import SeriesDetail from './SeriesDetail.svelte';
import ReaderImpressions from './ReaderImpressions.svelte';
import BookDetail from './BookDetail.svelte';

const TODAY = '2026-09-18';
const sig = (): ContentSignal => ({ verdict: 'unknown', confidence: 0, source: 'unknown', note: '' });
const makeBook = (f: Partial<CatalogBook> = {}): CatalogBook => ({
	id: 'A1', title: 'Dungeon Crawler Carl', subtitle: '', author: 'Matt Dinniman', narrator: 'Jeff Hays',
	series: 'Dungeon Crawler Carl', seriesKey: 'dcc--md', seriesNumber: 1, releaseDate: '2021-01-28',
	coverUrl: null, runtimeMinutes: 900, subgenres: ['litrpg'], description: 'A dungeon and a cat.', url: null,
	rating: 4.8, ratingCount: 5000, edition: 'audiobook', scope: 'indexed', sources: [], issues: [], assessment: null,
	content: { sexualized: sig(), explicit: sig(), harem: sig(), aiNarration: sig(), aiWriting: sig(), quality: sig() }, ...f
});
const vol = (n: number, title: string, date: string | null) => makeBook({ id: `A${n}`, seriesNumber: n, title, releaseDate: date });
const build = (books: CatalogBook[]) => groupSeries(books)[0];
/** Source affirms it holds the whole series; without it the app will not claim currency. */
const NOW = '2026-09-18T12:00:00.000Z';
/** Reviewed audio coverage, still fresh — the only thing that licenses "Up to date". */
const whole = (books: CatalogBook[]) => {
	const series = groupSeries(books)[0];
	return { ...series, audioCoverage: {
		status: 'verified' as const, current: true, assessedAt: '2026-09-18T00:00:00.000Z',
		manifestId: 'm1', scope: 'numbered-mainline' as const, language: 'en', marketplaces: ['US'],
		verifiedAt: '2026-09-17T00:00:00.000Z', validUntil: '2026-09-24T00:00:00.000Z',
		expectedNumbers: [], releasedWorkIds: series.works.filter((w) => (w.audioReleaseDate ?? '') <= TODAY).map((w) => w.id),
		scheduledWorkIds: [], works: [], sourceUrls: [], issues: []
	} };
};
const bookMap = (books: CatalogBook[]) => new Map(books.map((b) => [b.id, b]));

const tile = (series: ReturnType<typeof build>, books: CatalogBook[], library = emptyLibrary(), following = false) =>
	render(SeriesTile, { props: {
		series, cover: bookMap(books).get(series.coverBookId), progress: seriesProgress(library, series, NOW),
		following, latest: '2021-05-14', upcoming: 0, onopen: () => {}, onfollow: () => {}
	} }).body;

describe('series tile rendering', () => {
	const books = [vol(1, 'One', '2021-01-28'), vol(2, 'Two', '2021-04-22'), vol(3, 'Three', '2021-05-14')];
	const series = build(books);
	it('leads with the series title and author, not a marketing headline', () => {
		const html = tile(series, books);
		expect(html).toContain('Dungeon Crawler Carl');
		expect(html).toContain('Matt Dinniman');
		expect(html).toContain('3 audiobooks');
		expect(html).toContain('+ Follow');
	});
	it('shows read progress once the reader has started', () => {
		const library = setWorkStatus(emptyLibrary(), series, series.works[0], 'read');
		expect(tile(series, books, library)).toContain('1 of 3 read');
	});
	it('shows up to date only on reviewed, still-fresh audio coverage', () => {
		const full = whole(books);
		expect(tile(full, books, markSeriesRead(emptyLibrary(), full, TODAY))).toContain('Up to date');
		// Same reads, no coverage: we will not claim currency on our own numbering alone.
		const uncovered = build(books);
		const html = tile(uncovered, books, markSeriesRead(emptyLibrary(), uncovered, TODAY));
		expect(html).toContain('All known audio read');
		expect(html).not.toContain('Up to date');
	});
	it('falls back to the weaker state when a gap is all we have to go on', () => {
		const gappy = [vol(1, 'One', '2021-01-28'), vol(3, 'Three', '2021-05-14')];
		const series = build(gappy);
		const html = tile(series, gappy, markSeriesRead(emptyLibrary(), series, TODAY));
		expect(html).toContain('All known audio read');
		expect(html).not.toContain('Up to date');
	});
	it('lets reviewed coverage settle a numbering gap it has already accounted for', () => {
		// A reviewed manifest enumerates the real mainline, so our own gap heuristic defers to it.
		const gappy = [vol(1, 'One', '2021-01-28'), vol(3, 'Three', '2021-05-14')];
		const series = whole(gappy);
		expect(tile(series, gappy, markSeriesRead(emptyLibrary(), series, TODAY))).toContain('Up to date');
	});
	it('will not claim currency for an ongoing series whose list may be truncated', () => {
		// Awaken Online in the live catalog: curated, ongoing, exactly one work held.
		const single = [vol(1, 'One', '2021-01-28')];
		const ongoing = { ...build(single), status: 'ongoing' as const, curated: true };
		const html = tile(ongoing, single, markSeriesRead(emptyLibrary(), ongoing, TODAY));
		expect(html).toContain('All known audio read');
		expect(html).not.toContain('Up to date');
	});
});

describe('series detail rendering', () => {
	const books = [vol(1, 'One', '2021-01-28'), vol(3, 'Three', '2021-05-14'), vol(4, 'Four', '2027-01-01')];
	const series = build(books);
	const detail = (library = emptyLibrary()) => render(SeriesDetail, { props: {
		series, books: bookMap(books), library, progress: seriesProgress(library, series, NOW), today: TODAY,
		following: true, onback: () => {}, onfollow: () => {}, onmarkall: () => {}, onwork: () => {}, onthrough: () => {}, onopenbook: () => {}, onlike: () => {}
	} }).body;

	it('lists audiobooks in order with per-book read controls', () => {
		const html = detail();
		expect(html).toContain('Mark read');
		expect(html).toContain('Mark all as read');
		expect(html).toContain('Following');
		expect(html.indexOf('>One<')).toBeLessThan(html.indexOf('>Three<'));
	});
	it('counts only released audiobooks and names the announced one separately', () => {
		const html = detail();
		expect(html).toContain('2 released audiobooks');
		expect(html).toContain('1 announced');
	});
	it('disables the read control for an unreleased audiobook', () => {
		expect(detail()).toMatch(/<button[^>]*class="read-toggle[^"]*"[^>]*disabled/);
	});
	it('explains exactly why it will not claim the reader is current', () => {
		const html = detail(markSeriesRead(emptyLibrary(), series, TODAY));
		expect(html).toContain('All known audio read');
		expect(html).toContain('Book 2 is missing from this list');
		expect(html).not.toContain('>Up to date<');
	});
});

describe('catching up part-way through a series', () => {
	const books = [vol(1, 'One', '2021-01-28'), vol(2, 'Two', '2022-01-01'), vol(3, 'Three', '2027-01-01')];
	const series = build(books);
	const detail = (library = emptyLibrary()) => render(SeriesDetail, { props: {
		series, books: bookMap(books), library, progress: seriesProgress(library, series, NOW), today: TODAY,
		following: true, onback: () => {}, onfollow: () => {}, onmarkall: () => {}, onwork: () => {}, onthrough: () => {}, onopenbook: () => {}, onlike: () => {}
	} }).body;

	it('offers a listened-through control listing only released audiobooks', () => {
		const html = detail();
		expect(html).toContain('Already listened through');
		expect(html).toContain('Book 1 · One');
		expect(html).toContain('Book 2 · Two');
		// Book 3 is announced, not out, so it is not a valid catch-up point.
		expect(html).not.toContain('Book 3 · Three');
	});
	it('drops the control once nothing released is unread', () => {
		expect(detail(markSeriesRead(emptyLibrary(), series, TODAY))).not.toContain('Already listened through');
	});
});

describe('up next queue', () => {
	const books = [vol(1, 'One', '2021-01-28'), vol(2, 'Two', '2022-01-01')];
	const series = build(books);
	it('names the series, the next book and what remains behind it', () => {
		const html = render(UpNextRow, { props: {
			series, work: series.works[0], book: bookMap(books).get(series.works[0].bookId), remaining: 2,
			onopen: () => {}, onread: () => {}, onopenbook: () => {}
		} }).body;
		expect(html).toContain('Book 1 · One');
		expect(html).toContain('Dungeon Crawler Carl');
		expect(html).toContain('1 more after this');
		expect(html).toContain('Mark read');
	});
	it('does not promise more books when this is the last one', () => {
		const html = render(UpNextRow, { props: {
			series, work: series.works[1], book: bookMap(books).get(series.works[1].bookId), remaining: 1,
			onopen: () => {}, onread: () => {}, onopenbook: () => {}
		} }).body;
		expect(html).not.toContain('more after this');
	});
});

describe('canonical starter drives the series page', () => {
	const vol1 = makeBook({ id: 'V1', seriesNumber: 1, title: 'Volume One', releaseDate: '2021-01-01', description: 'The description of volume one.' });
	const vol2 = makeBook({ id: 'V2', seriesNumber: 2, title: 'Volume Two', releaseDate: '2022-01-01', description: 'A much later volume, full of spoilers.' });
	const series = { ...build([vol1, vol2]), coverBookId: 'V2', description: '' };
	const detail = (starter?: CatalogBook) => render(SeriesDetail, { props: {
		series, books: bookMap([vol1, vol2]), library: emptyLibrary(), progress: seriesProgress(emptyLibrary(), series, NOW), today: TODAY,
		following: false, starter, onback: () => {}, onfollow: () => {}, onmarkall: () => {}, onwork: () => {}, onthrough: () => {}, onopenbook: () => {}, onlike: () => {}
	} }).body;

	it('renders the description of the canonical starter it was handed', () => {
		const html = detail(vol1);
		expect(html).toContain('The description of volume one.');
		expect(html).not.toContain('full of spoilers');
	});
	it('falls back to the series cover book when no starter is supplied', () => {
		expect(detail()).toContain('full of spoilers');
	});
});

describe('the library is honest about gaps', () => {
	const gappy = [vol(1, 'One', '2021-01-28'), vol(4, 'Four', '2024-01-01')];
	const series = build(gappy);
	it('names the missing volumes on the series page', () => {
		const library = markSeriesRead(emptyLibrary(), series, TODAY);
		const html = render(SeriesDetail, { props: {
			series, books: bookMap(gappy), library, progress: seriesProgress(library, series, NOW), today: TODAY,
			following: true, onback: () => {}, onfollow: () => {}, onmarkall: () => {}, onwork: () => {}, onthrough: () => {}, onopenbook: () => {}, onlike: () => {}
		} }).body;
		expect(html).toContain('Book 2, 3 are missing from this list');
		expect(html).toContain('This list may be incomplete');
		expect(html).not.toContain('>Up to date<');
	});
	it('keeps a followed series legible on the card even with gaps', () => {
		const library = markSeriesRead(emptyLibrary(), series, TODAY);
		const html = tile(series, gappy, library, true);
		expect(html).toContain('All known audio read');
		expect(html).toContain('Following');
	});
});

describe('reader impressions rendering', () => {
	const ctx = {
		entity: 'A1', voices: 900, substantiveVoices: 18, samples: 40, meanRating: 4.62,
		span: ['2024-03-02', '2026-01-19'] as [string, string], sampling: 'bounded-public-review-sample' as const, consensus: 'mixed' as const,
		sources: [{ name: 'Goodreads', url: 'https://www.goodreads.com/book/1' }],
		traits: [
			{ trait: 'progression', value: 'steady', confidence: 0.88, modelConfidence: 0.91, summary: 'Readers split on the mid-series pacing.', voices: 9 },
			{ trait: 'narration', value: 'excellent', confidence: 0.8, modelConfidence: 0.8, summary: 'Listeners praise the narrator range.', voices: 12 }
		]
	};
	const show = (context?: typeof ctx) => render(ReaderImpressions, { props: { context } }).body;

	it('renders nothing at all when there is no reader context', () => {
		// This is today's live state: the type exists, no book carries data yet.
		expect(show(undefined).trim()).not.toContain('Reader impressions');
	});
	it('reports the sampled count and never the raw voice total', () => {
		const html = show(ctx);
		expect(html).toContain('From 18 reader reviews');
		expect(html).not.toContain('900');
	});
	it('never prints a model confidence as if it were reader agreement', () => {
		const html = show(ctx);
		expect(html).not.toMatch(/\b(88|91|80)\s*%/);
		expect(html).not.toContain('0.88');
		expect(html).not.toContain('confidence');
	});
	it('never prints the sample mean where it could read as a site rating', () => {
		expect(show(ctx)).not.toContain('4.62');
	});
	it('marks disagreement qualitatively', () => {
		expect(show(ctx)).toContain('Readers disagreed about this one');
	});
	it('says readers rather than claiming everyone listened', () => {
		const html = show(ctx);
		expect(html).toContain('in print or ebook rather than listening');
	});
	it('links its sources', () => {
		expect(show(ctx)).toContain('https://www.goodreads.com/book/1');
	});
});

describe('series status wording', () => {
	const books = [vol(1, 'One', '2021-01-28')];
	const panel = (series: ReturnType<typeof build>) => render(SeriesDetail, { props: {
		series, books: bookMap(books), library: emptyLibrary(), progress: seriesProgress(emptyLibrary(), series, NOW),
		today: TODAY, now: NOW, following: false, onback: () => {}, onfollow: () => {}, onmarkall: () => {},
		onwork: () => {}, onthrough: () => {}, onopenbook: () => {}, onlike: () => {}
	} }).body;

	it('says the STORY is complete, never implying the audio list is', () => {
		const html = panel({ ...build(books), status: 'complete' });
		expect(html).toContain('Story complete');
		// A bare "Complete" beside audiobook counts reads as "all the audio is here".
		expect(html).not.toMatch(/>\s*Complete\s*</);
	});
	it('labels an ongoing story as such', () => {
		expect(panel({ ...build(books), status: 'ongoing' })).toContain('Story ongoing');
	});
	it('shows when the audio list was last source-checked', () => {
		expect(panel(whole(books))).toContain('Audio list checked');
	});
	it('shows no check date when nothing has been verified', () => {
		expect(panel(build(books))).not.toContain('Audio list checked');
	});
});

describe('observation-led reader impressions', () => {
	const base = {
		entity: 'A1', voices: 900, substantiveVoices: 47, samples: 50, meanRating: 3.81,
		span: ['2024-03-02', '2026-01-19'] as [string, string], sampling: 'bounded-public-review-sample' as const,
		sources: [{ name: 'Hardcover', url: 'https://hardcover.app/books/cradle' }], consensus: 'consistent' as const,
		traits: [] as { trait: string; value: string; confidence: number; modelConfidence: number; summary: string; voices: number }[]
	};
	const observation = 'Readers describe a fast-paced climb despite some initial slow setup.';
	const show = (context: typeof base & { observation?: string | null }) => render(ReaderImpressions, { props: { context } }).body;

	it('renders from an observation with no traits at all', () => {
		const html = show({ ...base, observation });
		expect(html).toContain(observation);
		expect(html).toContain('From 47 reader reviews');
		expect(html).toContain('in print or ebook rather than listening');
	});
	it('does not print a contradictory binary label beside the observation', () => {
		// The observation itself may well mention slowness — what must not appear is the
		// flattened label "Pacing slow" presented as the sample's verdict.
		const html = show({ ...base, observation, traits: [{ trait: 'pacing-slow', value: 'present', confidence: 0.9, modelConfidence: 1, summary: 'DISTINCT_TRAIT_SUMMARY', voices: 40 }] });
		expect(html).toContain(observation);
		expect(html).not.toContain('Pacing slow');
		expect(html).not.toContain('DISTINCT_TRAIT_SUMMARY');
		expect(html).not.toContain('40 mentioned it');
	});
	it('keeps model confidence out of an observation-led view', () => {
		const html = show({ ...base, observation, traits: [{ trait: 'humour', value: 'present', confidence: 0.9, modelConfidence: 1, summary: 'x', voices: 40 }] });
		expect(html).not.toContain('0.9');
		expect(html).not.toMatch(/\b90\s*%/);
		expect(html).not.toContain('3.81');
	});
});

describe('release labels agree across the whole UI', () => {
	// A stale PAST row date that coverage has corrected to scheduled.
	const books = [vol(1, 'One', '2021-01-28'), vol(2, 'Two', '2022-01-01')];
	const base = build(books);
	const corrected = {
		...base,
		audioCoverage: {
			status: 'verified' as const, current: true, assessedAt: '2026-09-18T00:00:00.000Z',
			manifestId: 'm1', scope: 'numbered-mainline' as const, language: 'en', marketplaces: ['US'],
			verifiedAt: '2026-09-17T00:00:00.000Z', validUntil: '2026-09-24T00:00:00.000Z',
			expectedNumbers: [1, 2], releasedWorkIds: [base.works[0].id], scheduledWorkIds: [base.works[1].id],
			works: [{ workId: base.works[1].id, number: 2, state: 'scheduled' as const, releaseDate: '2026-12-01', editionIds: [] }],
			sourceUrls: [], issues: []
		}
	};

	it('shows the corrected date in the up-next queue, not the catalogued row', () => {
		const html = render(UpNextRow, { props: {
			series: corrected, work: base.works[1], book: bookMap(books).get(base.works[1].bookId),
			remaining: 1, now: NOW, onopen: () => {}, onread: () => {}, onopenbook: () => {}
		} }).body;
		expect(html).toContain('Dec 1, 2026');
		expect(html).not.toContain('2022');
	});

	it('shows the corrected date in the book dialog, not the edition row', () => {
		const book = bookMap(books).get(base.works[1].bookId)!;
		const html = render(BookDetail, { props: {
			book, series: corrected, books: bookMap(books), library: emptyLibrary(), today: TODAY, now: NOW,
			onclose: () => {}, onshelf: () => {}, onrating: () => {}, onlike: () => {}, onopen: () => {}, onseries: () => {}
		} }).body;
		expect(html).toContain('Dec 1, 2026');
	});

	it('agrees with the series page about the same volume', () => {
		const html = render(SeriesDetail, { props: {
			series: corrected, books: bookMap(books), library: emptyLibrary(),
			progress: seriesProgress(emptyLibrary(), corrected, NOW), today: TODAY, now: NOW, following: false,
			onback: () => {}, onfollow: () => {}, onmarkall: () => {}, onwork: () => {}, onthrough: () => {}, onopenbook: () => {}, onlike: () => {}
		} }).body;
		expect(html).toContain('Dec 1, 2026');
		// And the control for an unreleased book stays disabled, matching the label.
		expect(html).toMatch(/<button[^>]*class="read-toggle[^"]*"[^>]*disabled/);
	});
});

describe('the trait fallback makes no per-trait claims', () => {
	const ctx = {
		entity: 'A1', voices: 900, substantiveVoices: 18, samples: 40, meanRating: 4.62,
		span: ['2024-03-02', '2026-01-19'] as [string, string], sampling: 'bounded-public-review-sample' as const,
		sources: [], consensus: 'consistent' as const, observation: null,
		traits: [{ trait: 'humour', value: 'present', confidence: 0.88, modelConfidence: 0.91, summary: 'Readers found it funny.', voices: 9 }]
	};
	it('renders the trait without claiming how many readers raised it', () => {
		// This fallback only appears when an observation is missing or stale, so it has to be
		// correct on its own.
		const html = render(ReaderImpressions, { props: { context: ctx } }).body;
		expect(html).toContain('Humour');
		expect(html).toContain('Readers found it funny.');
		expect(html).not.toContain('mentioned it');
		expect(html).not.toContain('9 ');
		expect(html).toContain('From 18 reader reviews');
	});
});

describe('a coverage-derived unknown never revives the catalogued date', () => {
	const detail = (book: CatalogBook, series: ReturnType<typeof build> | null, now = NOW) => render(BookDetail, { props: {
		book, series, books: bookMap([book]), library: emptyLibrary(), today: TODAY, now,
		onclose: () => {}, onshelf: () => {}, onrating: () => {}, onlike: () => {}, onopen: () => {}, onseries: () => {}
	} }).body;
	const withCoverage = (over: Record<string, unknown>) => {
		const base = build([vol(1, 'One', '2021-01-28')]);
		return { ...base, audioCoverage: {
			status: 'verified' as const, current: true, assessedAt: '2026-09-18T00:00:00.000Z', manifestId: 'm1',
			scope: 'numbered-mainline' as const, language: 'en', marketplaces: ['US'],
			verifiedAt: '2026-09-17T00:00:00.000Z', validUntil: '2026-09-24T00:00:00.000Z',
			expectedNumbers: [1], releasedWorkIds: [], scheduledWorkIds: [], works: [], sourceUrls: [], issues: [], ...over
		} };
	};

	it('says release unconfirmed rather than showing a stale PAST row date', () => {
		const book = vol(1, 'One', '2021-01-28');
		// The manifest does not vouch for this work; the row still carries an old date.
		const html = detail(book, withCoverage({ issues: [{ code: 'missing-verified-audio', message: 'x', workId: build([book]).works[0].id }] }));
		expect(html).toContain('Release not confirmed');
		expect(html).not.toContain('Jan 28, 2021');
	});
	it('says release unconfirmed rather than showing a stale FUTURE row date', () => {
		const book = vol(1, 'One', '2027-05-04');
		const html = detail(book, withCoverage({ issues: [{ code: 'unknown-audio-date', message: 'x', workId: build([book]).works[0].id }] }));
		expect(html).toContain('Release not confirmed');
		expect(html).not.toContain('2027');
	});
	it('still shows the edition date when no coverage resolves the work at all', () => {
		const book = vol(1, 'One', '2021-01-28');
		expect(detail(book, null)).toContain('Jan 28, 2021');
	});
});

describe('podcasts are not audiobooks', () => {
	const podcast = makeBook({ id: 'POD1', title: 'The Primal Podcast', seriesNumber: null, releaseDate: '2024-01-01' });
	it('labels a retailer podcast as Podcast, not Audiobook', () => {
		const html = render(BookDetail, { props: {
			book: podcast, series: null, books: bookMap([podcast]), library: emptyLibrary(), today: TODAY, now: NOW,
			onclose: () => {}, onshelf: () => {}, onrating: () => {}, onlike: () => {}, onopen: () => {}, onseries: () => {}
		} }).body;
		expect(html).toContain('Podcast');
		expect(html).not.toContain('>Audiobook<');
	});
	it('keeps podcasts out of the mainline volumes of a series', () => {
		const grouped = groupSeries([vol(1, 'One', '2021-01-28'), makeBook({ id: 'POD2', seriesNumber: null, title: 'The Series Podcast', releaseDate: '2024-01-01' })]);
		expect(grouped.flatMap((s) => s.works).some((w) => w.editionIds.includes('POD2'))).toBe(false);
	});
});
