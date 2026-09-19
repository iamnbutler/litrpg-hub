import type { CatalogBook, ContentSignal } from '../../../src/lib/catalog.js';

export const unknownSignal = (note = 'Not enough source information to assess.'): ContentSignal => ({
	verdict: 'unknown', confidence: 0, source: 'unknown', note
});
function sourceSignal(verdict: 'present' | 'absent', note: string): ContentSignal {
	return { verdict, confidence: 1, source: 'publisher', note };
}
/** Require a positive disclosure. Missing narrators and author names are not evidence. */
export function narrationSignal(narrator: string | null): ContentSignal {
	if (!narrator?.trim()) return unknownSignal('The source has not supplied a narrator.');
	if (/\bvirtual\s+voice\b|\b(?:ai|artificial intelligence)[ -]*(?:generated|narrat)|\b(?:voice\s+(?:clone|replica)|synthetic\s+voice)\b/i.test(narrator)) {
		return sourceSignal('present', `Narrator credit: ${narrator}`);
	}
	return sourceSignal('absent', `Named narrator credit: ${narrator}. This is source metadata, not independent verification.`);
}

function disclosed(text: string, positive: RegExp, negative: RegExp): ContentSignal {
	// Evaluate each clause independently: "no harem" must not match a positive harem rule.
	const clauses = text.split(/(?<=[.!?;])\s+|\n+/);
	const negatives: string[] = [];
	for (const clause of clauses) {
		if (negative.test(clause)) { negatives.push(clause); continue; }
		if (positive.test(clause)) return sourceSignal('present', clause.trim().slice(0, 260));
	}
	return negatives.length ? sourceSignal('absent', negatives[0].trim().slice(0, 260)) : unknownSignal();
}

export function classifyContent(book: Pick<CatalogBook, 'title' | 'subtitle' | 'description' | 'narrator'>): CatalogBook['content'] {
	const text = [book.title, book.subtitle, book.description].filter(Boolean).join('. ');
	return {
		sexualized: disclosed(text, /\b(?:erotica|smut|erotic\s+(?:fantasy|romance)|steamy\s+(?:romance|sex)|spicy\s+romance|sexual\s+wish[ -]fulfillment)\b/i, /\b(?:no|without|free\s+of)\s+(?:any\s+)?(?:erotica|smut|sexual\s+content)\b/i),
		explicit: disclosed(text,
			/\b(?:erotica|erotic\s+(?:fantasy|romance|adventure)|smut|explicit\s+(?:sexual|sex)|graphic\s+sex(?:ual)?|sexually\s+explicit|steamy\s+(?:sex|scenes))\b/i,
			/\b(?:no|without|free\s+of|does\s+not\s+(?:include|contain))\s+(?:any\s+)?(?:explicit\s+(?:sexual\s+)?(?:content|scenes)|sex(?:ual)?\s+(?:content|scenes)|smut|erotica)\b|\b(?:closed[ -]door|fade[ -]to[ -]black)\b/i),
		harem: disclosed(text, /\b(?:harem|haremlit|polyamorous\s+(?:romance|relationships))\b/i,
			/\b(?:no|non[ -]?|without|free\s+of|does\s+not\s+(?:include|contain))\s*(?:a\s+|any\s+)?(?:reverse\s+)?harem\b|\bharem[ -]free\b/i),
		aiNarration: narrationSignal(book.narrator),
		aiWriting: disclosed(text, /\b(?:written|generated|authored)\s+(?:entirely\s+|fully\s+|using\s+)?(?:by|with)\s+(?:an?\s+)?(?:ai|artificial intelligence|chatgpt)\b|\bai[ -]generated\s+(?:book|novel|text|story)\b/i,
			/\b(?:not|never)\s+(?:written|generated|authored)\s+(?:by|with)\s+(?:an?\s+)?(?:ai|artificial intelligence)\b|\bno\s+ai[ -]generated\b/i),
		quality: unknownSignal('Writing quality and AI authorship cannot be established from a listing alone.')
	};
}
