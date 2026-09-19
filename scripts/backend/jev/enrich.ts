import { parseArgs } from 'node:util';
import { getDb, closeDb } from '../db.js';
import { runMigrations } from '../migrate.js';
import { buildCatalog } from '../exporters/catalog.js';
import { bookPopularity, seriesStarters } from '../../../src/lib/catalog.js';
import { evaluate } from './client.js';
import { assessmentHash, assessmentState, questions, RUBRIC_VERSION, toAssessment } from './assessment.js';

try {
	const { values } = parseArgs({ options: {
		limit: { type: 'string', default: '24' }, book: { type: 'string' }, force: { type: 'boolean', default: false },
		'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
	} });
	if (values.help) {
		console.log('npm run pipeline:enrich -- [--limit 24] [--book ASIN] [--force] [--dry-run]\nAt most 100 new book evaluations per run. Builds never call Jev.');
	} else {
		const limit = Number(values.limit);
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer between 1 and 100.');
		runMigrations();
		const db = getDb(), catalog = buildCatalog(db);
		const candidates = values.book ? catalog.books.filter(b => b.id === values.book) :
			seriesStarters(catalog.books.filter(b => b.scope === 'indexed' && b.description.length >= 60)).sort((a,b) => bookPopularity(b) - bookPopularity(a));
		if (values.book && !candidates.length) throw new Error(`Book ${values.book} is not in the local database.`);
		const selected = candidates.filter(b => values.force || !b.assessment).slice(0, limit);
		console.log(`${selected.length} uncached book(s), ${Object.keys(questions).length} independent questions per request. ${values['dry-run'] ? 'Dry run: no API calls.' : ''}`);
		let input = 0, output = 0;
		for (const [index, book] of selected.entries()) {
			console.log(`[${index+1}/${selected.length}] ${book.title} — ${book.author}`);
			if (values['dry-run']) continue;
			const response = await evaluate(assessmentState(book), questions);
			const assessment = toAssessment(book, response);
			db.prepare(`INSERT INTO book_assessments (book_id, input_hash, model, rubric_version, assessment_json, response_json, evaluated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(book_id) DO UPDATE SET input_hash=excluded.input_hash,
				model=excluded.model, rubric_version=excluded.rubric_version, assessment_json=excluded.assessment_json,
				response_json=excluded.response_json, evaluated_at=excluded.evaluated_at`).run(
				book.id, assessmentHash(book), response.model, RUBRIC_VERSION, JSON.stringify(assessment), JSON.stringify(response), assessment.evaluatedAt);
			input += response.usage.input_tokens; output += response.usage.output_tokens;
		}
		console.log(`Finished. Tokens: ${input} input / ${output} output. Run npm run pipeline:export to publish these assessments to the local catalog.`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Jev enrichment failed.');
	process.exitCode = 1;
} finally { closeDb(); }
