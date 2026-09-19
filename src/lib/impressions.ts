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
	/** Backend-approved bullets, passed through verbatim. Never derived here: splitting the
	 * observation on punctuation or sentiment words would manufacture a critique the sample
	 * never recorded, and a one-sided sample would sprout a second column out of nothing. */
	impressions: string[];
	critiques: string[];
	traits: ImpressionTrait[];
	sources: { name: string; url: string }[];
}

const MIN_CONFIDENCE = 0.65;
const MAX_TRAITS = 4;
/** A guard against a runaway aggregate, not an editorial trim: approved wording is never cut. */
const MAX_BULLETS = 6;
/** A claim about narration can only stand on a review that mentions listening, because the
 * sample is book-level and mixes print and ebook readers with listeners. */
const NARRATION = /narrat|audio|voice|performance|listen|pacing of the read/i;
const MENTIONS_LISTENING = /listen|audiobook|audio|narrat/i;

const label = (trait: string) => {
	// Sentence case, so `powerCreep` reads "Power creep" rather than shouting "Power Creep".
	const spaced = trait.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`).trim();
	return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : trait;
};
/** The approved split lives on `ReaderContext`, which another owner maintains. Read it
 * structurally so this module compiles and behaves correctly either side of that change:
 * absent means no approved split, which is a supported state, not an error. */
const approvedBullets = (context: ReaderContext, key: 'impressions' | 'critiques'): string[] => {
	const raw = (context as Partial<Record<'impressions' | 'critiques', unknown>>)[key];
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'string') continue;
		const text = entry.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
		if (out.length === MAX_BULLETS) break;
	}
	return out;
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
	const impressions = approvedBullets(context, 'impressions');
	const critiques = approvedBullets(context, 'critiques');
	// Either column may stand alone. A sample that recorded only praise is a finding; inventing
	// a critique to balance the layout would be a claim about readers who never made it.
	const hasSplit = impressions.length > 0 || critiques.length > 0;
	// A binary label flattens a shape readers care about: Cradle reads `pacing-slow` against an
	// observation describing a slow opening that then accelerates. Both are true, and a card
	// saying "Pacing: slow" would misrepresent the sample. Prose and approved bullets both say
	// it better, so the flattened labels only appear when neither exists.
	const shown = observation || hasSplit ? [] : traits;
	if (!observation && !hasSplit && !shown.length) return null;
	// The split is a reviewed reading OF the observation, so showing both would print the same
	// finding twice, once as a paragraph and once as bullets. The columns replace the prose;
	// the paragraph is what we fall back to when no approved split exists.
	const lead = hasSplit ? null : observation;

	const span = Array.isArray(context.span) && context.span.length === 2 && context.span.every((d) => typeof d === 'string')
		? `${displayDate(context.span[0], { day: undefined })} – ${displayDate(context.span[1], { day: undefined })}`
		: null;
	const sources = (Array.isArray(context.sources) ? context.sources : [])
		.filter((s) => s && typeof s.name === 'string' && s.name.trim() !== '' && safeUrl(s.url))
		.map((s) => ({ name: s.name.trim(), url: s.url }));

	const consensus = ['consistent', 'mixed', 'insufficient'].includes(context.consensus as string)
		? (context.consensus as ImpressionsView['consensus']) : null;
	return { sampled, span, consensus, observation: lead, impressions, critiques, traits: shown, sources };
}

/* ── Methodology disclosure state ───────────────────────────────────────────────────────────
 * Hover, focus, pointer and keyboard all drive one disclosure, so the rules live here as a
 * pure reducer rather than as CSS and handlers that can disagree. CSS-only hover was the
 * earlier approach and it broke two contracts: Escape could not dismiss hovered content, and
 * `aria-expanded` stayed false while the panel was plainly visible.
 */
export interface DisclosureState {
	hovering: boolean;
	focused: boolean;
	/** Explicitly opened, so it survives the pointer leaving. */
	pinned: boolean;
	/** Explicitly closed, so it stays shut even while hovered or focused. */
	dismissed: boolean;
	/** A pointer press already handled this activation; the click it produces is a duplicate. */
	pressed: boolean;
}
export type DisclosureAction = 'hover-in' | 'hover-out' | 'focus-in' | 'focus-out' | 'press' | 'click' | 'escape';

export const CLOSED: DisclosureState = { hovering: false, focused: false, pinned: false, dismissed: false, pressed: false };
export const isOpen = (state: DisclosureState): boolean =>
	!state.dismissed && (state.pinned || state.hovering || state.focused);

/** Once the pointer and focus have both gone, the control forgets that it was forced open or
 * shut, so the next approach starts from a clean state rather than an old decision. */
const settle = (state: DisclosureState): DisclosureState =>
	state.hovering || state.focused ? state : { ...state, pinned: false, dismissed: false };
const toggle = (state: DisclosureState): DisclosureState =>
	isOpen(state) ? { ...state, pinned: false, dismissed: true } : { ...state, pinned: true, dismissed: false };

export function reduceDisclosure(state: DisclosureState, action: DisclosureAction): DisclosureState {
	switch (action) {
		case 'hover-in': return { ...state, hovering: true };
		case 'hover-out': return settle({ ...state, hovering: false });
		case 'focus-in': return { ...state, focused: true };
		case 'focus-out': return settle({ ...state, focused: false });
		// A press lands before the focus it causes, so a first tap sees a closed control and
		// opens it. Handling this on click instead would read the focus this very tap just
		// produced as "already open" and shut it again.
		case 'press': return { ...toggle(state), pressed: true };
		case 'click': return state.pressed ? { ...state, pressed: false } : toggle(state);
		// Dismissal outranks hover: otherwise Escape would appear to do nothing under a cursor.
		case 'escape': return isOpen(state) ? { ...state, pinned: false, dismissed: true } : state;
	}
}
