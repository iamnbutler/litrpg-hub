import { parseArgs } from 'node:util';
import { getDb, closeDb } from '../db.js';
import { runMigrations } from '../migrate.js';
import { buildCatalog } from '../exporters/catalog.js';
import { bookPopularity, defaultFilters, passesFilters, seriesStarters } from '../../../src/lib/catalog.js';
import { evaluate } from '../jev/client.js';
import { COVER_RUBRIC_VERSION, coverCacheKey, coverModel, fetchCover, observeCover, toCoverAssessment, validateObservation } from './vision.js';
import { CONTENT_RUBRIC_VERSION, contentAssessmentHash, contentQuestions, contentState, toContentAssessment } from './content.js';
import { readCoverAsset, storeCoverAsset } from './assets.js';

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
		console.log('npm run pipeline:covers -- [--limit 24] [--book ASIN ...] [--all-editions] [--refresh-images] [--force] [--dry-run]\nAt most 100 books per run. OpenAI observes stored images; Jev combines that evidence with the listing. Changed model/rubric uses saved image bytes. Recent/upcoming covers refresh after 7 days; older covers after 180 days. Builds never call either API.');
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
		const readContent = db.prepare('SELECT input_hash FROM book_content_assessments WHERE book_id = ?');
		const imageDue = (cached: CachedCover | undefined, releaseDate: string | null) => {
			const recent = releaseDate && Date.parse(releaseDate) >= Date.now() - 30 * 86400000;
			const days = recent ? 7 : releaseDate ? 180 : 30;
			return !cached || !Number.isFinite(Date.parse(cached.checked_at)) || Date.parse(cached.checked_at) < Date.now() - days * 86400000;
		};
		const selected = candidates.filter(book => {
			if (!book.coverUrl) return false;
			const cached = readCover.get(book.coverUrl) as CachedCover | undefined;
			if (values.force || values['refresh-images'] || imageDue(cached,book.releaseDate) || !book.coverAssessment || !cached || cached.cache_key !== coverCacheKey(cached.image_hash) || !readCoverAsset(cached.image_hash)) return true;
			return (readContent.get(book.id) as { input_hash: string } | undefined)?.input_hash !== contentAssessmentHash(book, book.coverAssessment);
		}).slice(0, limit);
		console.log(`${selected.length} book(s) selected. Vision: ${coverModel()}; content: ${process.env.JEV_MODEL ?? 'jev-latest'}. ${values['dry-run'] ? 'Dry run: no downloads, API calls, or writes.' : ''}`);
		const usage = { visionInput: 0, visionOutput: 0, jevInput: 0, jevOutput: 0 };
		for (const [index, book] of selected.entries()) {
			console.log(`[${index+1}/${selected.length}] ${book.id} ${book.title}`);
			if (values['dry-run']) continue;
			let cached = readCover.get(book.coverUrl!) as CachedCover | undefined;
			const storedImage = cached ? readCoverAsset(cached.image_hash) : null;
			const download = values['refresh-images'] || imageDue(cached,book.releaseDate) || !storedImage;
			if (values.force || download || !cached || cached.cache_key !== coverCacheKey(cached.image_hash)) {
				const checkedAt = download ? new Date().toISOString() : cached!.checked_at;
				const image = download ? await fetchCover(book.coverUrl!) : storedImage!;
				storeCoverAsset(image);
				const cacheKey = coverCacheKey(image.hash);
				cached = values.force ? undefined : db.prepare('SELECT * FROM cover_observations WHERE cache_key = ?').get(cacheKey) as CachedCover | undefined;
				if (!cached) {
					const result = await observeCover(image), evaluatedAt = new Date().toISOString();
					db.prepare(`INSERT INTO cover_observations (cache_key,image_hash,requested_model,model,rubric_version,observation_json,usage_json,evaluated_at)
						VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET model=excluded.model, observation_json=excluded.observation_json, usage_json=excluded.usage_json, evaluated_at=excluded.evaluated_at`).run(
						cacheKey, image.hash, coverModel(), result.model, COVER_RUBRIC_VERSION, JSON.stringify(result.observation), JSON.stringify(result.usage), evaluatedAt);
					cached = { cache_key: cacheKey, image_hash: image.hash, model: result.model, observation_json: JSON.stringify(result.observation), evaluated_at: evaluatedAt, checked_at: evaluatedAt };
					usage.visionInput += result.usage.input_tokens; usage.visionOutput += result.usage.output_tokens;
				}
				db.prepare('INSERT INTO cover_sources (cover_url,cache_key,checked_at) VALUES (?,?,?) ON CONFLICT(cover_url) DO UPDATE SET cache_key=excluded.cache_key,checked_at=excluded.checked_at').run(book.coverUrl, cacheKey, checkedAt);
			}
			if (!cached) throw new Error('No cover observation is available.');
			const cover = toCoverAssessment(validateObservation(JSON.parse(cached.observation_json)), {
				model: cached.model, evaluatedAt: cached.evaluated_at, imageHash: cached.image_hash, coverUrl: book.coverUrl!
			});
			const inputHash = contentAssessmentHash(book, cover);
			if (values.force || (readContent.get(book.id) as { input_hash: string } | undefined)?.input_hash !== inputHash) {
				const response = await evaluate(contentState(book, cover), contentQuestions);
				const assessment = toContentAssessment(book, cover, response);
				db.prepare(`INSERT INTO book_content_assessments (book_id,input_hash,model,rubric_version,assessment_json,response_json,evaluated_at)
					VALUES (?,?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET input_hash=excluded.input_hash,model=excluded.model,rubric_version=excluded.rubric_version,assessment_json=excluded.assessment_json,response_json=excluded.response_json,evaluated_at=excluded.evaluated_at`).run(
					book.id,inputHash,response.model,CONTENT_RUBRIC_VERSION,JSON.stringify(assessment),JSON.stringify(response),assessment.evaluatedAt);
				usage.jevInput += response.usage.input_tokens; usage.jevOutput += response.usage.output_tokens;
				console.log(`  Cover: ${cover.level} (${cover.confidence.toFixed(2)}); marketing: ${assessment.sexualized.verdict} (${assessment.sexualized.confidence.toFixed(2)}).`);
			} else console.log(`  Cover: ${cover.level}; cached content assessment reused.`);
		}
		console.log(`Finished. Tokens: ${JSON.stringify(usage)}. Run npm run pipeline:export to update the local catalog.`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Cover enrichment failed.');
	process.exitCode = 1;
} finally { closeDb(); }
