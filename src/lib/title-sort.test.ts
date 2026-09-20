import { describe, expect, it } from 'vitest';
import { compareTitles, titleSortKey } from './title-sort';

describe('catalog title filing order', () => {
	it('files series and books by the title after a leading English article, preserving their names', () => {
		const titles = ['The Primal Hunter', 'A Summoner Awakens', 'Defiance of the Fall', 'An Outcast in Another World', 'Cradle', 'The Wandering Inn', 'Azarinth Healer'];
		const entries = titles.map((title) => ({ title }));
		expect([...entries].sort((a, b) => compareTitles(a.title, b.title)).map((entry) => entry.title)).toEqual([
			'Azarinth Healer', 'Cradle', 'Defiance of the Fall', 'An Outcast in Another World', 'The Primal Hunter', 'A Summoner Awakens', 'The Wandering Inn'
		]);
		expect(entries.map((entry) => entry.title)).toEqual(titles);
	});

	it.each(['a Title', 'AN Title', 'the Title', '  The\tTitle  ', 'An\u00a0Title'])('ignores the article regardless of casing or separating whitespace: %s', (title) => {
		expect(titleSortKey(title)).toBe('Title');
	});

	it.each(['Theodore', 'Anathema', 'A-Team', 'A', 'An', 'The', 'Defiance of the Fall', 'Book of the Dead'])('retains article-like prefixes, standalone words and internal articles: %s', (title) => {
		expect(titleSortKey(title)).toBe(title);
	});

	it('does not use the article as a hidden tiebreaker', () => {
		expect(compareTitles('The Last Hero', 'A Last Hero')).toBe(0);
		expect(compareTitles('An Outcast', 'Outcast')).toBe(0);
	});
});
