import { describe, expect, it } from 'vitest';
import { defaultFilters, FEATURE_TAXONOMY_VERSION, type Assessment, type CatalogBook, type ContentSignal, type Taste, type TasteProfile } from './catalog.js';
import { recommend } from './recommend.js';
import { recommendSeries } from './recommendations.js';
import type { CatalogSeries } from './series.js';

const unknown = (): ContentSignal => ({ verdict: 'unknown', confidence: 0, source: 'unknown', note: '' });
const trait = (value: number, confidence = 0.9) => ({ value, confidence });
const assessment = (taste: TasteProfile): Assessment => ({
	model: 'fixture', evaluatedAt: '2026-09-19T00:00:00Z', inputHash: 'fixture', taste,
	genre: { value: 'unknown', confidence: 0 }, explicit: unknown(), harem: unknown(), quality: unknown()
});
const book = (id: string, taste: TasteProfile | null = null, fields: Partial<CatalogBook> = {}): CatalogBook => ({
	id, title: id, subtitle: '', author: `Author ${id}`, narrator: null,
	series: id, seriesKey: id, seriesNumber: 1, releaseDate: null, coverUrl: null, runtimeMinutes: null,
	subgenres: ['cultivation'], description: '', url: null, rating: 4.5, ratingCount: 100,
	edition: 'audiobook', scope: 'indexed', sources: [], issues: [], assessment: taste && assessment(taste),
	content: { sexualized: unknown(), explicit: unknown(), harem: unknown(), aiNarration: unknown(), aiWriting: unknown(), quality: unknown() },
	...fields
});

const reviewed = (book: CatalogBook, features: string[]): CatalogBook => ({
	...book, features,
	featureEvidence: { sourceUrl: 'https://publisher.example/books/source', reviewedAt: '2026-09-19T00:00:00Z', taxonomyVersion: FEATURE_TAXONOMY_VERSION }
});
const withoutReview = (book: CatalogBook): CatalogBook => ({ ...book, featureEvidence: undefined });
const score = (seed: CatalogBook, candidate: CatalogBook, weights = {}) => recommend(seed, [candidate], weights)[0].score;

