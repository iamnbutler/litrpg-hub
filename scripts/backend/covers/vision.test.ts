import { describe, expect, it, vi } from 'vitest';
import { coverCacheKey, fetchCover, observeCover, toCoverAssessment, validateObservation } from './vision.js';
import { contentAssessmentHash } from './content.js';
import { classifyContent } from '../classifiers/content.js';
import { defaultFilters, passesFilters, type CatalogBook } from '../../../src/lib/catalog.js';

const metadata = { model: 'gpt-4.1-mini-test', evaluatedAt: '2026-09-18T00:00:00Z', imageHash: 'abc123', coverUrl: 'https://m.media-amazon.com/images/I/cover.jpg' };
const sexualized = toCoverAssessment({ level: 'sexualized', confidence: 0.9, observations: ['A cleavage-focused pin-up composition with a revealing fantasy costume.'] }, metadata);
const source = { title: 'Master Blacksmith', subtitle: 'An Isekai Fantasy', author: 'Jack Spry, Liam Gray', series: 'Master Blacksmith', narrator: 'Jim Swanson, Rose Trailings', description: 'His enjoyable life was ripped away from him when a princess from another world summoned him into her realm.' };

describe('cover evidence and reader filters', () => {
	it('hides a sexualized cover even when the short blurb never mentions sex or harem', () => {
		const book = { ...source, content: { ...classifyContent(source), sexualized: sexualized.signal } } as CatalogBook;
		expect(book.content.explicit.verdict).toBe('unknown');
		expect(book.content.harem.verdict).toBe('unknown');
		expect(passesFilters(book, defaultFilters)).toBe(false);
		expect(passesFilters(book, { ...defaultFilters, hideSexualized: false })).toBe(true);
	});
	it('keeps ambiguous or low-confidence covers visible and distinct from cleared covers', () => {
		for (const observation of [{ level: 'suggestive' as const, confidence: 0.99, observations: ['The styling is ambiguous.'] }, { level: 'sexualized' as const, confidence: 0.4, observations: ['The cover is difficult to read.'] }]) {
			const book = { ...source, content: { ...classifyContent(source), sexualized: toCoverAssessment(observation, metadata).signal } } as CatalogBook;
			expect(passesFilters(book, defaultFilters)).toBe(true);
			expect(passesFilters(book, { ...defaultFilters, hideUnknown: true })).toBe(false);
		}
	});
	it('invalidates decisions after a cover, model, or blurb changes', () => {
		expect(coverCacheKey('first')).not.toBe(coverCacheKey('second'));
		expect(coverCacheKey('first','model-a')).not.toBe(coverCacheKey('first','model-b'));
		expect(contentAssessmentHash(source,sexualized)).not.toBe(contentAssessmentHash({ ...source, description: 'A changed description.' },sexualized));
	});
	it('does not let invalid observations become confident filter flags', () => {
		expect(() => validateObservation({ level: 'sexualized', confidence: 9, observations: ['Claim'] })).toThrow();
		expect(() => validateObservation({ level: 'none', confidence: 0.9, observations: [] })).toThrow();
	});
});

describe('cover API boundary', () => {
	it('rejects non-source URLs, redirects, and HTML masquerading as image content', async () => {
		const request = vi.fn();
		await expect(fetchCover('http://127.0.0.1/secrets',request)).rejects.toThrow(/approved/);
		expect(request).not.toHaveBeenCalled();
		const html = vi.fn().mockResolvedValue(new Response('<html>throttled</html>', { headers: { 'content-type': 'image/jpeg' } }));
		await expect(fetchCover(metadata.coverUrl,html)).rejects.toThrow(/bytes/);
		expect(html.mock.calls[0][1].redirect).toBe('error');
	});
	it('treats a model refusal as unclassified, never as a negative result', async () => {
		const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', model: 'test', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Declined' }] }] })));
		await expect(observeCover({ data: Buffer.from('image'), mime: 'image/jpeg' }, { apiKey: 'test', fetch: request })).rejects.toThrow(/unclassified/);
	});
	it('fails on unauthorized responses without logging an echoed credential', async () => {
		const request = vi.fn().mockResolvedValue(new Response('secret credential', { status: 401 }));
		await expect(observeCover({ data: Buffer.from('image'), mime: 'image/jpeg' }, { apiKey: 'test', fetch: request })).rejects.toThrow('HTTP 401');
		expect(request).toHaveBeenCalledOnce();
	});
});
