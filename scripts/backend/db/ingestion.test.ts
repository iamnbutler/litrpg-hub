import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../http.js';

const state = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('../db.js', () => ({ getDb: () => state.db!, closeDb: () => {} }));
import { upsertBook, upsertBookSource, getBook, type BookRow } from './index.js';
import { AudibleFetcher } from '../fetchers/audible.js';
import { buildCatalog } from '../exporters/catalog.js';
import { coverCacheKey, COVER_RUBRIC_VERSION, coverModel } from '../covers/vision.js';
import { defaultFilters, passesFilters } from '../../../src/lib/catalog.js';

const book: BookRow = { id: 'B000000001', title: 'Original title', subtitle: null, author: 'An Author', narrator: 'A Narrator', series_name: 'Shared title', series_number: 1, release_date: '2026-01-01', cover_url: 'https://example.com/cover.jpg', runtime_minutes: 600, rating: 4.8, rating_count: 10, description: 'A sufficiently detailed original publisher description with worldbuilding.', url: 'https://example.com/book', is_ai_narrated: false };
beforeEach(() => {
	state.db = new Database(':memory:');
	for (const name of ['001_initial.sql','002_cursor_results_found.sql','003_jev_assessments.sql','004_cover_assessments.sql','005_source_history.sql']) state.db.exec(readFileSync(join(import.meta.dirname, '../migrations', name), 'utf8'));
});
afterEach(() => state.db?.close());

describe('durable ingestion regressions', () => {
	it('retains changed source payloads once and preserves the external source identity', () => {
		upsertBook(book);
		upsertBookSource(book.id,'hardcover','{"title":"Original","id":42}','42');
		upsertBookSource(book.id,'hardcover','{"id":42,"title":"Original"}','42');
		upsertBookSource(book.id,'hardcover','{"id":42,"title":"Revised"}','42');
		expect(state.db!.prepare('SELECT * FROM source_snapshots').all()).toHaveLength(2);
		expect(state.db!.prepare('SELECT source_id,raw_data FROM book_sources').get()).toEqual({ source_id: '42', raw_data: '{"id":42,"title":"Revised"}' });
	});
	it('exports cover evidence into the filter and invalidates it when the source cover changes', () => {
		upsertBook({ ...book, description: 'No explicit sexual content. A kingdom-building adventure.' });
		const key = coverCacheKey('image-a');
		state.db!.prepare('INSERT INTO cover_observations VALUES (?,?,?,?,?,?,?,?)').run(key,'image-a',coverModel(),'gpt-4.1-mini-test',COVER_RUBRIC_VERSION,
			JSON.stringify({ level: 'sexualized', confidence: 0.9, observations: ['Cleavage-focused fantasy pin-up.'] }), '{}', new Date().toISOString());
		state.db!.prepare('INSERT INTO cover_sources VALUES (?,?,?)').run(book.cover_url,key,new Date().toISOString());
		let exported = buildCatalog(state.db!).books[0];
		expect(exported.content.explicit.verdict).toBe('absent');
		expect(exported.content.sexualized).toMatchObject({ verdict: 'present', source: 'vision' });
		expect(passesFilters(exported,defaultFilters)).toBe(false);
		upsertBook({ ...book, cover_url: 'https://example.com/revised-cover.jpg' });
		exported = buildCatalog(state.db!).books[0];
		expect(exported.coverAssessment).toBeNull();
		expect(exported.content.sexualized.verdict).toBe('unknown');
	});
	it('preserves good metadata when an API response is partial', () => {
		upsertBook(book);
		upsertBook({ ...book, title: 'Untitled', author: null, narrator: null, series_name: null, series_number: null, release_date: null, cover_url: null, runtime_minutes: null, rating: null, rating_count: null, description: '', url: null });
		expect(getBook(book.id)).toEqual(book);
	});
	it('does not merge two authors whose series share a title', () => {
		upsertBook(book); upsertBook({ ...book, id: 'B000000002', author: 'Another Author' });
		const groups = state.db!.prepare('SELECT DISTINCT series_id FROM books').all();
		expect(groups).toHaveLength(2);
	});
	it('stops after soft throttling without advancing the search cursor', async () => {
		const get = vi.fn().mockResolvedValue({ products: [], total_results: 500 });
		const http: HttpClient = { get, getJson: get, post: get };
		const result = await new AudibleFetcher({ http }).fetch({ year: 2026, incremental: true });
		expect(result.errors).toHaveLength(1);
		expect(get).toHaveBeenCalledOnce();
		expect(state.db!.prepare('SELECT * FROM search_cursors').all()).toHaveLength(0);
		expect(state.db!.prepare('SELECT status FROM fetch_runs').get()).toEqual({ status: 'failed' });
	});
	it('retains books with uncertain dates and absent metadata in the catalog', () => {
		upsertBook({ ...book, release_date: '2200-01-01', narrator: null });
		const catalog = buildCatalog(state.db!, new Date('2026-09-18T12:00:00Z'));
		expect(catalog.books).toHaveLength(1);
		expect(catalog.books[0].releaseDate).toBeNull();
		expect(catalog.books[0].content.aiNarration.verdict).toBe('unknown');
		expect(catalog.books[0].issues).toContain('Release date needs confirmation');
	});
});
