import { parseArgs } from 'node:util';
import { getDb, closeDb } from '../db.js';
import { runMigrations } from '../migrate.js';
import { buildCatalog } from '../exporters/catalog.js';
import { bookPopularity, defaultFilters, passesFilters, seriesStarters } from '../../../src/lib/catalog.js';
import { coverCacheKey, coverModel, fetchCover, toCoverAssessment } from './vision.js';
import { assessCover, hasUnpromotedVisionAttempt, loadCoverImageSource, type CoverImageSource } from './vision-cache.js';
import { contentAssessmentHash } from './content.js';
import { assessContent, hasUnpromotedContentResponse, loadContentAssessment } from './content-cache.js';
import { readCoverAsset, storeCoverAsset } from './assets.js';
import { contentBook } from '../catalog/inputs.js';

interface CachedCover {
	cache_key: string; image_hash: string; model: string; observation_json: string; evaluated_at: string; checked_at: string;
}
try {
	const { values } = parseArgs({ options: {
		limit: { type: 'string', default: '24' }, book: { type: 'string', multiple: true },
		force: { type: 'boolean', default: false }, 'refresh-images': { type: 'boolean', default: false },
		'all-editions': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
	} });
	if (values.help) {
		console.log('npm run pipeline:covers -- [--limit 24] [--book ASIN ...] [--all-editions] [--refresh-images] [--force] [--dry-run]\nAt most 100 books per run. OpenAI observes stored images; Jev combines that evidence with the listing. Changed model/rubric uses saved image bytes. Recent/upcoming covers refresh after 7 days; older covers after 180 days. Invalid saved vision responses are revalidated without another purchase; --force buys a new attempt and retains history. Builds never call either API.');
	} else {
		const limit = Number(values.limit);
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer between 1 and 100.');
		if (!values['dry-run']) runMigrations();
		const db = getDb(), catalog = buildCatalog(db);
		const eligible = catalog.books.filter(b => b.scope === 'indexed' && passesFilters(b, { ...defaultFilters, hideSexualized: false }));
		const candidates = values.book?.length ? values.book.map(id => {
			const book = catalog.books.find(b => b.id === id);
			if (!book) throw new Error(`Book ${id} is not in the local database.`);
			return book;
		}) : (values['all-editions'] ? eligible : seriesStarters(eligible)).sort((a,b) => bookPopularity(b) - bookPopularity(a));
		const readCover = db.prepare(`SELECT s.checked_at, o.* FROM cover_sources s JOIN cover_observations o ON o.cache_key = s.cache_key WHERE s.cover_url = ?`);
		const cachedContent=(book:typeof catalog.books[number],cover:NonNullable<typeof book.coverAssessment>)=>{
			const inputHash=contentAssessmentHash(contentBook(db,book),cover);
			return !!loadContentAssessment(db,book.id,inputHash) && !hasUnpromotedContentResponse(db,book.id,inputHash);
		};
		const imageDue = (cached: CoverImageSource | null, releaseDate: string | null) => {
			const recent = releaseDate && Date.parse(releaseDate) >= Date.now() - 30 * 86400000;
			const days = recent ? 7 : releaseDate ? 180 : 30;
			return !cached || !Number.isFinite(Date.parse(cached.checked_at)) || Date.parse(cached.checked_at) < Date.now() - days * 86400000;
		};
		const selected = candidates.filter(book => {
			if (!book.coverUrl) return false;
			const cached = readCover.get(book.coverUrl) as CachedCover | undefined;
			const source = loadCoverImageSource(db, book.coverUrl);
			if (values.force || values['refresh-images'] || imageDue(source,book.releaseDate) || !book.coverAssessment || !cached || cached.cache_key !== coverCacheKey(cached.image_hash) || !source || !readCoverAsset(source.image_hash) || hasUnpromotedVisionAttempt(db, coverCacheKey(source.image_hash))) return true;
			return !cachedContent(book,book.coverAssessment);
		}).slice(0, limit);
		console.log(`${selected.length} book(s) selected. Vision: ${coverModel()}; content: ${process.env.JEV_MODEL ?? 'jev-latest'}. ${values['dry-run'] ? 'Dry run: no downloads, API calls, or writes.' : ''}`);
		const usage = { visionInput: 0, visionOutput: 0, jevInput: 0, jevOutput: 0 };
		for (const [index, book] of selected.entries()) {
			console.log(`[${index+1}/${selected.length}] ${book.id} ${book.title}`);
			if (values['dry-run']) continue;
			const source = loadCoverImageSource(db, book.coverUrl!);
			const storedImage = source ? readCoverAsset(source.image_hash) : null;
			const download = values['refresh-images'] || imageDue(source,book.releaseDate) || !storedImage;
			const image = download ? await fetchCover(book.coverUrl!) : storedImage!;
			const checkedAt = download ? new Date().toISOString() : source!.checked_at;
			storeCoverAsset(image);
			const vision = await assessCover(db, image, { force: values.force, source: { url: book.coverUrl!, checkedAt } });
			usage.visionInput += vision.usage.input_tokens; usage.visionOutput += vision.usage.output_tokens;
			if (!vision.current) {
				console.log('  Cover evidence changed during inference; its response was retained without replacing the current cover.');
				continue;
			}
			const cover = toCoverAssessment(vision.observation, {
				model: vision.model, evaluatedAt: vision.evaluatedAt, imageHash: vision.imageHash, coverUrl: book.coverUrl!
			});
			const input=contentBook(db,book);
			const result = await assessContent(db,input,cover,{
				force:values.force,
				currentInputHash:()=>{
					// Rebuild from current rows after the request, not the batch's earlier snapshot.
					const latest=buildCatalog(db).books.find(candidate=>candidate.id===book.id);
					return latest?.coverAssessment?contentAssessmentHash(contentBook(db,latest),latest.coverAssessment):null;
				}
			});
			usage.jevInput += result.usage.input_tokens; usage.jevOutput += result.usage.output_tokens;
			if (!result.cached) {
				const { assessment } = result;
				console.log(`  Cover: ${cover.level} (${cover.confidence.toFixed(2)}); marketing: ${assessment.sexualized.verdict} (${assessment.sexualized.confidence.toFixed(2)}).`);
				if (!result.promoted) console.log('  Source or cover evidence changed during inference; the response was retained as history without replacing the current result.');
			} else console.log(`  Cover: ${cover.level}; cached content assessment reused.`);
		}
		console.log(`Finished. Tokens: ${JSON.stringify(usage)}. Run npm run pipeline:export to update the local catalog.`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Cover enrichment failed.');
	process.exitCode = 1;
} finally { closeDb(); }
