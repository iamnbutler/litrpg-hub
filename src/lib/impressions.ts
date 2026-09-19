import { displayDate } from './catalog.js';
import type { ReaderContext } from './reader-context.js';

/** A trait reduced to what is safe to show. Confidence is deliberately absent: it describes a
 * model's certainty, and printing it beside a review count invites reading it as the share of
 * readers who agreed. `voices` is absent too — it is the size of the whole sampled corpus, not
 * the number of readers who raised THIS trait, so rendering it per trait would invent a mention
 * count the source never measured. Consensus is carried qualitatively, once, for the sample. */
export interface ImpressionTrait {
	trait: string;
	label: string;
	value: string;
	summary: string;
}
export interface ImpressionsView {
	/** Substantive voices only — reviews that actually said something. Never `voices`. */
	sampled: number;
	span: string | null;
	/** One judgement about the whole sample. Shown once; repeating it against each trait would
	 * imply four independent readings of reader agreement where the source has only one. */
	consensus: 'consistent' | 'mixed' | 'insufficient' | null;
	/** The finding, in original prose grounded in this sample. Leads when present. */
	observation: string | null;
	traits: ImpressionTrait[];
	sources: { name: string; url: string }[];
}

const MIN_CONFIDENCE = 0.65;
const MAX_TRAITS = 4;
/** A claim about narration can only stand on a review that mentions listening, because the
 * sample is book-level and mixes print and ebook readers with listeners. */
const NARRATION = /narrat|audio|voice|performance|listen|pacing of the read/i;
const MENTIONS_LISTENING = /listen|audiobook|audio|narrat/i;

const label = (trait: string) => {
	// Sentence case, so `powerCreep` reads "Power creep" rather than shouting "Power Creep".
	const spaced = trait.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`).trim();
	return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : trait;
};
/** Rendered into an href, so anything that is not plainly http(s) is dropped. */
const safeUrl = (url: unknown): url is string => {
	if (typeof url !== 'string') return false;
	try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
};

/** Select what may be shown from a reader-context aggregate, or null when there is nothing
 * worth showing. Thin and empty data is skipped entirely rather than padded out. */
export function readerImpressions(context: ReaderContext | undefined | null): ImpressionsView | null {
	if (!context || typeof context !== 'object') return null;
	const sampled = Number.isFinite(context.substantiveVoices) ? Math.max(0, Math.trunc(context.substantiveVoices)) : 0;
	if (sampled < 1) return null;

	const traits = (Array.isArray(context.traits) ? context.traits : [])
		.filter((t) => t && typeof t.trait === 'string' && typeof t.value === 'string')
		.filter((t) => Number.isFinite(t.confidence) && t.confidence >= MIN_CONFIDENCE)
		.filter((t) => t.value.trim() !== '' && t.value.trim().toLowerCase() !== 'unknown')
		// Drop a narration claim unless the summary shows it came from someone listening.
		.filter((t) => !NARRATION.test(t.trait) || MENTIONS_LISTENING.test(t.summary ?? ''))
		.sort((a, b) => b.confidence - a.confidence || a.trait.localeCompare(b.trait))
		.slice(0, MAX_TRAITS)
		.map((t) => ({
			trait: t.trait,
			label: label(t.trait),
			value: t.value.trim(),
			summary: typeof t.summary === 'string' ? t.summary.trim() : ''
		}));
	const observation = typeof context.observation === 'string' && context.observation.trim() ? context.observation.trim() : null;
	// A binary label flattens a shape readers care about: Cradle reads `pacing-slow` against an
	// observation describing a slow opening that then accelerates. Both are true, and a card
	// saying "Pacing: slow" would misrepresent the sample. When we have the prose, show only it.
	const shown = observation ? [] : traits;
	if (!observation && !shown.length) return null;

	const span = Array.isArray(context.span) && context.span.length === 2 && context.span.every((d) => typeof d === 'string')
		? `${displayDate(context.span[0], { day: undefined })} – ${displayDate(context.span[1], { day: undefined })}`
		: null;
	const sources = (Array.isArray(context.sources) ? context.sources : [])
		.filter((s) => s && typeof s.name === 'string' && s.name.trim() !== '' && safeUrl(s.url))
		.map((s) => ({ name: s.name.trim(), url: s.url }));

	const consensus = ['consistent', 'mixed', 'insufficient'].includes(context.consensus as string)
		? (context.consensus as ImpressionsView['consensus']) : null;
	return { sampled, span, consensus, observation, traits: shown, sources };
}
