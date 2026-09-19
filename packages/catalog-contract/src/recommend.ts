import {
	bookPopularity, FEATURE_TAXONOMY_VERSION, genreLabels, normalizeIdentity, seriesStarters, tasteLabels,
	type CatalogBook, type Recommendation, type Taste, type TasteWeights
} from './catalog.js';

const featureDefinitions: Readonly<Record<string, { label: string; dimension?: Taste }>> = {
	'system-apocalypse': { label: 'System apocalypse' },
	isekai: { label: 'Isekai' },
	dungeon: { label: 'Dungeons' },
	cultivation: { label: 'Cultivation' },
	crafting: { label: 'Crafting', dimension: 'crafting' },
	'base-building': { label: 'Base building', dimension: 'crafting' },
	'time-loop': { label: 'Time loop' },
	academy: { label: 'Academy' },
	'monster-mc': { label: 'Monster protagonist' },
	stats: { label: 'Game stats', dimension: 'stats' },
	'solo-protagonist': { label: 'Solo adventures', dimension: 'teamwork' },
	'team-adventure': { label: 'Team adventures', dimension: 'teamwork' },
	comedy: { label: 'Comedy', dimension: 'humor' },
	politics: { label: 'Political intrigue', dimension: 'politics' },
	survival: { label: 'Survival' },
	exploration: { label: 'Exploration', dimension: 'worldbuilding' },
	cozy: { label: 'Cozy everyday life', dimension: 'cozy' }
};

/** The exporter binds reviewed features to the current source. Legacy tags without
 * that provenance, or tags from another taxonomy, are not ranking evidence. */
function reviewedFeatures(book: CatalogBook): Set<string> | null {
	const evidence = book.featureEvidence;
	if (!evidence || evidence.taxonomyVersion !== FEATURE_TAXONOMY_VERSION ||
		!Number.isFinite(Date.parse(evidence.reviewedAt))) return null;
	try {
		const source = new URL(evidence.sourceUrl);
		if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password) return null;
	} catch { return null; }
	return new Set(Array.isArray(book.features) ? book.features : []);
}

/** Positive overlap only: an unmentioned mechanic is unknown. Count each taste
 * family once and never add it again when Jev already compared that dimension.
 * Fixed taxonomy order makes both the cap and explanations independent of tag order. */
function sharedMechanics(seed: ReadonlySet<string> | null, candidate: ReadonlySet<string> | null, weights: TasteWeights, compared: ReadonlySet<Taste>): string[] {
	if (!seed?.size || !candidate?.size) return [];
	const families = new Set<string>(), labels: string[] = [];
	for (const [tag, { label, dimension }] of Object.entries(featureDefinitions)) {
		if (!seed.has(tag) || !candidate.has(tag)) continue;
		if (dimension && ((weights[dimension] ?? 1) <= 0 || compared.has(dimension))) continue;
		const family = dimension ?? tag;
		if (families.has(family)) continue;
		families.add(family);
		labels.push(genreLabels[tag] ?? label);
		if (labels.length === 2) break;
	}
	return labels;
}

/** Rank candidates after discovery eligibility and content preferences have been applied.
 * Catalog re-exports this function; keep reads of its helpers and labels inside the call
 * so neither module depends on the other's constants during module initialization.
 */
export function recommend(seed: CatalogBook, books: CatalogBook[], weights: TasteWeights = {}, limit = 12): Recommendation[] {
	const candidates = seriesStarters(books).filter(b => b.id !== seed.id && b.seriesKey !== seed.seriesKey);
	const seedFeatures = reviewedFeatures(seed);
	const ranked = candidates.flatMap((book): Recommendation[] => {
		const shared = book.subgenres.filter(g => seed.subgenres.includes(g));
		const bookFeatures = reviewedFeatures(book);
		let distance = 0, totalWeight = 0, dimensions = 0;
		const reasons: { label: string; strength: number }[] = [];
		const compared = new Set<Taste>();
		for (const key of Object.keys(tasteLabels) as Taste[]) {
			// Stats are a concrete mechanics claim. If a current source review did not
			// establish them, treat this dimension as unknown in both rank and reasons.
			// Omission is never a zero, a negative verdict, or a mismatch penalty.
			if (key === 'stats' && ((seedFeatures && !seedFeatures.has('stats')) || (bookFeatures && !bookFeatures.has('stats')))) continue;
			const a = seed.assessment?.taste[key], b = book.assessment?.taste[key];
			if (!a || !b || a.confidence < 0.45 || b.confidence < 0.45) continue;
			// Shared absences should not dominate a match, but a known difference still matters.
			const weight = (weights[key] ?? 1) * Math.min(a.confidence, b.confidence) * (0.2 + 0.8 * Math.max(a.value, b.value));
			if (weight <= 0) continue;
			distance += Math.abs(a.value - b.value) * weight;
			totalWeight += weight;
			dimensions++;
			compared.add(key);
			if (a.value >= 0.5 && b.value >= 0.5) reasons.push({ label: tasteLabels[key], strength: Math.min(a.value, b.value) * weight });
		}
		const semantic = dimensions >= 3 && totalWeight > 0 && reasons.length > 0;
		if (!semantic && shared.length === 0) return [];
		const genreScore = shared.length / Math.max(new Set([...book.subgenres, ...seed.subgenres]).size, 1);
		// Sparse evidence cannot establish a taste match, but trusted conflicts must not be
		// ignored. Retain one unit of genre evidence so one uncertain trait cannot decide
		// the entire fallback score. Unknown and ignored traits contribute no penalty.
		const genreFit = genreScore * 0.65 * (1 - distance / (1 + totalWeight));
		const fit = semantic ? (1 - distance / totalWeight) * 0.85 + genreScore * 0.15 : genreFit;
		// Features cannot admit a candidate rejected by the existing taste/genre gate.
		// Two distinct mechanic families can add at most 0.04 to the score.
		const mechanics = sharedMechanics(seedFeatures, bookFeatures, weights, compared);
		const mechanicsBonus = Math.min(0.04, mechanics.length * 0.02);
		const score = Math.min(1, fit * 0.96 + Math.min(bookPopularity(book) / 100, 1) * 0.04 + mechanicsBonus);
		const baseReasons = semantic && reasons.length
			? reasons.sort((a,b) => b.strength - a.strength).slice(0,3).map(r => r.label)
			: shared.slice(0,3).map(g => genreLabels[g] ?? g);
		// Keep the main fit reasons prominent. Provenance remains on the source books;
		// a feature label makes no claim about reader consensus or model certainty.
		const explanation = [...new Set([...baseReasons.slice(0,2), ...mechanics, ...baseReasons.slice(2)])].slice(0,3);
		return [{ book, score, method: semantic ? 'taste' : 'genres', reasons: explanation }];
	}).sort((a,b) => b.score - a.score || a.book.id.localeCompare(b.book.id));
	const authors = new Map<string, number>();
	return ranked.filter(({ book }) => {
		const key = normalizeIdentity(book.author), count = authors.get(key) ?? 0;
		if (count >= 2) return false;
		authors.set(key, count + 1);
		return true;
	}).slice(0, limit);
}
