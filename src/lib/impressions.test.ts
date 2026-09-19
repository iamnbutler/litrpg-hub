import { describe, expect, it } from 'vitest';
import { readerImpressions } from './impressions.js';
import type { ReaderContext } from './reader-context.js';

const trait = (over: Partial<ReaderContext['traits'][number]> = {}): ReaderContext['traits'][number] => ({
	trait: 'progression', value: 'steady', confidence: 0.8, modelConfidence: 0.8,
	summary: 'Readers describe steady, earned progression.', voices: 9, ...over
});
const context = (over: Partial<ReaderContext> = {}): ReaderContext => ({
	entity: 'B01', voices: 120, substantiveVoices: 18, samples: 40, meanRating: 4.62,
	span: ['2024-03-02', '2026-01-19'], sampling: 'bounded-public-review-sample', consensus: 'consistent',
	sources: [{ name: 'Goodreads', url: 'https://www.goodreads.com/book/1' }], traits: [trait()], ...over
});

describe('selecting what may be shown', () => {
	it('skips missing, empty and thin data entirely', () => {
		expect(readerImpressions(undefined)).toBeNull();
		expect(readerImpressions(null)).toBeNull();
		expect(readerImpressions(context({ substantiveVoices: 0 }))).toBeNull();
		expect(readerImpressions(context({ traits: [] }))).toBeNull();
		// Every trait filtered out leaves nothing worth a section.
		expect(readerImpressions(context({ traits: [trait({ confidence: 0.2 })] }))).toBeNull();
	});
	it('counts substantive voices as the sample, never the raw voice count', () => {
		const view = readerImpressions(context({ voices: 900, substantiveVoices: 18 }))!;
		expect(view.sampled).toBe(18);
		expect(JSON.stringify(view)).not.toContain('900');
	});
	it('drops low-confidence and unknown-value traits and caps the list at four', () => {
		const view = readerImpressions(context({ traits: [
			trait({ trait: 'a', confidence: 0.9 }), trait({ trait: 'b', confidence: 0.85 }),
			trait({ trait: 'c', confidence: 0.8 }), trait({ trait: 'd', confidence: 0.75 }),
			trait({ trait: 'e', confidence: 0.7 }),
			trait({ trait: 'weak', confidence: 0.64 }),
			trait({ trait: 'vague', value: 'unknown', confidence: 0.99 }),
			trait({ trait: 'blank', value: '   ', confidence: 0.99 })
		] }))!;
		expect(view.traits).toHaveLength(4);
		expect(view.traits.map((t) => t.trait)).toEqual(['a', 'b', 'c', 'd']);
	});
	it('keeps a trait exactly at the confidence threshold', () => {
		expect(readerImpressions(context({ traits: [trait({ confidence: 0.65 })] }))!.traits).toHaveLength(1);
	});
});

describe('claims the sample cannot support', () => {
	it('never exposes model confidence, which is not a share of readers agreeing', () => {
		const view = readerImpressions(context({ traits: [trait({ confidence: 0.83, modelConfidence: 0.91 })] }))!;
		expect(JSON.stringify(view)).not.toContain('0.83');
		expect(JSON.stringify(view)).not.toContain('0.91');
		expect(Object.keys(view.traits[0])).not.toContain('confidence');
		expect(Object.keys(view.traits[0])).not.toContain('modelConfidence');
	});
	it('never surfaces the sample mean as if it were a rating', () => {
		const view = readerImpressions(context({ meanRating: 4.62 }))!;
		expect(JSON.stringify(view)).not.toContain('4.62');
	});
	it('carries consensus once for the whole sample, never per trait', () => {
		// The source produces ONE judgement of whether the sample agrees. Repeating it against
		// each trait would imply independent per-trait readings that were never measured.
		const view = readerImpressions(context({ consensus: 'mixed', traits: [trait({ trait: 'a' }), trait({ trait: 'b' })] }))!;
		expect(view.consensus).toBe('mixed');
		expect(view.traits).toHaveLength(2);
		for (const t of view.traits) expect(Object.keys(t)).not.toContain('mixed');
	});
	it('passes through the other consensus values and rejects anything unexpected', () => {
		expect(readerImpressions(context({ consensus: 'consistent' }))!.consensus).toBe('consistent');
		expect(readerImpressions(context({ consensus: 'insufficient' }))!.consensus).toBe('insufficient');
		expect(readerImpressions(context({ consensus: null }))!.consensus).toBeNull();
		expect(readerImpressions(context({ consensus: 'everyone agreed' as never }))!.consensus).toBeNull();
	});
	it('drops a narration claim unless the review actually mentions listening', () => {
		// The sample is book-level and mixes formats, so print readers cannot speak to narration.
		const silent = readerImpressions(context({ traits: [trait({ trait: 'narration', summary: 'The prose is brisk and clear.' })] }));
		expect(silent).toBeNull();
		const heard = readerImpressions(context({ traits: [trait({ trait: 'narration', summary: 'Listeners praise the narrator’s range.' })] }))!;
		expect(heard.traits[0].trait).toBe('narration');
	});
	it('keeps non-narration traits regardless of whether listening is mentioned', () => {
		expect(readerImpressions(context({ traits: [trait({ trait: 'worldbuilding', summary: 'Dense and rewarding.' })] }))!.traits).toHaveLength(1);
	});
});

