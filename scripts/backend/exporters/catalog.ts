import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { seriesIdentity, validReleaseDate, signalIsPresent, genreLabels, type Assessment, type Catalog, type CatalogBook, type ContentSignal, type CoverAssessment } from '../../../src/lib/catalog.js';
import { classifyContent } from '../classifiers/content.js';
import { assessmentHash } from '../jev/assessment.js';
import { coverCacheKey, toCoverAssessment, validateObservation } from '../covers/vision.js';
import { contentAssessmentHash } from '../covers/content.js';
import { loadContentAssessment } from '../covers/content-cache.js';
import { applyAuthorRules } from '../classifiers/authors.js';
import { enrichCatalogSeries } from './series.js';
import { contentBook } from '../catalog/inputs.js';
import { applyAuthorProfile, loadAuthorProfiles } from '../catalog/authors.js';
import { readerContext } from '../catalog/reader-evidence.js';
import { explicitEditionKind } from '../../../src/lib/edition.js';

interface Row {
	id: string; title: string; subtitle: string | null; series_title: string | null;
	series_number: number | null; author: string; narrator: string | null;
	release_date: string; cover_url: string | null; runtime_minutes: number | null;
	description: string | null; url: string | null; rating: number | null;
	rating_count: number | null; subgenres: string | null; assessment_json: string | null; content_json: string | null;
	content_type: string | null; content_delivery_type: string | null;
}
const publicUrl = (url: string | null) => {
	try { return url && ['https:', 'http:'].includes(new URL(url).protocol) ? url : null; } catch { return null; }
};
type Overrides = Record<string, Partial<Record<keyof CatalogBook['content'], { verdict: ContentSignal['verdict']; note: string }>>>;

