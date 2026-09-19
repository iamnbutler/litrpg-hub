import { defaultFilters, type ReaderFilters } from './catalog.js';
export type ShelfStatus = 'want' | 'reading' | 'read' | 'paused';
export const shelfLabels: Record<ShelfStatus, string> = { want: 'Want to read', reading: 'Reading', read: 'Read', paused: 'On hold' };
export interface ShelfEntry { status: ShelfStatus; rating: number | null; updatedAt: string }
export type Library = Record<string, ShelfEntry>;
export function parseLibrary(value: unknown): Library {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const result: Library = {};
	for (const [id, entry] of Object.entries(value)) {
		if (!entry || typeof entry !== 'object' || !Object.hasOwn(shelfLabels, entry.status) || !/^[a-zA-Z0-9_-]+$/.test(id) || ['__proto__','constructor','prototype'].includes(id)) continue;
		result[id] = { status: entry.status, rating: Number.isInteger(entry.rating) && entry.rating >= 1 && entry.rating <= 5 ? entry.rating : null,
			updatedAt: typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt)) ? entry.updatedAt : new Date().toISOString() };
	}
	return result;
}
export function parseFilters(value: unknown): ReaderFilters {
	const result = { ...defaultFilters };
	if (!value || typeof value !== 'object') return result;
	for (const key of Object.keys(result) as (keyof ReaderFilters)[]) {
		const v = (value as Record<string, unknown>)[key];
		if (typeof v === 'boolean') result[key] = v;
	}
	return result;
}
