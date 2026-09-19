import { describe, it, expect } from 'vitest';
import { render } from 'svelte/server';
import ReaderImpressions from './ReaderImpressions.svelte';
import { readerImpressions, reduceDisclosure, isOpen, CLOSED, type DisclosureState, type DisclosureAction } from '$lib/impressions';
import type { ReaderContext } from '$lib/reader-context';

const base: ReaderContext = {
	entity: 'work-x-1',
	voices: 900,
	substantiveVoices: 24,
	samples: 30,
	meanRating: 4.17,
	span: ['2024-03-02', '2026-01-19'],
	sampling: 'bounded-public-review-sample',
	sources: [{ name: 'Hardcover', url: 'https://hardcover.app/books/x' }],
	consensus: 'mixed',
	traits: []
};
const ctx = (over: Partial<ReaderContext> = {}): ReaderContext => ({ ...base, ...over });
const view = (over: Partial<ReaderContext> = {}) => readerImpressions(ctx(over));
const html = (over: Partial<ReaderContext> = {}) => render(ReaderImpressions, { props: { context: ctx(over) } }).body;
const text = (over: Partial<ReaderContext> = {}) => html(over).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ');

const OBS = 'Readers describe a steady climb that rewards patience.';
const SPLIT = { impressions: ['Combat set pieces land well.'], critiques: ['The middle act drags.'] };

describe('approved split selection', () => {
	it('passes approved bullets through verbatim, both sides', () => {
		const v = view(SPLIT);
		expect(v?.impressions).toEqual(['Combat set pieces land well.']);
		expect(v?.critiques).toEqual(['The middle act drags.']);
	});

	it('replaces the observation paragraph rather than printing the finding twice', () => {
		// The split is a reviewed reading OF the observation; showing both would duplicate it.
		const v = view({ ...SPLIT, observation: OBS });
		expect(v?.observation).toBeNull();
		expect(text({ ...SPLIT, observation: OBS })).not.toContain(OBS);
	});

	it('falls back to the observation paragraph when no approved split exists', () => {
		const v = view({ observation: OBS });
		expect(v?.observation).toBe(OBS);
		expect(v?.impressions).toEqual([]);
		expect(text({ observation: OBS })).toContain(OBS);
	});

	it('renders one column alone rather than inventing the other side', () => {
		const only = text({ impressions: ['Strong narrator performance.'], critiques: [] });
		expect(only).toContain('Impressions');
		expect(only).not.toContain('Critiques');
	});

	it('treats a present-but-empty split as no split at all', () => {
		// An empty side means the sample had none, so there is nothing to show in columns.
		const v = view({ impressions: [], critiques: [], observation: OBS });
		expect(v?.observation).toBe(OBS);
	});

	it('keeps a contested point on both sides', () => {
		// The contract puts a disagreement in both columns; de-duplicating across them would
		// silently pick a winner the sample never picked.
		const line = 'The pacing divides readers.';
		const v = view({ impressions: [line], critiques: [line] });
		expect(v?.impressions).toEqual([line]);
		expect(v?.critiques).toEqual([line]);
	});

	it('drops blanks, non-strings and repeats within a side', () => {
		const v = view({ impressions: ['  Real  ', '', '   ', 'Real', 42 as unknown as string, 'Other'] });
		expect(v?.impressions).toEqual(['Real', 'Other']);
	});

	it('caps a runaway aggregate without truncating approved wording', () => {
		const many = Array.from({ length: 12 }, (_, i) => `Point number ${i} that keeps its full wording`);
		const v = view({ impressions: many });
		expect(v?.impressions).toHaveLength(6);
		expect(v?.impressions[0]).toBe(many[0]);
	});

	it('never derives a split from observation prose', () => {
		// No sentence-splitting, no sentiment keywords: a paragraph full of commas, "but" and
		// "however" still yields no columns, because nothing approved one.
		const prose = 'The worldbuilding is rich, but the pacing sags; however, the finale lands.';
		const v = view({ observation: prose });
		expect(v?.impressions).toEqual([]);
		expect(v?.critiques).toEqual([]);
		expect(text({ observation: prose })).not.toContain('Critiques');
	});
});

describe('trait precedence', () => {
	const traits = [{ trait: 'pacing-slow', value: 'present', confidence: 0.9, modelConfidence: 1, summary: 'DISTINCT_SUMMARY', voices: 40 }];

	it('suppresses flattened labels when an approved split says it better', () => {
		const out = text({ ...SPLIT, traits });
		expect(out).not.toContain('Pacing slow');
		expect(out).not.toContain('DISTINCT_SUMMARY');
	});

	it('still shows traits when there is neither prose nor split', () => {
		expect(text({ traits })).toContain('Pacing slow');
	});
});