describe('presentation details', () => {
	it('humanises trait names', () => {
		expect(readerImpressions(context({ traits: [trait({ trait: 'side_characters' })] }))!.traits[0].label).toBe('Side characters');
		expect(readerImpressions(context({ traits: [trait({ trait: 'powerCreep' })] }))!.traits[0].label).toBe('Power creep');
	});
	it('formats the sampling span', () => {
		expect(readerImpressions(context())!.span).toContain('2024');
		expect(readerImpressions(context({ span: null }))!.span).toBeNull();
	});
	it('accepts only http and https source links', () => {
		const view = readerImpressions(context({ sources: [
			{ name: 'Goodreads', url: 'https://example.com/a' },
			{ name: 'Bad', url: 'javascript:alert(1)' },
			{ name: 'Also bad', url: 'data:text/html,<script>' },
			{ name: '', url: 'https://example.com/b' }
		] }))!;
		expect(view.sources).toEqual([{ name: 'Goodreads', url: 'https://example.com/a' }]);
	});
	it('works with an empty source list and no span', () => {
		const minimal: ReaderContext = {
			entity: 'B01', voices: 10, substantiveVoices: 6, samples: 10, meanRating: null, span: null,
			sampling: 'bounded-public-review-sample', sources: [], consensus: null, traits: [trait()]
		};
		const view = readerImpressions(minimal)!;
		expect(view.sampled).toBe(6);
		expect(view.sources).toEqual([]);
		expect(view.span).toBeNull();
		expect(view.consensus).toBeNull();
	});
	it('tolerates malformed trait rows without throwing', () => {
		const messy = context({ traits: [null, { trait: 'x' }, trait(), { trait: 'y', value: 'z', confidence: 'high' }] as never });
		expect(readerImpressions(messy)!.traits.map((t) => t.trait)).toEqual(['progression']);
	});
});

describe('the observation leads', () => {
	const CRADLE = 'Readers describe a fast-paced, engaging climb despite some initial slow setup.';

	it('renders on an observation alone, with no confident trait', () => {
		// Path of Ascension and Bastion produced a useful observation and no firm trait.
		const view = readerImpressions(context({ observation: CRADLE, traits: [] }))!;
		expect(view.observation).toBe(CRADLE);
		expect(view.traits).toEqual([]);
		expect(view.sampled).toBe(18);
	});
	it('drops binary trait labels that would contradict the observation', () => {
		// Cradle: Jev returns pacing-slow at 0.9 while 47 readers describe a slow opening that
		// then accelerates. Both are true; "Pacing: slow" as a headline is not.
		const view = readerImpressions(context({
			observation: CRADLE,
			traits: [trait({ trait: 'pacing-slow', value: 'present', confidence: 0.9 })]
		}))!;
		expect(view.observation).toBe(CRADLE);
		expect(view.traits).toEqual([]);
	});
	it('still shows traits when there is no observation to lead with', () => {
		const view = readerImpressions(context({ observation: null, traits: [trait({ trait: 'humour' })] }))!;
		expect(view.observation).toBeNull();
		expect(view.traits.map((t) => t.label)).toEqual(['Humour']);
	});
	it('treats a blank or missing observation as absent', () => {
		expect(readerImpressions(context({ observation: '   ' }))!.observation).toBeNull();
		expect(readerImpressions(context({ observation: undefined }))!.observation).toBeNull();
	});
	it('returns nothing when there is neither an observation nor a usable trait', () => {
		expect(readerImpressions(context({ observation: null, traits: [] }))).toBeNull();
		expect(readerImpressions(context({ observation: '', traits: [trait({ confidence: 0.1 })] }))).toBeNull();
	});
	it('keeps the sample caveats alongside an observation-only view', () => {
		const view = readerImpressions(context({ observation: CRADLE, traits: [], consensus: 'mixed' }))!;
		expect(view.consensus).toBe('mixed');
		expect(view.sources).toHaveLength(1);
		expect(JSON.stringify(view)).not.toContain('4.62');
	});
});

describe('trait voice counts are not mention counts', () => {
	it('never exposes a per-trait voice count', () => {
		// `voices` is the size of the sampled corpus, not the number who raised this trait.
		// "9 mentioned it" would be a statistic the source never measured.
		const view = readerImpressions(context({ observation: null, substantiveVoices: 18, traits: [trait({ voices: 9 })] }))!;
		expect(Object.keys(view.traits[0])).not.toContain('voices');
		expect(JSON.stringify(view.traits)).not.toContain('9');
		// The only count shown is the sample size, once.
		expect(view.sampled).toBe(18);
	});
	it('still renders the trait itself', () => {
		const view = readerImpressions(context({ observation: null, traits: [trait({ trait: 'humour', value: 'present' })] }))!;
		expect(view.traits[0]).toMatchObject({ label: 'Humour', value: 'present' });
	});
});
