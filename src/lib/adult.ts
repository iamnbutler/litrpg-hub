/** Self-attested age gating.
 *
 * GitHub's OAuth API exposes no date of birth in any scope, so the only age signal available
 * is what the reader tells us. This records an honest claim, not a verification, and the date
 * is used for exactly one thing: deciding whether the two sexual-content filters can be
 * turned off. It is never exported, shown to anyone else, or used for recommendations.
 */
import type { ReaderFilters } from './catalog.js';

export const ADULT_AGE = 18;

/** Sexual content is the only axis behind the gate. Harem is a story structure and AI
 * disclosure is a production fact; neither establishes erotic content, so both stay ordinary
 * preferences that anyone can change. */
export const gatedFilters = ['hideSexualized', 'hideExplicit'] as const;
export type GatedFilter = (typeof gatedFilters)[number];
export const isGatedFilter = (key: string): key is GatedFilter => (gatedFilters as readonly string[]).includes(key);

export interface AdultConsent {
	/** YYYY-MM-DD exactly as the reader entered it, or null if never confirmed. */
	birthDate: string | null;
	attestedAt: string | null;
	/** Off until the reader deliberately turns it on, even once they are a confirmed adult. */
	allowAdult: boolean;
}
export const noConsent = (): AdultConsent => ({ birthDate: null, attestedAt: null, allowAdult: false });

/** A date in the future, or one implying an impossible age, is a typo rather than a claim. */
export function parseBirthDate(value: unknown, now = new Date()): string | null {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const parsed = new Date(`${value}T12:00:00Z`);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
	const today = now.toISOString().slice(0, 10);
	return value <= today && parsed.getUTCFullYear() >= now.getUTCFullYear() - 120 ? value : null;
}

/** The latest birth date that is already 18, computed as a calendar date rather than an
 * elapsed-days count so leap days and time zones cannot move someone's birthday. */
export function adultCutoff(today: string): string {
	return `${String(Number(today.slice(0, 4)) - ADULT_AGE).padStart(4, '0')}${today.slice(4)}`;
}
export function isAdult(birthDate: string | null | undefined, now = new Date().toISOString()): boolean {
	const today = now.slice(0, 10);
	const birth = parseBirthDate(birthDate, new Date(`${today}T12:00:00Z`));
	return !!birth && birth <= adultCutoff(today);
}

/** Re-derived from the stored date on every read, never trusted as a frozen boolean: a reader
 * who was 17 when they confirmed gains the option on their birthday without being asked again,
 * and a stale `allowAdult` can never outlive the date that justified it. */
export function adultUnlocked(consent: AdultConsent, now = new Date().toISOString()): boolean {
	return consent.allowAdult && isAdult(consent.birthDate, now);
}

/** Readers who have not unlocked adult content always browse with sexual content hidden,
 * whatever a stored preference, another tab, or an imported settings blob asks for. */
export function applyAdultGate(filters: ReaderFilters, unlocked: boolean): ReaderFilters {
	if (unlocked) return filters;
	const result = { ...filters };
	for (const key of gatedFilters) result[key] = true;
	return result;
}

export function parseAdultConsent(value: unknown, now = new Date().toISOString()): AdultConsent {
	if (!value || typeof value !== 'object') return noConsent();
	const data = value as Record<string, unknown>;
	const birthDate = parseBirthDate(data.birthDate, new Date(now));
	const attestedAt = typeof data.attestedAt === 'string' && Number.isFinite(Date.parse(data.attestedAt)) ? data.attestedAt : null;
	// An unlock claim is meaningless without a date that clears the age bar, so it is always
	// recomputed here rather than carried across from whatever supplied the record.
	return { birthDate, attestedAt: birthDate ? attestedAt : null, allowAdult: data.allowAdult === true && isAdult(birthDate, now) };
}