describe('reviewed source mechanics', () => {
	it('adds a small bonus for shared mechanics while missing and different tags remain neutral', () => {
		const seed = reviewed(book('seed'), ['dungeon', 'time-loop']);
		const none = reviewed(book('none'), []);
		const different = reviewed(book('different'), ['academy']);
		const one = reviewed(book('one'), ['dungeon']);
		const two = reviewed(book('two'), ['dungeon', 'time-loop']);
		const base = score(seed, none);
		expect(score(seed, different)).toBe(base);
		expect(score(seed, one) - base).toBeCloseTo(0.02);
		expect(score(seed, two) - base).toBeCloseTo(0.04);
		expect(recommend(seed, [none, different, one, two]).map(r => r.book.id)).toEqual(['two', 'one', 'different', 'none']);
		expect(recommend(seed, [two])[0]).toMatchObject({ method: 'genres', reasons: ['Cultivation', 'Dungeons', 'Time loop'] });
	});

	it.each(['seed', 'candidate', 'both'])('requires current reviewed provenance on %s', missing => {
		let seed = reviewed(book('seed'), ['dungeon']), candidate = reviewed(book('candidate'), ['dungeon']);
		const baseline = recommend(withoutReview(seed), [withoutReview(candidate)]);
		if (missing !== 'candidate') seed = withoutReview(seed);
		if (missing !== 'seed') candidate = withoutReview(candidate);
		const result = recommend(seed, [candidate])[0];
		expect(result.score).toBe(baseline[0].score);
		expect(result.reasons).toEqual(baseline[0].reasons);
	});

	it.each([
		{ taxonomyVersion: 'catalog-features-v0' },
		{ taxonomyVersion: 'catalog-features-v2' },
		{ sourceUrl: '' },
		{ sourceUrl: 'not a URL' },
		{ sourceUrl: 'javascript:alert(1)' },
		{ reviewedAt: 'not a date' }
	])('ignores unusable feature provenance %j', invalid => {
		const seed = reviewed(book('seed'), ['dungeon']);
		const candidate = reviewed(book('candidate'), ['dungeon']);
		candidate.featureEvidence = { ...candidate.featureEvidence!, ...invalid };
		expect(score(seed, candidate)).toBe(score(withoutReview(seed), candidate));
	});

	it('caps the bonus, ignores duplicate and unsupported tags, and is independent of tag ordering', () => {
		const features = ['academy', 'time-loop', 'dungeon', 'dungeon', 'invented-mechanic'];
		const seed = reviewed(book('seed'), features), candidate = reviewed(book('candidate'), features);
		expect(score(seed, candidate) - score(withoutReview(seed), candidate)).toBeCloseTo(0.04);
		const result = recommend(seed, [candidate])[0];
		const reordered = recommend({ ...seed, features: [...features].reverse() }, [{ ...candidate, features: [...features].reverse() }])[0];
		expect(reordered.score).toBe(result.score);
		expect(reordered.reasons).toEqual(result.reasons);
		expect(result.reasons).not.toContain('invented-mechanic');
		expect(score(reviewed(book('seed'), ['invented-mechanic']), reviewed(book('candidate'), ['invented-mechanic']))).toBe(score(book('seed'), book('candidate')));
	});

	const mapped: [string, Taste][] = [
		['stats', 'stats'], ['crafting', 'crafting'], ['base-building', 'crafting'], ['comedy', 'humor'],
		['cozy', 'cozy'], ['politics', 'politics'], ['team-adventure', 'teamwork'],
		['solo-protagonist', 'teamwork'], ['exploration', 'worldbuilding']
	];
	it.each(mapped)('honors Ignore for %s through %s even without Jev profiles', (feature, dimension) => {
		const seed = reviewed(book('seed'), [feature]), candidate = reviewed(book('candidate'), [feature]);
		expect(score(seed, candidate) - score(withoutReview(seed), candidate)).toBeCloseTo(0.02);
		expect(score(seed, candidate, { [dimension]: 0 })).toBe(score(withoutReview(seed), candidate, { [dimension]: 0 }));
	});

	it.each(mapped)('does not count %s again when Jev already compares %s', (feature, dimension) => {
		const seed = reviewed(book('seed', { [dimension]: trait(0.8) }), [feature]);
		const candidate = reviewed(book('candidate', { [dimension]: trait(0.6) }), [feature]);
		expect(score(seed, candidate)).toBe(score(withoutReview(seed), candidate));
		expect(recommend(seed, [candidate])[0].reasons).toEqual(recommend(withoutReview(seed), [candidate])[0].reasons);
	});

	it('counts crafting and base building as one family when no comparable taste exists', () => {
		const seed = reviewed(book('seed'), ['crafting', 'base-building']);
		const candidate = reviewed(book('candidate'), ['crafting', 'base-building']);
		expect(score(seed, candidate) - score(withoutReview(seed), candidate)).toBeCloseTo(0.02);
	});

	it('can supplement an untrusted or missing Jev dimension but respects the existing confidence boundary', () => {
		const seed = reviewed(book('seed', { stats: trait(0.8) }), ['stats']);
		const uncertain = reviewed(book('uncertain', { stats: trait(0.6, 0.44) }), ['stats']);
		const usable = reviewed(book('usable', { stats: trait(0.6, 0.45) }), ['stats']);
		const missing = reviewed(book('missing'), ['stats']);
		expect(score(seed, uncertain) - score(withoutReview(seed), uncertain)).toBeCloseTo(0.02);
		expect(score(seed, missing) - score(withoutReview(seed), missing)).toBeCloseTo(0.02);
		expect(score(seed, usable)).toBe(score(withoutReview(seed), usable));
	});

	it('does not reintroduce a feature after comparable low values contributed to genre fallback', () => {
		const seed = reviewed(book('seed', { cozy: trait(0) }), ['cozy']);
		const candidate = reviewed(book('candidate', { cozy: trait(0) }), ['cozy']);
		expect(recommend(seed, [candidate])[0]).toMatchObject({ score: score(withoutReview(seed), candidate), method: 'genres', reasons: ['Cultivation'] });
	});

	it('cannot use shared mechanics to create a match rejected by the existing evidence gate', () => {
		const seed = reviewed(book('seed', { action: trait(0.8) }), ['dungeon', 'time-loop']);
		const candidate = reviewed(book('candidate', { action: trait(0.8) }, { subgenres: ['litrpg'] }), ['dungeon', 'time-loop']);
		expect(recommend(seed, [candidate])).toEqual([]);
	});

	it('keeps strong taste evidence ahead of a contrary profile with the full mechanics bonus', () => {
		const tastes = { cozy: trait(0.95), humor: trait(0.9), action: trait(0.1) };
		const seed = reviewed(book('seed', tastes), ['dungeon', 'time-loop']);
		const match = book('match', tastes);
		const contrary = reviewed(book('contrary', { cozy: trait(0), humor: trait(0), action: trait(1) }), ['dungeon', 'time-loop']);
		expect(recommend(seed, [contrary, match], { cozy: 3 })[0].book).toBe(match);
	});

	it('keeps the taste method, concise explanations, original source evidence and bounded score', () => {
		const tastes = { action: trait(0.9), humor: trait(0.8), worldbuilding: trait(0.7) };
		const seed = reviewed(book('seed', tastes, { ratingCount: 1_000_000 }), ['dungeon', 'time-loop']);
		const candidate = reviewed(book('candidate', tastes, { ratingCount: 1_000_000 }), ['dungeon', 'time-loop']);
		const result = recommend(seed, [candidate])[0];
		expect(result.method).toBe('taste');
		expect(result.score).toBeLessThanOrEqual(1);
		expect(result.reasons).toHaveLength(3);
		expect(result.reasons).toContain('Dungeons');
		expect(result.book).toBe(candidate);
		expect(result.book.featureEvidence).toBe(candidate.featureEvidence);
	});

	it('retains deterministic ID ordering when reviewed mechanics tie', () => {
		const seed = reviewed(book('seed'), ['dungeon']);
		const a = reviewed(book('a'), ['dungeon']), b = reviewed(book('b'), ['dungeon']);
		expect(recommend(seed, [b, a]).map(r => r.book.id)).toEqual(['a', 'b']);
		expect(recommend(seed, [a, b]).map(r => r.book.id)).toEqual(['a', 'b']);
	});

	it.each([
		['Dungeon Crawler Carl', 0.598, 0.49],
		['The Hedge Wizard', 0.650, 0.66],
		['The Perfect Run', 0.595, 0.48]
	] as const)('does not advertise unsupported reviewed stats for %s', (id, value, confidence) => {
		const otherTaste = { action: trait(0.8), humor: trait(0.7), worldbuilding: trait(0.75) };
		const seed = reviewed(book('seed', { ...otherTaste, stats: trait(0.9) }), ['stats']);
		const candidate = reviewed(book(id, { ...otherTaste, stats: trait(value, confidence) }), ['dungeon']);
		const result = recommend(seed, [candidate])[0];
		const unknownStats = { ...candidate, assessment: assessment(otherTaste) };
		expect(result.method).toBe('taste');
		expect(result.reasons).not.toContain('Crunchy stats');
		expect(result.reasons).not.toContain('Game stats');
		expect(result.score).toBe(score(seed, unknownStats));
	});

	it('treats an empty reviewed stats whitelist as unknown on either side, never as a zero', () => {
		const otherTaste = { action: trait(0.8), humor: trait(0.7), worldbuilding: trait(0.75) };
		const seed = reviewed(book('seed', { ...otherTaste, stats: trait(1) }), []);
		const candidate = reviewed(book('candidate', { ...otherTaste, stats: trait(0) }), ['stats']);
		const unknownSeed = { ...seed, assessment: assessment(otherTaste) };
		expect(score(seed, candidate)).toBe(score(unknownSeed, candidate));
		expect(score(candidate, seed)).toBe(score(candidate, unknownSeed));
		expect(score({ ...seed, features: undefined }, candidate)).toBe(score(unknownSeed, candidate));
	});

	it('keeps graded stats when both reviewed books positively establish the mechanic', () => {
		const tastes = { action: trait(0.7), stats: trait(0.95), worldbuilding: trait(0.6) };
		const seed = reviewed(book('seed', tastes), ['stats']), candidate = reviewed(book('candidate', tastes), ['stats']);
		expect(recommend(seed, [candidate])[0].reasons).toContain('Crunchy stats');
		expect(score(seed, candidate)).toBe(score(withoutReview(seed), withoutReview(candidate)));
	});

	it('leaves graded tone and worldbuilding inference available when reviewed feature tags are empty', () => {
		const tastes = { cozy: trait(0.85), humor: trait(0.8), worldbuilding: trait(0.75) };
		const seed = reviewed(book('seed', tastes), []), candidate = reviewed(book('candidate', tastes), []);
		expect(recommend(seed, [candidate])[0]).toMatchObject({ method: 'taste', reasons: ['Cozy vibes', 'Humor', 'Worldbuilding'] });
	});

	it('leaves reader aggregates out of ranking', () => {
		const seed = reviewed(book('seed'), ['dungeon']);
		const candidate = reviewed(book('candidate'), ['dungeon']);
		const withReaders: CatalogBook = { ...candidate, readerContext: {
			entity: candidate.id, voices: 20, substantiveVoices: 20, samples: 20, meanRating: 5, span: null,
			sampling: 'bounded-public-review-sample', sources: [], consensus: 'consistent',
			traits: [{ trait: 'tone-humorous', value: 'present', confidence: 0.9, modelConfidence: 0.95, summary: 'A bounded sample mentions humor.', voices: 20 }]
		} };
		expect(score(seed, withReaders)).toBe(score(seed, candidate));
	});

	it('preserves canonical discovery and content gates even with the maximum reviewed bonus', () => {
		const features = ['dungeon', 'time-loop'];
		const seed = reviewed(book('seed'), features), safe = reviewed(book('safe'), features);
		const blocked = reviewed(book('blocked'), features);
		blocked.content.sexualized = { verdict: 'present', confidence: 1, source: 'manual', note: 'Reviewed exclusion.' };
		const later = reviewed(book('later', null, { seriesNumber: 2 }), features);
		const collection = reviewed(book('collection', null, { edition: 'collection' }), features);
		const drama = reviewed(book('drama', null, { edition: 'dramatized' }), features);
		const podcast = reviewed(book('podcast', null, { edition: 'podcast' }), features);
		const candidates = [seed, safe, blocked, later, collection, drama, podcast];
		const series: CatalogSeries[] = candidates.map(candidate => ({
			id: candidate.seriesKey, title: candidate.series, author: candidate.author, aliases: [], description: '', genres: candidate.subgenres,
			coverBookId: candidate.id, curated: false, status: 'unknown', sourceUrls: [], updatedAt: null,
			works: [{ id: `work-${candidate.id}`, title: candidate.title, number: candidate.seriesNumber, bookId: candidate.id, editionIds: [candidate.id], audioReleaseDate: null, verified: true }]
		}));
		const index = new Map(candidates.map(candidate => [candidate.id, candidate]));
		expect(recommendSeries(seed, series, index).map(r => r.book.id)).toEqual(['safe']);
		// An explicitly relaxed preference remains the caller's decision, not the scorer's.
		expect(recommendSeries(seed, series, index, { filters: { ...defaultFilters, hideSexualized: false } }).map(r => r.book.id)).toEqual(['blocked', 'safe']);
	});
});
describe('evidence in genre fallback recommendations', () => {
	it('reduces a sparse known cozy mismatch further when cozy is a higher priority', () => {
		const seed = book('seed', { cozy: trait(0.95), worldbuilding: trait(0.75) });
		const lowCozy = book('low-cozy', { cozy: trait(0.05), worldbuilding: trait(0.75) });
		const cozyUnknown = book('unknown', { worldbuilding: trait(0.75) });
		const cozyMatch = book('match', { cozy: trait(0.95), worldbuilding: trait(0.75) });
		const normal = recommend(seed, [lowCozy, cozyUnknown, cozyMatch]);
		const boosted = recommend(seed, [lowCozy, cozyUnknown, cozyMatch], { cozy: 3 });
		const score = (results: typeof normal, id: string) => results.find(r => r.book.id === id)!.score;
		expect(score(normal, lowCozy.id)).toBeLessThan(score(normal, cozyUnknown.id));
		expect(score(boosted, lowCozy.id)).toBeLessThan(score(normal, lowCozy.id));
		expect(score(boosted, cozyUnknown.id)).toBe(score(normal, cozyUnknown.id));
		expect(score(boosted, cozyMatch.id)).toBe(score(normal, cozyMatch.id));
		expect(boosted.find(r => r.book.id === lowCozy.id)).toMatchObject({ method: 'genres', reasons: ['Cultivation'] });
	});

	it('uses trusted differences even when three comparable dimensions have no shared positive reason', () => {
		const seed = book('seed', { cozy: trait(0.95), humor: trait(0.8), action: trait(0.3) });
		const contrary = book('contrary', { cozy: trait(0.05), humor: trait(0.1), action: trait(0.9) });
		const unassessed = book('unassessed');
		const ranked = recommend(seed, [contrary, unassessed]);
		expect(ranked.map(r => r.book.id)).toEqual(['unassessed', 'contrary']);
		expect(ranked[1].score).toBeLessThan(ranked[0].score);
		expect(ranked[1]).toMatchObject({ method: 'genres', reasons: ['Cultivation'] });
	});

	it.each([undefined, trait(0, 0), trait(0, 0.44)])('keeps missing or untrusted cozy evidence neutral (%j)', cozy => {
		const seed = book('seed', { cozy: trait(1) });
		const candidate = book('candidate', cozy ? { cozy } : {});
		const unassessed = book('unassessed');
		const ranked = recommend(seed, [candidate, unassessed], { cozy: 3 });
		expect(ranked.find(r => r.book.id === candidate.id)!.score).toBe(ranked.find(r => r.book.id === unassessed.id)!.score);
	});

	it('does not treat an untrusted seed value as a known preference', () => {
		const seed = book('seed', { cozy: trait(1, 0.2) });
		const knownLow = book('known-low', { cozy: trait(0) });
		const unassessed = book('unassessed');
		const ranked = recommend(seed, [knownLow, unassessed], { cozy: 3 });
		expect(ranked[0].score).toBe(ranked[1].score);
	});

	it('distinguishes a trusted zero from missing evidence without turning it into a hard filter', () => {
		const seed = book('seed', { cozy: trait(1, 1) });
		const absent = book('absent', { cozy: trait(0, 1) });
		const unknown = book('unknown');
		const ranked = recommend(seed, [absent, unknown], { cozy: 3 });
		expect(ranked).toHaveLength(2);
		expect(ranked[1].book.id).toBe('absent');
		expect(ranked[1].score).toBeGreaterThan(0);
		expect(ranked[1].score).toBeLessThan(ranked[0].score);
	});

	it('honors Ignore for the only conflicting dimension', () => {
		const seed = book('seed', { cozy: trait(1), worldbuilding: trait(0.8) });
		const candidate = book('candidate', { cozy: trait(0), worldbuilding: trait(0.8) });
		const unassessed = book('unassessed');
		const ranked = recommend(seed, [candidate, unassessed], { cozy: 0 });
		expect(ranked[0].score).toBe(ranked[1].score);
		expect(ranked.every(r => Number.isFinite(r.score) && r.method === 'genres')).toBe(true);
	});

	it('gives a confident contradiction more influence than a tentative one', () => {
		const seed = book('seed', { cozy: trait(1, 1) });
		const tentative = book('tentative', { cozy: trait(0, 0.45) });
		const confident = book('confident', { cozy: trait(0, 1) });
		const ranked = recommend(seed, [confident, tentative]);
		expect(ranked.map(r => r.book.id)).toEqual(['tentative', 'confident']);
	});

	it('keeps shared absences out of taste-match explanations', () => {
		const lowTraits = { cozy: trait(0), humor: trait(0), action: trait(0) };
		const seed = book('seed', lowTraits), candidate = book('candidate', lowTraits);
		expect(recommend(seed, [candidate])[0]).toMatchObject({ method: 'genres', reasons: ['Cultivation'] });
	});

	it('still requires genre overlap when only one or two taste traits are known', () => {
		const tastes = { cozy: trait(0.9), humor: trait(0.8) };
		const seed = book('seed', tastes);
		const noGenreOverlap = book('other', tastes, { subgenres: ['litrpg'] });
		expect(recommend(seed, [noGenreOverlap], { cozy: 3 })).toEqual([]);
	});

	it('preserves rich-profile taste matching across genres and ahead of raw popularity', () => {
		const tastes = { cozy: trait(0.9, 1), humor: trait(0.8, 1), worldbuilding: trait(0.7, 1) };
		const seed = book('seed', tastes);
		const match = book('match', tastes, { subgenres: ['litrpg'], ratingCount: 0 });
		const popular = book('popular', { cozy: trait(0.1, 1), humor: trait(0.2, 1), worldbuilding: trait(0.7, 1) }, { ratingCount: 1_000_000 });
		const ranked = recommend(seed, [popular, match], { cozy: 3 });
		expect(ranked[0]).toMatchObject({ book: { id: 'match' }, method: 'taste', reasons: ['Cozy vibes', 'Humor', 'Worldbuilding'] });
		expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
	});

	it('leaves recommendations without comparable traits independent of taste weights', () => {
		const seed = book('seed', { cozy: trait(0.9) });
		const candidate = book('candidate', { action: trait(0.8) });
		expect(recommend(seed, [candidate], { cozy: 3, action: 0 })).toEqual(recommend(seed, [candidate]));
	});
});
