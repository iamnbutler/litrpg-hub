import { describe, expect, it } from 'vitest';
import { readerNote, readerIssues } from './content-notes.js';

/** The exact strings the committed snapshot ships, so this is a regression test against real
 * data rather than against invented examples. */
const SHIPPED = {
	quality: 'Jev assessed the publisher listing, not the book’s writing quality or authorship.',
	metadata: 'Jev assessment of the supplied publisher metadata; not independently verified.',
	cover: 'Jev assessed the supplied book metadata; cover art does not establish story content.',
	sexualized: 'Jev assessed the listing and OpenAI cover observations. The cover features a woman in armor facing away from the viewer.',
	unknown: 'Writing quality and AI authorship cannot be established from a listing alone.'
};

describe('readerNote', () => {
	it('drops a note that is nothing but provenance', () => {
		expect(readerNote(SHIPPED.quality)).toBeNull();
	});

	it('keeps a plain caveat left behind by the provenance clause', () => {
		expect(readerNote(SHIPPED.metadata)).toBe('Not independently verified.');
	});

	it('keeps the caveat when only the lead clause names our tooling', () => {
		// Split on the semicolon, and the surviving clause is recapitalised to lead a sentence.
		expect(readerNote(SHIPPED.cover)).toBe('Cover art does not establish story content.');
	});

	it('keeps cover observations, which are real description', () => {
		expect(readerNote(SHIPPED.sexualized)).toBe('The cover features a woman in armor facing away from the viewer.');
	});

	it('passes through a note that never mentioned our tooling', () => {
		expect(readerNote(SHIPPED.unknown)).toBe(SHIPPED.unknown);
	});

	it('never lets a tool name through, even mid-note', () => {
		// Losing the caveat is better than printing an internal name.
		expect(readerNote('The cover is stylised. Jev could not classify it.')).toBeNull();
	});

	it('does not catch a book that genuinely discusses AI', () => {
		const note = 'The publisher describes an AI antagonist.';
		expect(readerNote(note)).toBe(note);
	});

	it('handles absent and malformed values', () => {
		expect(readerNote(undefined)).toBeNull();
		expect(readerNote(null)).toBeNull();
		expect(readerNote(42)).toBeNull();
		expect(readerNote('   ')).toBeNull();
	});
});

describe('readerIssues', () => {
	it('drops our queue and keeps the listing gaps', () => {
		expect(readerIssues([
			'Genre needs review', 'Narrator not supplied', 'Listing quality needs review',
			'Cover not supplied', 'Release date needs confirmation', 'Limited description'
		])).toEqual(['Narrator not supplied', 'Cover not supplied', 'Limited description']);
	});

	it('returns nothing when every issue was a work item', () => {
		expect(readerIssues(['Genre needs review', 'Release date needs confirmation'])).toEqual([]);
	});

	it('deduplicates and ignores malformed entries', () => {
		expect(readerIssues(['Cover not supplied', 'Cover not supplied', 7, '', null])).toEqual(['Cover not supplied']);
	});

	it('handles a missing list', () => {
		expect(readerIssues(undefined)).toEqual([]);
		expect(readerIssues('Genre needs review')).toEqual([]);
	});
});
