import { describe, expect, it } from 'vitest';
import { classifyContent, narrationSignal } from './classifiers/content.js';
import { collapsePlaceholderDuplicates, defaultFilters, passesFilters, recommend, seriesIdentity, seriesStarters, validReleaseDate, type Assessment, type CatalogBook } from '../../src/lib/catalog.js';
import { matchesSeries, parseSeriesPage, type SeriesReference } from './fetchers/series.js';
import { catalogPage } from './fetchers/audible.js';
import { applyAuthorRules } from './classifiers/authors.js';

const makeBook = (fields: Partial<CatalogBook> = {}): CatalogBook => ({
	id: 'BOOK000001', title: 'A new adventure', subtitle: '', author: 'Author', narrator: null,
	series: 'The First World', seriesKey: 'first--author', seriesNumber: 1, releaseDate: '2026-01-01',
	coverUrl: null, runtimeMinutes: null, subgenres: ['litrpg'], description: 'A detailed description of a world with levels and friends.',
	url: null, rating: 4.5, ratingCount: 100, edition: 'audiobook', scope: 'indexed', sources: [], issues: [], assessment: null,
	content: classifyContent({ title: 'A new adventure', subtitle: '', description: '', narrator: null }), ...fields
});

describe('content filtering regressions', () => {
	it('inherits a reviewed author filter for new and unassessed titles without guessing story explicitness', () => {
		const book=makeBook({author:'Bruce Sentar',title:'A future title'});applyAuthorRules(book);
		expect(passesFilters(book,defaultFilters)).toBe(false);
		expect(book.content.sexualized.source).toBe('manual');
		expect(book.content.explicit.verdict).toBe('unknown');
		const unrelated=makeBook({author:'Bruce Sentarson'});applyAuthorRules(unrelated);
		expect(passesFilters(unrelated,defaultFilters)).toBe(true);
	});
	it('does not call missing narrator metadata AI narration', () => {
		expect(narrationSignal(null).verdict).toBe('unknown');
		expect(narrationSignal('Virtual Voice').verdict).toBe('present');
		expect(narrationSignal('Jeff Hays').verdict).toBe('absent');
	});
	it('honors no-harem and no-explicit-content disclaimers', () => {
		const content = classifyContent({ title: 'A LitRPG adventure', subtitle: '', narrator: null, description: 'No harem. No explicit sexual content. Just friends and battles.' });
		expect(content.harem.verdict).toBe('absent');
		expect(content.explicit.verdict).toBe('absent');
	});
	it('does not equate romance, spicy food, or mature themes with erotica', () => {
		const content = classifyContent({ title: 'Spicy Noodles', subtitle: '', narrator: null, description: 'A mature adventure with a romance subplot and a mixed party. The chef grows spicy peppers.' });
		expect(content.explicit.verdict).toBe('unknown');
		expect(content.harem.verdict).toBe('unknown');
	});
	it('flags positive disclosures but never guesses AI authorship', () => {
		const content = classifyContent({ title: 'An adventure', subtitle: '', narrator: null, description: 'A harem LitRPG with explicit sexual content. An unusual repetitive plot.' });
		expect(content.explicit.verdict).toBe('present');
		expect(content.harem.verdict).toBe('present');
		expect(content.aiWriting.verdict).toBe('unknown');
	});
	it('keeps unknown and low-confidence assessments visible by default', () => {
		const book = makeBook();
		book.content.explicit = { verdict: 'present', source: 'jev', confidence: 0.6, note: 'Uncertain' };
		expect(passesFilters(book, defaultFilters)).toBe(true);
		book.content.explicit.confidence = 0.95;
		expect(passesFilters(book, defaultFilters)).toBe(false);
		expect(passesFilters(book, { ...defaultFilters, hideExplicit: false })).toBe(true);
		expect(passesFilters(makeBook(), { ...defaultFilters, hideUnknown: true })).toBe(false);
	});
});

