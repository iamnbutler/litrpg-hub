/** Export the full catalog. Reader preferences never delete source records. */
import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, closeDb } from '../db.js';
import { runMigrations } from '../migrate.js';
import { buildCatalog } from './catalog.js';
import type { CatalogBook } from '../../../src/lib/catalog.js';

const out = join(import.meta.dirname, '../../../static/data');
function writeJson(name: string, value: unknown) {
	const target = join(out, name), temp = `${target}.tmp`;
	writeFileSync(temp, JSON.stringify(value));
	renameSync(temp, target);
}
try {
	runMigrations();
	const catalog = buildCatalog(getDb());
	// A missing/empty local DB must not erase the committed, known-good snapshot.
	if (!catalog.books.length) throw new Error('Database is empty. Fetch/import data before exporting; the existing snapshot was preserved.');
	mkdirSync(out, { recursive: true });
	const years: Record<string, CatalogBook[]> = {};
	const series: Record<string, CatalogBook[]> = {};
	for (const book of catalog.books) {
		if (book.releaseDate) (years[book.releaseDate.slice(0, 4)] ??= []).push(book);
		if (book.series) (series[book.seriesKey] ??= []).push(book);
	}
	for (const [year, books] of Object.entries(years)) writeJson(`${year}.json`, books);
	for (const file of readdirSync(out)) {
		if (/^\d{4}\.json$/.test(file) && !years[file.slice(0,4)]) unlinkSync(join(out, file));
	}
	for (const books of Object.values(series)) books.sort((a,b) => (a.seriesNumber ?? 9999) - (b.seriesNumber ?? 9999));
	writeJson('series.json', series);
	writeJson('review.json', catalog.books.filter(b => b.issues.length).map(b => ({ id: b.id, title: b.title, author: b.author, issues: b.issues, url: b.url })));
	writeJson('meta.json', { lastUpdated: catalog.generatedAt, sourceSnapshotAt: catalog.sourceSnapshotAt, ...catalog.stats,
		years: Object.fromEntries(Object.entries(years).map(([year, books]) => [year, { totalBooks: books.length, exportedBooks: books.length }])),
		sources: [...new Set(catalog.books.flatMap(b => b.sources.map(s => s.name)))] });
	writeJson('catalog.json', catalog);
	console.log(`Exported ${catalog.stats.books} books, ${catalog.stats.series} indexed series, ${catalog.stats.assessed} Jev assessments. ${catalog.stats.needsReview} records have review notes.`);
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Catalog export failed.');
	process.exitCode = 1;
} finally { closeDb(); }
