import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,v]) => [key,canonical(v)]));
	return value;
}
export function sourceHash(raw: string): string {
	let normalized: string;
	try { normalized = JSON.stringify(canonical(JSON.parse(raw))); } catch { normalized = raw; }
	return createHash('sha256').update(normalized).digest('hex');
}
export function retainSource(db: Database.Database, row: { book_id: string; source: string; source_id: string | null; raw_data: string; fetched_at: string }): void {
	db.prepare(`INSERT INTO source_snapshots (book_id,source,source_id,content_hash,raw_data,first_seen_at,last_seen_at)
		VALUES (?,?,?,?,?,?,?) ON CONFLICT(book_id,source,content_hash) DO UPDATE SET last_seen_at=MAX(source_snapshots.last_seen_at,excluded.last_seen_at)`).run(
		row.book_id,row.source,row.source_id,sourceHash(row.raw_data),row.raw_data,row.fetched_at,row.fetched_at);
}
/** Preserve the inherited latest source records before any new fetch overwrites them. */
export function archiveCurrentSources(db: Database.Database): number {
	const rows = db.prepare('SELECT book_id,source,source_id,raw_data,fetched_at FROM book_sources WHERE raw_data IS NOT NULL').all() as Parameters<typeof retainSource>[1][];
	const before = (db.prepare('SELECT COUNT(*) AS n FROM source_snapshots').get() as { n: number }).n;
	db.transaction(() => { for (const row of rows) retainSource(db,row); })();
	return (db.prepare('SELECT COUNT(*) AS n FROM source_snapshots').get() as { n: number }).n - before;
}