describe('catalog identities and recommendations', () => {
	it('hides duplicate backfill placeholders without hiding different narrators or dates', () => {
		const known = makeBook({ narrator: 'Jeff Hays, Guest', runtimeMinutes: 700 });
		const placeholder = makeBook({ id: 'PLACEHOLDER', narrator: 'Jeff Hays', ratingCount: 0 });
		const otherNarrator = makeBook({ ...placeholder, id: 'OTHER', narrator: 'Another narrator' });
		expect(collapsePlaceholderDuplicates([known, placeholder, otherNarrator]).map(b => b.id)).toEqual([known.id, 'OTHER']);
		expect(collapsePlaceholderDuplicates([placeholder])).toHaveLength(1);
	});
	it('separates same-named series by author and normalizes punctuation / extra credits', () => {
		expect(seriesIdentity('The Path of Ascension', 'C. Mantis')).toBe(seriesIdentity('The Path of Ascension', 'C Mantis'));
		expect(seriesIdentity('The Path of Ascension', 'C. Mantis')).not.toBe(seriesIdentity('The Path of Ascension', 'Rey Clark'));
		expect(seriesIdentity('The Ripple System', 'Kyle Kirrin, Portal Books')).toBe(seriesIdentity('The Ripple System', 'Kyle Kirrin'));
	});
	it('uses the earliest standard edition and preserves same-titled independent series', () => {
		const first = makeBook();
		const sequel = makeBook({ id: 'SECOND', seriesNumber: 2, ratingCount: 100000 });
		const drama = makeBook({ id: 'DRAMA', seriesNumber: 1, edition: 'dramatized' });
		const other = makeBook({ id: 'OTHER', author: 'Other', seriesKey: 'first--other' });
		expect(seriesStarters([sequel, drama, first, other]).map(b => b.id)).toEqual([first.id, other.id]);
	});
	it('does not recommend a sequel or another edition of the seed', () => {
		const seed = makeBook();
		const sequel = makeBook({ id: 'SECOND', seriesNumber: 2 });
		const other = makeBook({ id: 'OTHER', series: 'Other', seriesKey: 'other--author' });
		const results = recommend(seed, [seed, sequel, other]);
		expect(results.map(r => r.book.id)).toEqual(['OTHER']);
		expect(results[0].method).toBe('genres');
	});
	it('prefers similar confident traits over raw popularity', () => {
		const profile = (stats: number, humor: number, cozy: number) => ({ taste: { stats: { value: stats, confidence: 1 }, humor: { value: humor, confidence: 1 }, cozy: { value: cozy, confidence: 1 } } }) as Assessment;
		const seed = makeBook({ assessment: profile(0.9, 0.9, 0.1) });
		const match = makeBook({ id: 'MATCH', seriesKey: 'match--author', assessment: profile(0.8, 0.9, 0.1) });
		const popular = makeBook({ id: 'POPULAR', seriesKey: 'popular--author', ratingCount: 1000000, assessment: profile(0.1, 0.1, 0.9) });
		expect(recommend(seed, [popular, match])[0]).toMatchObject({ book: { id: 'MATCH' }, method: 'taste' });
	});
	it('rejects placeholder and impossible dates but keeps valid date-only values unchanged', () => {
		const now = new Date('2026-09-18T12:00:00Z');
		expect(validReleaseDate('2200-01-01', now)).toBeNull();
		expect(validReleaseDate('2026-02-30', now)).toBeNull();
		expect(validReleaseDate('2026-01-01T00:00:00Z', now)).toBe('2026-01-01');
	});

});

describe('source integrity', () => {
	it('treats soft throttles and malformed payloads as failure, not an empty catalog', () => {
		expect(() => catalogPage({ products: [], total_results: 100 }, 1)).toThrow(/incomplete/i);
		expect(() => catalogPage({}, 1)).toThrow(/incomplete/i);
		expect(() => catalogPage({ products: [{ asin: 'B000000001' }], total_results: 100 }, 1)).toThrow(/incomplete/i);
		expect(catalogPage({ products: [], total_results: 0 }, 1).exhausted).toBe(true);
	});
	it('reads product containers and only follows same-series pagination', () => {
		const page = parseSeriesPage(`<li class="productListItem" id="product-list-item-B000000001"><a href="/pd/book/B000000001">Book</a></li>
			<a href="/pd/recommendation/B999999999">Recommendation</a><a href="?page=2">Next</a><a href="https://attacker.example/series/books/B000000000?page=3">Bad</a>`, 'https://www.audible.com/series/books/B000000000');
		expect(page.asins).toEqual(['B000000001']);
		expect(page.next).toBe('https://www.audible.com/series/books/B000000000?page=2');
		expect(() => parseSeriesPage('<html>Nothing</html>', 'https://www.audible.com/series/books/B000000000')).toThrow(/No series product list/);
	});
	it('requires both the source series ID and a known author', () => {
		const series: SeriesReference = { id: 'path', asin: 'SERIES0001', title: 'The Path of Ascension', slug: 'path', authors: ['C. Mantis'], genres: ['litrpg'] };
		const product = { asin: 'B000000001', authors: [{ name: 'C Mantis' }], series: [{ asin: 'SERIES0001', title: 'The Path of Ascension' }] };
		expect(matchesSeries(product, series)).toBe(true);
		expect(matchesSeries({ ...product, authors: [{ name: 'Rey Clark' }] }, series)).toBe(false);
		expect(matchesSeries({ ...product, series: [{ title: series.title, asin: 'WRONG00001' }] }, series)).toBe(false);
	});
});
