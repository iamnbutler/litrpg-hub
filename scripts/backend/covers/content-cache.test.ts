import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hash } from '../catalog/queue.js';
import { PaidResponseStorageError, ReviewError } from '../catalog/types.js';
import { evaluate as evaluateJev, type JevResponse } from '../jev/client.js';
import { contentAssessmentHash, toContentAssessment } from './content.js';
import { assessContent, ContentCacheReviewError, hasUnpromotedContentResponse, loadContentAssessment, loadContentWireResponse, saveContentAssessment } from './content-cache.js';
import { toCoverAssessment } from './vision.js';

const input = { id: 'B000000001', title: 'A Test Adventure', subtitle: '', series: 'Test Series', author: 'Test Author', description: 'An adventurer explores a lost city with a trusted companion.' };
const cover = toCoverAssessment({ level: 'none', confidence: 0.95, observations: ['Two adventurers look toward a distant city.'] }, {
	model: 'vision-test', evaluatedAt: '2026-01-01T00:00:00Z', imageHash: 'test-image-hash', coverUrl: 'https://m.media-amazon.com/images/I/test.jpg'
});
let db: Database.Database;

function migrate(name: string) {
	db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
}
function database(names = ['001_initial.sql', '004_cover_assessments.sql', '006_catalog_pipeline.sql', '009_cover_inference_heads.sql']) {
	db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	for (const name of names) migrate(name);
}
function response(choice: 'present' | 'absent' | 'unknown' = 'absent', inputTokens = 17): JevResponse {
	const answer = (value: typeof choice) => ({ type: 'choice' as const, choice: value, confidence: 0.9, probabilities: {
		present: value === 'present' ? 0.9 : 0.05, absent: value === 'absent' ? 0.9 : 0.05, unknown: value === 'unknown' ? 0.9 : 0.05
	} });
	return { model: 'jev-test-actual', answers: { sexualized: answer(choice), explicit: answer('unknown'), harem: answer('unknown') }, usage: { input_tokens: inputTokens, output_tokens: 3 } };
}
/** Exercise the production HTTP reader, onResponse callback, and validator without network access. */
function client(responses: (JevResponse | string)[] = [response()], hooks: {
	beforeResponse?: () => void | Promise<void>;
	afterResponse?: (text: string) => void | Promise<void>;
} = {}) {
	let index = 0;
	const fetch = vi.fn<typeof globalThis.fetch>(async () => {
		await hooks.beforeResponse?.();
		const raw = responses[Math.min(index++, responses.length - 1)];
		return new Response(typeof raw === 'string' ? raw : JSON.stringify(raw), { status: 200 });
	});
	const evaluate = vi.fn<typeof evaluateJev>((state, questions, options = {}) => evaluateJev(state, questions, {
		...options, apiKey: 'synthetic-test-key', fetch, sleep: async () => {},
		onResponse: async text => {
			await options.onResponse?.(text);
			await hooks.afterResponse?.(text);
		}
	}));
	return { evaluate, fetch };
}
function legacyBook() {
	db.prepare('INSERT INTO books (id,title,author,release_date,description) VALUES (?,?,?,?,?)')
		.run(input.id, input.title, input.author, '2025-01-01', input.description);
}
function currentInputHash() { return contentAssessmentHash(input, cover); }
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const countKind = (kind: string) => (db.prepare('SELECT COUNT(*) AS n FROM catalog_inferences WHERE kind=?').get(kind) as { n: number }).n;
const totalInput = () => (db.prepare("SELECT SUM(json_extract(usage_json,'$.input_tokens')) AS tokens FROM catalog_inferences").get() as { tokens: number }).tokens;

