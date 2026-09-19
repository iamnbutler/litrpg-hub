/** Explicit listing labels only. Missing format or numbering is not proof of a
 * standalone or a first volume; callers keep responsibility for that policy. */
export interface EditionEvidence {
	title: string;
	subtitle?: string | null;
	/** Retained retailer fields, when available. A title ending in "Radio" is not
	 * enough to identify a podcast, but the retailer's Podcast type is. */
	contentType?: string | null;
	contentDeliveryType?: string | null;
}
export type ExplicitEditionKind = 'collection' | 'dramatized' | 'podcast';

const fields = (evidence: EditionEvidence): string[] => [evidence.title, evidence.subtitle ?? ''];
const numberToken = '(?:\\d+(?:\\.\\d+)?|[IVXLCDM]+)';
const volumeLabel = new RegExp(`\\b(?:books?|volumes?|vol\\.?|parts?|novellas?)(?:\\s*[#:]\\s*|\\s+)(${numberToken})(?![\\p{L}\\p{N}])`, 'giu');
// Multiple parts can make up one full book (The Wandering Inn 1 says "Parts 1
// and 2"), so only a range of books/volumes/novellas establishes a collection.
const volumeRange = new RegExp(`\\b(?:books?|volumes?|vol\\.?|novellas?)\\s+${numberToken}\\s*(?:[-–—]|through|thru|to|&|and)\\s*${numberToken}(?![\\p{L}\\p{N}])`, 'iu');
const canonicalRoman = /^(?=[MDCLXVI]+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i;

function parseNumber(token: string): number | null {
	if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token);
	if (!canonicalRoman.test(token)) return null;
	const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
	const digits = [...token.toUpperCase()].map(char => values[char]);
	return digits.reduce((total, digit, index) => total + (digit < (digits[index + 1] ?? 0) ? -digit : digit), 0);
}

/** Return observed labels without using them to invent or repair canonical order.
 * A bare number in a title ("12 Miles Below") deliberately does not qualify. */
export function explicitVolumeNumbers(evidence: EditionEvidence): number[] {
	return [...new Set(fields(evidence).flatMap(text => [...text.matchAll(volumeLabel)].flatMap(match => {
		const number = parseNumber(match[1]);
		return number !== null && Number.isFinite(number) ? [number] : [];
	})))];
}

export function hasExplicitLaterVolume(evidence: EditionEvidence): boolean {
	return explicitVolumeNumbers(evidence).some(number => number > 1);
}

/** Null means no explicit format label, not independently verified full audio.
 * A series name containing "Trilogy" and ordinary words such as "complete",
	 * "collection", or "radio" are insufficient on their own. */
export function explicitEditionKind(evidence: EditionEvidence): ExplicitEditionKind | null {
	if (/^podcast(?:parent|episode)?$/i.test(evidence.contentType?.trim() ?? '') ||
		/^podcast(?:parent|episode)?$/i.test(evidence.contentDeliveryType?.trim() ?? '') ||
		fields(evidence).some(text => /\bpodcasts?(?:\s+(?:series|feed))?\s*(?:\([^)]*\))?\s*$/i.test(text))) return 'podcast';
	if (fields(evidence).some(text =>
		/\b(?:box(?:ed)?[ -]?set|omnibus|anthology|compilation)\b/i.test(text) ||
		/\bbundle\s*(?:\([^)]*\))?\s*$/i.test(text) ||
		/\b(?:complete|collected)\s+(?:(?:\d+|[a-z]+)[ -]+){0,3}(?:series|collection|saga|trilogy|duology|works|novels|stories)\b/i.test(text) ||
		volumeRange.test(text))) return 'collection';
	if (fields(evidence).some(text => /\b(?:dramatized|dramatised|graphic[ -]?audio|full[ -]cast)\b/i.test(text))) return 'dramatized';
	return null;
}