describe('methodology control', () => {
	it('keeps the sample size visible without interaction', () => {
		const head = html(SPLIT).split('info-panel')[0];
		expect(head).toContain('From 24 reader reviews');
	});

	it('ships the methodology in the markup so it survives with scripting off', () => {
		// Collapsed with CSS, not removed: server-rendered output must carry the record.
		const out = text(SPLIT);
		expect(out).toContain('in print or ebook rather than listening');
		expect(out).toContain('not a rating, and not every reader');
		expect(html(SPLIT)).toContain('https://hardcover.app/books/x');
	});

	it('starts collapsed and wires the trigger to its panel', () => {
		const out = html(SPLIT);
		expect(out).toMatch(/aria-expanded="false"/);
		const controls = out.match(/aria-controls="([^"]+)"/)?.[1];
		expect(controls).toBeTruthy();
		expect(out).toContain(`id="${controls}"`);
	});

	it('gives the trigger a name that is not the bare glyph', () => {
		expect(text(SPLIT)).toContain('Where this comes from');
	});
});

describe('what must never reach the page', () => {
	it('never prints raw voice totals, sample means or model confidence', () => {
		const out = html({ ...SPLIT, traits: [{ trait: 'humour', value: 'present', confidence: 0.88, modelConfidence: 0.91, summary: 'x', voices: 40 }] });
		expect(out).not.toContain('900');
		expect(out).not.toContain('4.17');
		expect(out).not.toContain('0.88');
		expect(out).not.toContain('confidence');
		expect(out).not.toMatch(/\b(88|91)\s*%/);
	});

	it('renders nothing when the context is absent or has no sampled voices', () => {
		expect(render(ReaderImpressions, { props: { context: undefined } }).body.trim()).not.toContain('Reader impressions');
		expect(view({ substantiveVoices: 0, ...SPLIT })).toBeNull();
	});
});

describe('methodology disclosure state', () => {
	// A tap fires pointerdown, then focus, then click. A mouse hover fires pointerenter only.
	const run = (...actions: DisclosureAction[]): DisclosureState => actions.reduce(reduceDisclosure, CLOSED);
	const openAfter = (...actions: DisclosureAction[]) => isOpen(run(...actions));

	it('starts closed', () => {
		expect(isOpen(CLOSED)).toBe(false);
	});

	it('opens on the first tap rather than flickering shut', () => {
		// The press lands before the focus it causes; handling this on click would read that
		// focus as "already open" and immediately close it again.
		expect(openAfter('press', 'focus-in', 'click')).toBe(true);
	});

	it('closes on the second tap', () => {
		const first = run('press', 'focus-in', 'click');
		expect(isOpen(reduceDisclosure(reduceDisclosure(first, 'press'), 'click'))).toBe(false);
	});

	it('opens on keyboard focus alone', () => {
		expect(openAfter('focus-in')).toBe(true);
	});

	it('opens on hover, and reports itself open while hovered', () => {
		// The trigger renders aria-expanded from this same value, so a visible panel can never
		// report itself collapsed.
		expect(openAfter('hover-in')).toBe(true);
	});

	it('dismisses on Escape even while the cursor is still on it', () => {
		expect(openAfter('hover-in', 'escape')).toBe(false);
	});

	it('does not reopen when Escape returns focus to the trigger', () => {
		expect(openAfter('focus-in', 'escape', 'focus-in')).toBe(false);
	});

	it('stays open when the mouse leaves but focus remains', () => {
		expect(openAfter('focus-in', 'hover-in', 'hover-out')).toBe(true);
	});

	it('stays open when focus leaves but the mouse remains', () => {
		expect(openAfter('hover-in', 'focus-in', 'focus-out')).toBe(true);
	});

	it('forgets a dismissal once the pointer and focus have both gone', () => {
		// Otherwise one Escape would keep the control shut for the rest of the page's life.
		const stale = run('hover-in', 'escape', 'hover-out');
		expect(stale.dismissed).toBe(false);
		expect(openAfter('hover-in', 'escape', 'hover-out', 'hover-in')).toBe(true);
	});

	it('ignores Escape when there is nothing open to dismiss', () => {
		// The parent dialog needs that keypress; swallowing it here would trap the reader.
		expect(reduceDisclosure(CLOSED, 'escape')).toEqual(CLOSED);
	});

	it('closes a hovered panel when the trigger is clicked', () => {
		// The reader can see it open, so a click on the trigger reads as "close this", not as
		// "pin the thing already in front of me".
		expect(openAfter('hover-in', 'press', 'click')).toBe(false);
	});

	it('keeps a tapped-open panel up when the cursor wanders off', () => {
		// A tap leaves focus on the trigger, which is what holds the panel open here.
		expect(openAfter('press', 'focus-in', 'click', 'hover-in', 'hover-out')).toBe(true);
	});
});