export function buildCatalog(db: Database.Database, now = new Date()): Catalog {
	const rows = db.prepare(`SELECT b.*, s.title AS series_title,
		(SELECT GROUP_CONCAT(subgenre) FROM book_subgenres WHERE book_id = b.id) AS subgenres,
		a.assessment_json, c.assessment_json AS content_json,
		CASE WHEN json_valid(raw.raw_data) THEN COALESCE(json_extract(raw.raw_data,'$.content_type'),json_extract(raw.raw_data,'$.product.content_type')) END AS content_type,
		CASE WHEN json_valid(raw.raw_data) THEN COALESCE(json_extract(raw.raw_data,'$.content_delivery_type'),json_extract(raw.raw_data,'$.product.content_delivery_type')) END AS content_delivery_type
		FROM books b LEFT JOIN series s ON s.id = b.series_id
		LEFT JOIN book_sources raw ON raw.book_id=b.id AND raw.source='audible'
		LEFT JOIN book_assessments a ON a.book_id = b.id
		LEFT JOIN book_content_assessments c ON c.book_id = b.id ORDER BY b.id`).all() as Row[];
	const covers = new Map<string, CoverAssessment>();
	for (const row of db.prepare(`SELECT s.cover_url, o.* FROM cover_sources s JOIN cover_observations o ON o.cache_key = s.cache_key`).all() as {
		cover_url: string; cache_key: string; image_hash: string; model: string; observation_json: string; evaluated_at: string
	}[]) {
		if (row.cache_key !== coverCacheKey(row.image_hash)) continue;
		covers.set(row.cover_url, toCoverAssessment(validateObservation(JSON.parse(row.observation_json)), {
			model: row.model, evaluatedAt: row.evaluated_at, imageHash: row.image_hash, coverUrl: row.cover_url
		}));
	}
	const sources = new Map<string, CatalogBook['sources']>();
	for (const row of db.prepare('SELECT book_id, source, MAX(fetched_at) AS fetched_at FROM book_sources GROUP BY book_id, source').all() as { book_id: string; source: string; fetched_at: string }[]) {
		const stamp = /Z$|[+-]\d\d:\d\d$/.test(row.fetched_at) ? row.fetched_at : `${row.fetched_at.replace(' ', 'T')}Z`;
		sources.set(row.book_id, [...(sources.get(row.book_id) ?? []), { name: row.source, fetchedAt: stamp }]);
	}
	const overrides: Overrides = JSON.parse(readFileSync(join(import.meta.dirname, '../config/content-overrides.json'), 'utf8'));
	const books: CatalogBook[] = rows.filter(r => r.title && r.title !== 'Untitled').map(row => {
		const book: CatalogBook = {
			id: row.id, title: row.title, subtitle: row.subtitle ?? '', series: row.series_title ?? '',
			seriesKey: row.series_title ? seriesIdentity(row.series_title, row.author) : row.id,
			seriesNumber: row.series_number, author: row.author || 'Unknown author', narrator: row.narrator,
			releaseDate: validReleaseDate(row.release_date, now), coverUrl: publicUrl(row.cover_url),
			runtimeMinutes: row.runtime_minutes && row.runtime_minutes > 0 ? row.runtime_minutes : null,
			description: row.description ?? '', url: publicUrl(row.url),
			rating: row.rating != null && row.rating >= 0 && row.rating <= 5 ? row.rating : null,
			ratingCount: Math.max(0, row.rating_count ?? 0),
			subgenres: [...new Set((row.subgenres ?? '').split(',').filter(g => g in genreLabels))],
			edition: explicitEditionKind({title:row.title,subtitle:row.subtitle,contentType:row.content_type,contentDeliveryType:row.content_delivery_type})??'audiobook',
			scope: 'indexed', content: classifyContent({ title: row.title, subtitle: row.subtitle ?? '', description: row.description ?? '', narrator: row.narrator }),
			assessment: null, coverAssessment: covers.get(row.cover_url ?? '') ?? null, sources: sources.get(row.id) ?? [], issues: []
		};
		if (row.assessment_json) {
			const cached = JSON.parse(row.assessment_json) as Assessment;
			if (cached.inputHash === assessmentHash(book)) {
				book.assessment = cached;
				for (const field of ['explicit', 'harem', 'quality'] as const) {
					if (book.content[field].verdict === 'unknown') book.content[field] = cached[field];
				}
				if (cached.genre.confidence >= 0.8 && ['litrpg', 'progression'].includes(cached.genre.value)) {
					if (cached.genre.value === 'progression') book.subgenres = book.subgenres.filter(g => g !== 'litrpg');
					book.subgenres = [...new Set([...book.subgenres, cached.genre.value])];
				}
			}
		}
		return book;
	});
	const series = enrichCatalogSeries(db,books);
	const curatedSeries=new Set(series.filter(s=>s.curated).map(s=>s.id));
	const authorProfiles=loadAuthorProfiles(db);
	const readerContexts=new Map<string,ReturnType<typeof readerContext>>();
	if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_reader_traits'").get()){
		for(const row of db.prepare('SELECT DISTINCT work_id FROM catalog_reader_evidence WHERE work_id IS NOT NULL').all() as {work_id:string}[]){
			const context=readerContext(db,'work',row.work_id);
			if(context&&(context.observation||context.traits.length))readerContexts.set(row.work_id,context);
		}
	}
	for (const book of books) {
		const readers=readerContexts.get(book.workId??'');
		if(readers)book.readerContext=readers;
		book.coverAssessment=covers.get(book.coverUrl??'')??null;
		if(book.coverAssessment){
			const visual=book.coverAssessment.signal;
			if(signalIsPresent(visual)||book.content.sexualized.verdict==='unknown')book.content.sexualized=visual;
			const input=contentBook(db,book),inputHash=contentAssessmentHash(input,book.coverAssessment);
			const cached=loadContentAssessment(db,book.id,inputHash);
			if(cached){
				for(const field of ['sexualized','explicit','harem'] as const){
					if(book.content[field].source==='publisher'&&book.content[field].verdict!=='unknown')continue;
					if(!signalIsPresent(book.content[field])&&(signalIsPresent(cached[field])||book.content[field].verdict==='unknown'))book.content[field]=cached[field];
				}
			}
		}
		applyAuthorProfile(book,authorProfiles);
		applyAuthorRules(book);
		// A reviewed exception for an individual book wins after every automated enrichment.
		for (const [key, override] of Object.entries(overrides[book.id] ?? {})) {
			if (!(key in book.content) || !override || !['present', 'absent', 'unknown'].includes(override.verdict) || !override.note?.trim()) throw new Error(`Invalid content override for ${book.id}/${key}`);
			book.content[key as keyof CatalogBook['content']] = { ...override, source: 'manual', confidence: 1 };
		}
		const genre = book.assessment?.genre;
		book.scope = book.subgenres.length > 0 && (curatedSeries.has(book.seriesKey)||!(genre?.value === 'unrelated' && genre.confidence >= 0.8)) ? 'indexed' : 'review';
		if (!book.releaseDate) book.issues.push('Release date needs confirmation');
		if (!book.description || book.description.length < 60) book.issues.push('Limited description');
		if (!book.narrator) book.issues.push('Narrator not supplied');
		if (!book.coverUrl) book.issues.push('Cover not supplied');
		if (book.scope === 'review') book.issues.push('Genre needs review');
		if (signalIsPresent(book.content.quality)) book.issues.push('Listing quality needs review');
	}
	// One refreshed book must not make the whole catalog look freshly fetched.
	const timestamps = books.flatMap(b => b.sources.map(s => s.fetchedAt)).filter(s => Number.isFinite(Date.parse(s))).sort();
	return {
		version: 1, generatedAt: now.toISOString(), sourceSnapshotAt: timestamps[Math.floor(timestamps.length / 2)] ?? null,
		stats: {
			books: books.length, series: new Set(books.filter(b => b.series && b.scope === 'indexed').map(b => b.seriesKey)).size,
			assessed: books.filter(b => b.assessment).length, needsReview: books.filter(b => b.issues.length).length,
			staleSources: books.filter(b => !b.sources.length || Math.max(...b.sources.map(s => Date.parse(s.fetchedAt))) < now.getTime() - 30 * 86400000).length
		}, books, series
	};
}