beforeEach(() => { vi.stubEnv('JEV_MODEL', 'jev-test-requested'); database(); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

describe('cover-content inference runs', () => {
	it('reuses a normal cache hit without another paid call or another usage record', async () => {
		const { evaluate, fetch } = client();
		const first = await assessContent(db, input, cover, { currentInputHash, evaluate });
		const cached = await assessContent(db, input, cover, { currentInputHash, evaluate });

		expect(first).toMatchObject({ cached: false, promoted: true, usage: { input_tokens: 17, output_tokens: 3 } });
		expect(cached).toMatchObject({ assessment: first.assessment, cached: true, usage: { input_tokens: 0, output_tokens: 0 } });
		expect(evaluate).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledOnce();
		expect(evaluate.mock.calls[0][2]).toEqual({ model: 'jev-test-requested', onResponse: expect.any(Function) });
		expect(count('catalog_inferences')).toBe(2);
		expect(count('cover_content_inference_responses')).toBe(1);
		expect(count('cover_content_inference_heads')).toBe(1);
		expect(hasUnpromotedContentResponse(db, input.id, currentInputHash())).toBe(false);
		expect(JSON.parse(loadContentWireResponse(db, input.id, currentInputHash())!.usage_json)).toEqual(response().usage);
		expect(JSON.parse((db.prepare('SELECT usage_json FROM catalog_inferences WHERE id=?').get(first.inferenceId) as { usage_json: string }).usage_json))
			.toEqual({ input_tokens: 0, output_tokens: 0 });
	});

	it('makes a forced answer current for the same input while retaining both results, raw responses, and usage', async () => {
		const oldResponse = response('absent'), newResponse = response('present', 31);
		const { evaluate } = client([oldResponse, newResponse]);
		const first = await assessContent(db, input, cover, { currentInputHash, evaluate });
		const forced = await assessContent(db, input, cover, { force: true, currentInputHash, evaluate });

		expect(forced).toMatchObject({ cached: false, promoted: true, assessment: { inputHash: first.assessment.inputHash, sexualized: { verdict: 'present' } } });
		expect(forced.inferenceId).not.toBe(first.inferenceId);
		expect(loadContentAssessment(db, input.id, currentInputHash())).toEqual(forced.assessment);
		expect(db.prepare('SELECT inference_id FROM cover_content_inference_heads').get()).toEqual({ inference_id: forced.inferenceId });
		const runs = db.prepare(`SELECT i.id,i.result_json,i.usage_json,r.response_json FROM catalog_inferences i
			JOIN cover_content_inference_responses r ON r.inference_id=i.id`).all() as { id: string; result_json: string; usage_json: string; response_json: string }[];
		expect(runs).toHaveLength(2);
		for (const [result, raw] of [[first, oldResponse], [forced, newResponse]] as const) {
			const saved = runs.find(row => row.id === result.inferenceId)!;
			expect(JSON.parse(saved.result_json)).toEqual(result.assessment);
			expect(JSON.parse(saved.response_json)).toEqual(raw);
			expect(JSON.parse(saved.usage_json)).toEqual({ input_tokens: 0, output_tokens: 0 });
		}
		expect(countKind('cover-content-wire-response')).toBe(2);
		expect(totalInput()).toBe(48);
		expect((await assessContent(db, input, cover, { currentInputHash, evaluate })).assessment).toEqual(forced.assessment);
		expect(evaluate).toHaveBeenCalledTimes(2);
	});

	it('does not reuse a stale answer for changed evidence and preserves a separate head for each input', async () => {
		const { evaluate } = client();
		const first = await assessContent(db, input, cover, { currentInputHash, evaluate });
		const changed = { ...input, description: 'The corrected listing advertises an explicit romantic relationship.' };
		const changedHash = contentAssessmentHash(changed, cover);
		expect(loadContentAssessment(db, input.id, changedHash)).toBeNull();
		const next = await assessContent(db, changed, cover, { currentInputHash: () => changedHash, evaluate });
		expect(next.cached).toBe(false);
		expect(next.assessment.inputHash).not.toBe(first.assessment.inputHash);
		expect(loadContentAssessment(db, input.id, currentInputHash())).toEqual(first.assessment);
		expect(loadContentAssessment(db, input.id, changedHash)).toEqual(next.assessment);
		expect(count('cover_content_inference_heads')).toBe(2);
		expect(evaluate).toHaveBeenCalledTimes(2);
	});

	it('retains a paid response but does not promote it when source copy changes during the request', async () => {
		legacyBook();
		const latestHash = () => {
			const latest = db.prepare('SELECT description FROM books WHERE id=?').get(input.id) as { description: string } | undefined;
			return latest ? contentAssessmentHash({ ...input, description: latest.description }, cover) : null;
		};
		const first = await assessContent(db, input, cover, { currentInputHash: latestHash, evaluate: client().evaluate });
		const changedResponse = response('present', 31);
		const { evaluate } = client([changedResponse], { beforeResponse: () => {
			db.prepare('UPDATE books SET description=? WHERE id=?').run('A corrected description with different content evidence.', input.id);
		} });
		const stale = await assessContent(db, input, cover, { force: true, currentInputHash: latestHash, evaluate });
		expect(stale).toMatchObject({ cached: false, promoted: false, usage: changedResponse.usage });
		expect(count('catalog_inferences')).toBe(4);
		expect(count('cover_content_inference_responses')).toBe(2);
		expect(db.prepare('SELECT inference_id FROM cover_content_inference_heads').get()).toEqual({ inference_id: first.inferenceId });
		expect(loadContentAssessment(db, input.id, latestHash()!)).toBeNull();
		expect(loadContentAssessment(db, input.id, currentInputHash())).toEqual(first.assessment);
		expect(JSON.parse((db.prepare('SELECT response_json FROM cover_content_inference_responses WHERE inference_id=?').get(stale.inferenceId) as { response_json: string }).response_json)).toEqual(changedResponse);
		expect(hasUnpromotedContentResponse(db, input.id, currentInputHash())).toBe(true);
		// If the exact evidence returns, the same retained run can be promoted once.
		db.prepare('UPDATE books SET description=? WHERE id=?').run(input.description, input.id);
		const replay = await assessContent(db, input, cover, { currentInputHash: latestHash, evaluate });
		expect(replay).toMatchObject({ cached: true, promoted: true, inferenceId: stale.inferenceId, usage: { input_tokens: 0, output_tokens: 0 } });
		expect(count('catalog_inferences')).toBe(4);
		expect(evaluate).toHaveBeenCalledOnce();
	});

	it('keeps the request model and hash for audit when settings change while inference is in flight', async () => {
		const requestHash = currentInputHash();
		const { evaluate } = client([response()], { beforeResponse: () => {
			vi.stubEnv('JEV_MODEL', 'jev-different-requested-model');
		} });
		const result = await assessContent(db, input, cover, { currentInputHash, evaluate });
		expect(result).toMatchObject({ promoted: false, assessment: { inputHash: requestHash } });
		expect(count('cover_content_inference_heads')).toBe(0);
		const rows = db.prepare('SELECT input_hash,requested_model,actual_model FROM catalog_inferences').all();
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row).toEqual({ input_hash: requestHash, requested_model: 'jev-test-requested', actual_model: 'jev-test-actual' });
	});

	it('supports a publisher-only edition without an ASIN or a legacy books row', async () => {
		const sourceInput = { ...input, id: 'publisher-edition-one' };
		db.prepare('INSERT INTO catalog_series (id,title,author,updated_at) VALUES (?,?,?,?)').run('source-series', input.series, input.author, '2026-01-01');
		db.prepare('INSERT INTO catalog_works (id,series_id,number,title,author,source_url,updated_at) VALUES (?,?,?,?,?,?,?)')
			.run('source-work', 'source-series', 1, input.title, input.author, 'https://publisher.example/book', '2026-01-01');
		db.prepare('INSERT INTO catalog_editions (id,work_id,format,title,source_url,source_name,updated_at) VALUES (?,?,?,?,?,?,?)')
			.run(sourceInput.id, 'source-work', 'audiobook', input.title, 'https://publisher.example/audio', 'publisher', '2026-01-01');
		const result = await assessContent(db, sourceInput, cover, { currentInputHash, evaluate: client().evaluate });
		expect(result.promoted).toBe(true);
		expect(loadContentAssessment(db, sourceInput.id, currentInputHash())).toEqual(result.assessment);
		expect(count('books')).toBe(0);
		expect(count('book_content_assessments')).toBe(0);
		expect(db.pragma('foreign_key_check')).toEqual([]);
	});

	it('retains a paid receipt across promotion rollback, then promotes it on replay without repurchasing', async () => {
		const { evaluate, fetch } = client([response(), response('present', 31)]);
		const first = await assessContent(db, input, cover, { currentInputHash, evaluate });
		db.exec(`CREATE TRIGGER reject_head_update BEFORE UPDATE ON cover_content_inference_heads BEGIN SELECT RAISE(ABORT,'test promotion failure'); END`);
		await expect(assessContent(db, input, cover, { force: true, currentInputHash, evaluate })).rejects.toThrow('test promotion failure');
		expect(count('catalog_inferences')).toBe(3);
		expect(countKind('cover-content-wire-response')).toBe(2);
		expect(count('cover_content_inference_responses')).toBe(1);
		expect(db.prepare('SELECT inference_id FROM cover_content_inference_heads').get()).toEqual({ inference_id: first.inferenceId });
		expect(loadContentAssessment(db, input.id, currentInputHash())).toEqual(first.assessment);
		expect(hasUnpromotedContentResponse(db, input.id, currentInputHash())).toBe(true);
		db.exec('DROP TRIGGER reject_head_update');
		const replay = await assessContent(db, input, cover, { currentInputHash, evaluate });
		expect(replay).toMatchObject({ cached: true, promoted: true, assessment: { sexualized: { verdict: 'present' } }, usage: { input_tokens: 0, output_tokens: 0 } });
		expect(loadContentAssessment(db, input.id, currentInputHash())).toEqual(replay.assessment);
		expect(hasUnpromotedContentResponse(db, input.id, currentInputHash())).toBe(false);
		expect(count('catalog_inferences')).toBe(4);
		expect(totalInput()).toBe(48);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

describe('paid cover-content response durability', () => {
	it.each([
		['malformed JSON', ' private response is not JSON ', 'unknown', {}],
		['a refusal instead of answers', JSON.stringify({ model: 'jev-refusal', refusal: 'private refusal details', usage: { input_tokens: 23, output_tokens: 4 } }), 'jev-refusal', { input_tokens: 23, output_tokens: 4 }],
		['an invalid choice', JSON.stringify({ ...response(), answers: { ...response().answers, harem: { type: 'choice', choice: 'invented', confidence: 1, probabilities: { invented: 1 } } } }), 'jev-test-actual', response().usage],
		['invalid usage', JSON.stringify({ ...response(), usage: { input_tokens: 17, output_tokens: -1 } }), 'jev-test-actual', { input_tokens: 17, output_tokens: -1 }]
	])('retains %s before validation and revalidates unchanged inputs without another paid call', async (_label, raw, model, usage) => {
		const { evaluate, fetch } = client([raw as string]);
		for (const cached of [false, true]) {
			const error = await assessContent(db, input, cover, { currentInputHash, evaluate }).catch(error => error);
			expect(error).toBeInstanceOf(ContentCacheReviewError);
			expect(error).toMatchObject({ cached, inputHash: currentInputHash() });
			expect(error.message).not.toContain('private');
			expect(error.message).toContain('use --force only to buy a new attempt');
		}
		const receipt = loadContentWireResponse(db, input.id, currentInputHash())!;
		expect(JSON.parse(receipt.result_json)).toBe(raw);
		expect(receipt.actual_model).toBe(model);
		expect(JSON.parse(receipt.usage_json)).toEqual(usage);
		expect(receipt.requested_model).toBe('jev-test-requested');
		expect(count('catalog_inferences')).toBe(1);
		expect(count('cover_content_inference_heads')).toBe(0);
		expect(count('cover_content_inference_responses')).toBe(0);
		expect(hasUnpromotedContentResponse(db, input.id, currentInputHash())).toBe(true);
		expect(loadContentAssessment(db, input.id, currentInputHash())).toBeNull();
		expect(evaluate).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('commits exact HTTP text before callback interruption and replays that receipt after restart', async () => {
		const raw = `\n${JSON.stringify(response(), null, 2)}\n`;
		const { evaluate, fetch } = client([raw], { afterResponse: text => {
			expect(db.inTransaction).toBe(false);
			expect(JSON.parse(loadContentWireResponse(db, input.id, currentInputHash())!.result_json)).toBe(text);
			expect(countKind('cover-content')).toBe(0);
			throw new Error('private callback interruption details');
		} });
		const error = await assessContent(db, input, cover, { currentInputHash, evaluate }).catch(error => error);
		expect(error).toBeInstanceOf(ContentCacheReviewError);
		expect(error.message).not.toContain('private');
		expect(count('catalog_inferences')).toBe(1);
		const receipt = loadContentWireResponse(db, input.id, currentInputHash())!;
		const replay = await assessContent(db, input, cover, { currentInputHash, evaluate });
		expect(replay).toMatchObject({ cached: true, promoted: true, assessment: { evaluatedAt: receipt.evaluated_at }, usage: { input_tokens: 0, output_tokens: 0 } });
		expect(JSON.parse(receipt.result_json)).toBe(raw);
		expect(totalInput()).toBe(17);
		expect(count('catalog_inferences')).toBe(2);
		expect(fetch).toHaveBeenCalledOnce();
		expect(evaluate).toHaveBeenCalledOnce();
	});

	it('reviews the latest invalid forced response instead of silently using an older head, and preserves all attempts', async () => {
		const invalid = JSON.stringify({ model: 'jev-invalid-actual', answers: {}, usage: { input_tokens: 31, output_tokens: 5 } });
		const { evaluate, fetch } = client([response(), invalid, response('present', 47)]);
		const original = await assessContent(db, input, cover, { currentInputHash, evaluate });
		await expect(assessContent(db, input, cover, { force: true, currentInputHash, evaluate })).rejects.toBeInstanceOf(ContentCacheReviewError);
		const invalidReceipt = loadContentWireResponse(db, input.id, currentInputHash())!;
		expect(loadContentAssessment(db, input.id, currentInputHash())).toEqual(original.assessment);
		expect(hasUnpromotedContentResponse(db, input.id, currentInputHash())).toBe(true);
		await expect(assessContent(db, input, cover, { currentInputHash, evaluate })).rejects.toMatchObject({ cached: true, responseId: invalidReceipt.id });
		expect(fetch).toHaveBeenCalledTimes(2);
		const replacement = await assessContent(db, input, cover, { force: true, currentInputHash, evaluate });
		expect(replacement).toMatchObject({ cached: false, promoted: true, usage: { input_tokens: 47, output_tokens: 3 } });
		expect(loadContentAssessment(db, input.id, currentInputHash())).toEqual(replacement.assessment);
		expect(hasUnpromotedContentResponse(db, input.id, currentInputHash())).toBe(false);
		expect(countKind('cover-content-wire-response')).toBe(3);
		expect(countKind('cover-content')).toBe(2);
		expect(totalInput()).toBe(95);
		expect(JSON.parse((db.prepare('SELECT result_json FROM catalog_inferences WHERE id=?').get(invalidReceipt.id) as { result_json: string }).result_json)).toBe(invalid);
		expect((await assessContent(db, input, cover, { currentInputHash, evaluate })).assessment).toEqual(replacement.assessment);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it('keeps identical paid forced responses as separate attempts instead of deduplicating their usage', async () => {
		const { evaluate } = client();
		const first = await assessContent(db, input, cover, { currentInputHash, evaluate });
		const firstReceipt = loadContentWireResponse(db, input.id, currentInputHash())!;
		const second = await assessContent(db, input, cover, { force: true, currentInputHash, evaluate });
		const secondReceipt = loadContentWireResponse(db, input.id, currentInputHash())!;
		expect(secondReceipt.id).not.toBe(firstReceipt.id);
		expect(secondReceipt.result_json).toBe(firstReceipt.result_json);
		expect(second.inferenceId).not.toBe(first.inferenceId);
		expect(totalInput()).toBe(34);
		expect(countKind('cover-content-wire-response')).toBe(2);
		expect(countKind('cover-content')).toBe(2);
	});

	it.each(['description', 'image', 'model'] as const)('uses a separate receipt after the %s changes, even if the old response is invalid', async changedField => {
		const { evaluate, fetch } = client(['invalid saved response', response()]);
		const previousHash = currentInputHash();
		await expect(assessContent(db, input, cover, { currentInputHash, evaluate })).rejects.toBeInstanceOf(ContentCacheReviewError);
		const changedBook = changedField === 'description' ? { ...input, description: 'A different publisher description.' } : input;
		const changedCover = changedField === 'image' ? { ...cover, imageHash: 'replacement-image-bytes' } : cover;
		if (changedField === 'model') vi.stubEnv('JEV_MODEL', 'jev-another-requested-model');
		const nextHash = contentAssessmentHash(changedBook, changedCover);
		expect(nextHash).not.toBe(previousHash);
		const next = await assessContent(db, changedBook, changedCover, { currentInputHash: () => nextHash, evaluate });
		expect(next).toMatchObject({ cached: false, promoted: true, assessment: { inputHash: nextHash } });
		expect(loadContentWireResponse(db, input.id, previousHash)!.result_json).toBe(JSON.stringify('invalid saved response'));
		expect(loadContentWireResponse(db, input.id, nextHash)!.id).not.toBe(loadContentWireResponse(db, input.id, previousHash)!.id);
		expect(countKind('cover-content-wire-response')).toBe(2);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it.each([false, true])('does not promote an interrupted older response over a newer receipt (newer response invalid: %s)', async invalid => {
		const initial = await assessContent(db, input, cover, { currentInputHash, evaluate: client().evaluate });
		let expectedHead = initial.inferenceId;
		const newer = client([invalid ? JSON.stringify({ model: 'jev-newer', usage: { input_tokens: 29, output_tokens: 5 }, answers: {} }) : response('present', 29)]);
		const older = client([response('unknown', 21)], { afterResponse: async () => {
			if (invalid) await expect(assessContent(db, input, cover, { force: true, currentInputHash, evaluate: newer.evaluate })).rejects.toBeInstanceOf(ContentCacheReviewError);
			else expectedHead = (await assessContent(db, input, cover, { force: true, currentInputHash, evaluate: newer.evaluate })).inferenceId;
		} });
		const resumed = await assessContent(db, input, cover, { force: true, currentInputHash, evaluate: older.evaluate });
		expect(resumed.promoted).toBe(false);
		expect(db.prepare('SELECT inference_id FROM cover_content_inference_heads').get()).toEqual({ inference_id: expectedHead });
		expect(hasUnpromotedContentResponse(db, input.id, currentInputHash())).toBe(invalid);
		expect(countKind('cover-content-wire-response')).toBe(3);
		expect(countKind('cover-content')).toBe(invalid ? 2 : 3);
		expect(totalInput()).toBe(67);
		expect(older.fetch).toHaveBeenCalledOnce();
		expect(newer.fetch).toHaveBeenCalledOnce();
	});

	it('normalizes the submitted cover snapshot if the caller mutates its in-memory evidence during the request', async () => {
		const mutableCover = { ...cover, observations: [...cover.observations] };
		const submittedHash = contentAssessmentHash(input, mutableCover);
		const { evaluate } = client([response('present')], { beforeResponse: () => {
			mutableCover.confidence = 0.1;
			mutableCover.observations.push('A later, different cover observation.');
		} });
		const result = await assessContent(db, input, mutableCover, { currentInputHash: () => contentAssessmentHash(input, mutableCover), evaluate });
		expect(result).toMatchObject({ promoted: false, assessment: { inputHash: submittedHash, sexualized: { confidence: 0.9 } } });
		expect(result.assessment.sexualized.note).not.toContain('later, different');
		expect(countKind('cover-content-wire-response')).toBe(1);
	});

	it.each([false, true])('refuses a caller transaction before a paid call (force: %s)', async force => {
		if (force) await assessContent(db, input, cover, { currentInputHash, evaluate: client().evaluate });
		const { evaluate, fetch } = client();
		db.exec('BEGIN');
		try {
			await expect(assessContent(db, input, cover, { force, currentInputHash, evaluate })).rejects.toThrow('outside a caller transaction');
		} finally { db.exec('ROLLBACK'); }
		expect(evaluate).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(countKind('cover-content-wire-response')).toBe(force ? 1 : 0);
	});

	it('parks for review if a caller opens a transaction while HTTP is in flight, without claiming the response was saved', async () => {
		const { evaluate, fetch } = client([response()], { beforeResponse: () => { db.exec('BEGIN'); } });
		try {
			const error = await assessContent(db, input, cover, { currentInputHash, evaluate }).catch(error => error);
			expect(error).toBeInstanceOf(ReviewError);
			expect(error).toBeInstanceOf(PaidResponseStorageError);
			expect(error.message).toContain('response could not be saved');
			expect(db.inTransaction).toBe(true); // The cache does not commit or roll back caller-owned work.
			expect(count('catalog_inferences')).toBe(0);
		} finally { if (db.inTransaction) db.exec('ROLLBACK'); }
		expect(fetch).toHaveBeenCalledOnce();
		expect(evaluate).toHaveBeenCalledOnce();
		expect(loadContentWireResponse(db, input.id, currentInputHash())).toBeNull();
	});

	it('classifies a rejected raw receipt INSERT as unsaved review, never as a retryable SQLite failure', async () => {
		const original = await assessContent(db, input, cover, { currentInputHash, evaluate: client().evaluate });
		db.exec(`CREATE TRIGGER reject_raw_receipt BEFORE INSERT ON catalog_inferences
			WHEN NEW.kind='cover-content-wire-response' BEGIN SELECT RAISE(ABORT,'private database failure'); END`);
		const { evaluate, fetch } = client([response('present', 31)]);
		const error = await assessContent(db, input, cover, { force: true, currentInputHash, evaluate }).catch(error => error);
		expect(error).toBeInstanceOf(ReviewError);
		expect(error).toBeInstanceOf(PaidResponseStorageError);
		expect(error.message).toContain('response could not be saved');
		expect(error.message).not.toContain('private database failure');
		expect(count('catalog_inferences')).toBe(2);
		expect(totalInput()).toBe(17); // The failed receipt cannot claim to have retained the new charge.
		expect(loadContentAssessment(db, input.id, currentInputHash())).toEqual(original.assessment);
		expect(fetch).toHaveBeenCalledOnce();
		expect(evaluate).toHaveBeenCalledOnce();
	});

	it('does not silently project a client result that skipped the durable response callback', async () => {
		const evaluate = vi.fn<typeof evaluateJev>().mockResolvedValue(response());
		await expect(assessContent(db, input, cover, { currentInputHash, evaluate })).rejects.toThrow('did not retain its response');
		expect(count('catalog_inferences')).toBe(0);
		expect(count('cover_content_inference_heads')).toBe(0);
	});
});

describe('legacy cover-content cache compatibility', () => {
	it('rejects an unmigrated cache miss before making a paid request', async () => {
		db.close(); database(['001_initial.sql', '004_cover_assessments.sql', '006_catalog_pipeline.sql']);
		const { evaluate } = client();
		await expect(assessContent(db, input, cover, { currentInputHash, evaluate })).rejects.toThrow('009_cover_inference_heads.sql');
		expect(evaluate).not.toHaveBeenCalled();
		expect(count('catalog_inferences')).toBe(0);
	});

	it('reads deterministic inference rows before and after migration without writing on a cache hit', async () => {
		db.close(); database(['001_initial.sql', '004_cover_assessments.sql', '006_catalog_pipeline.sql']);
		const assessment = toContentAssessment(input, cover, response());
		const inferenceId = hash(['edition', input.id, 'cover-content', assessment.inputHash]);
		db.prepare('INSERT INTO catalog_inferences VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(inferenceId, 'edition', input.id, 'cover-content', assessment.inputHash,
			'jev-test-requested', assessment.model, 'cover-content-v1', JSON.stringify(assessment), JSON.stringify(response().usage), assessment.evaluatedAt);
		expect(loadContentAssessment(db, input.id, assessment.inputHash)).toEqual(assessment);
		const evaluate = vi.fn<typeof evaluateJev>();
		expect((await assessContent(db, input, cover, { currentInputHash, evaluate })).assessment).toEqual(assessment);
		expect(hasUnpromotedContentResponse(db, input.id, assessment.inputHash)).toBe(false);
		migrate('009_cover_inference_heads.sql');
		expect((await assessContent(db, input, cover, { currentInputHash, evaluate })).assessment).toEqual(assessment);
		expect(evaluate).not.toHaveBeenCalled();
		expect(count('catalog_inferences')).toBe(1);
		expect(count('cover_content_inference_heads')).toBe(0);
	});

	it('reads the per-book cache on an older database without catalog tables and rejects a different input', async () => {
		db.close(); database(['001_initial.sql', '004_cover_assessments.sql']); legacyBook();
		const raw = response(), assessment = toContentAssessment(input, cover, raw);
		db.prepare('INSERT INTO book_content_assessments VALUES (?,?,?,?,?,?,?)').run(input.id, assessment.inputHash, assessment.model, 'cover-content-v1', JSON.stringify(assessment), JSON.stringify(raw), assessment.evaluatedAt);
		expect(loadContentAssessment(db, input.id, assessment.inputHash)).toEqual(assessment);
		expect(loadContentAssessment(db, input.id, contentAssessmentHash({ ...input, description: 'Changed source.' }, cover))).toBeNull();
		const evaluate = vi.fn<typeof evaluateJev>();
		expect(await assessContent(db, input, cover, { currentInputHash, evaluate })).toMatchObject({ cached: true, assessment, usage: { input_tokens: 0, output_tokens: 0 } });
		expect(evaluate).not.toHaveBeenCalled();
		expect(hasUnpromotedContentResponse(db, input.id, assessment.inputHash)).toBe(false);
	});

	it('reuses a migration-009 valid head without inventing a wire receipt or charging its usage again', async () => {
		const raw = response(), assessment = toContentAssessment(input, cover, raw);
		const legacy = saveContentAssessment(db, { editionId: input.id, inputHash: assessment.inputHash, requestedModel: 'jev-test-requested',
			assessment, response: raw, currentInputHash });
		const { evaluate, fetch } = client();
		expect(await assessContent(db, input, cover, { currentInputHash, evaluate })).toMatchObject({ cached: true, assessment, usage: { input_tokens: 0, output_tokens: 0 } });
		expect(loadContentWireResponse(db, input.id, assessment.inputHash)).toBeNull();
		expect(hasUnpromotedContentResponse(db, input.id, assessment.inputHash)).toBe(false);
		expect(count('catalog_inferences')).toBe(1);
		expect(totalInput()).toBe(17);
		expect(fetch).not.toHaveBeenCalled();
		const forced = await assessContent(db, input, cover, { force: true, currentInputHash, evaluate });
		expect(forced.inferenceId).not.toBe(legacy.inferenceId);
		expect(count('catalog_inferences')).toBe(3);
		expect(totalInput()).toBe(34);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('parks a damaged legacy paid result for review instead of silently repurchasing it', async () => {
		const inputHash = currentInputHash(), id = hash(['edition', input.id, 'cover-content', inputHash]);
		db.prepare('INSERT INTO catalog_inferences VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, 'edition', input.id, 'cover-content', inputHash,
			'jev-test-requested', 'jev-test-actual', 'cover-content-v1', '{}', JSON.stringify(response().usage), '2026-01-01T00:00:00Z');
		const { evaluate, fetch } = client();
		await expect(assessContent(db, input, cover, { currentInputHash, evaluate })).rejects.toMatchObject({ cached: true, responseId: null });
		expect(fetch).not.toHaveBeenCalled();
		const forced = await assessContent(db, input, cover, { force: true, currentInputHash, evaluate });
		expect(forced.promoted).toBe(true);
		expect(count('catalog_inferences')).toBe(3);
		expect((db.prepare('SELECT result_json FROM catalog_inferences WHERE id=?').get(id) as { result_json: string }).result_json).toBe('{}');
	});

	it('recovers a newer legacy forced answer, then lets an explicit head win without rewriting either old record', async () => {
		legacyBook();
		const archived = { ...toContentAssessment(input, cover, response('absent')), evaluatedAt: '2024-01-01T00:00:00Z' };
		const oldId = hash(['edition', input.id, 'cover-content', archived.inputHash]);
		db.prepare('INSERT INTO catalog_inferences VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(oldId, 'edition', input.id, 'cover-content', archived.inputHash,
			'jev-test-requested', archived.model, 'cover-content-v1', JSON.stringify(archived), JSON.stringify(response().usage), archived.evaluatedAt);
		const raw = response('present'), previousForced = { ...toContentAssessment(input, cover, raw), evaluatedAt: '2025-01-01T00:00:00Z' };
		db.prepare('INSERT INTO book_content_assessments VALUES (?,?,?,?,?,?,?)').run(input.id, previousForced.inputHash, previousForced.model, 'cover-content-v1', JSON.stringify(previousForced), JSON.stringify(raw), previousForced.evaluatedAt);
		const untouched = db.prepare('SELECT * FROM book_content_assessments').get();
		expect(loadContentAssessment(db, input.id, currentInputHash())).toEqual(previousForced);
		const result = await assessContent(db, input, cover, { force: true, currentInputHash, evaluate: client([response('unknown')]).evaluate });
		expect(loadContentAssessment(db, input.id, currentInputHash())).toEqual(result.assessment);
		expect(db.prepare('SELECT * FROM book_content_assessments').get()).toEqual(untouched);
		expect(JSON.parse((db.prepare('SELECT result_json FROM catalog_inferences WHERE id=?').get(oldId) as { result_json: string }).result_json)).toEqual(archived);
	});
});
