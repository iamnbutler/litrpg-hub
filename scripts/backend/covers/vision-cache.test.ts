import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoverImage } from './assets.js';
import { coverCacheKey, observeCover, parseVisionResponse, type VisionOptions } from './vision.js';
import {
	assessCover, hasUnpromotedVisionAttempt, loadCoverImageSource, loadVisionAttempt,
	recordCoverImage, saveVisionResponse, VisionCacheReviewError
} from './vision-cache.js';

let db: Database.Database;
const requestedModel = 'vision-requested';
const url = 'https://m.media-amazon.com/images/I/test.jpg';
const firstCheck = '2026-09-18T00:00:00.000Z', nextCheck = '2026-09-19T00:00:00.000Z';
const source = { url, checkedAt: firstCheck };
function image(text = 'test-cover-bytes'): CoverImage {
	const data = Buffer.from(text);
	return { data, mime: 'image/jpeg', hash: createHash('sha256').update(data).digest('hex') };
}
const cover = image();
function migrate(name: string) { db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')); }
function database(history = true) {
	db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	migrate('001_initial.sql'); migrate('004_cover_assessments.sql');
	if (history) migrate('012_cover_vision_history.sql');
}
function payload(level = 'none', tokens = 17) {
	return {
		id: `response-${tokens}`, status: 'completed', model: 'vision-actual',
		output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
			level, confidence: 0.91, observations: ['An armored adventurer stands beside a ruined tower.']
		}) }] }],
		usage: { input_tokens: tokens, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } }
	};
}
function wire(level = 'none', tokens = 17) { return ` ${JSON.stringify(payload(level, tokens))}\n`; }
function client(...responses: string[]) {
	let index = 0;
	const request = vi.fn(async () => new Response(responses[index++] ?? responses.at(-1)));
	const observe = vi.fn((input: { data: Buffer; mime: string }, options: VisionOptions = {}) => observeCover(input, {
		...options, apiKey: 'private-test-key', fetch: request, sleep: async () => {}
	}));
	return { observe, request };
}
function legacy() {
	const result = parseVisionResponse(wire());
	db.prepare('INSERT INTO cover_observations VALUES (?,?,?,?,?,?,?,?)').run(
		coverCacheKey(cover.hash), cover.hash, requestedModel, result.model, 'cover-v1',
		JSON.stringify(result.observation), JSON.stringify(payload().usage), firstCheck);
	db.prepare('INSERT INTO cover_sources VALUES (?,?,?)').run(url, coverCacheKey(cover.hash), firstCheck);
}
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const publicCover = () => db.prepare(`SELECT o.* FROM cover_sources s JOIN cover_observations o
	ON o.cache_key=s.cache_key WHERE s.cover_url=?`).get(url) as { cache_key: string; image_hash: string; observation_json: string } | undefined;

beforeEach(() => { vi.stubEnv('COVER_MODEL', requestedModel); database(); });
afterEach(() => {
	if (db.inTransaction) db.exec('ROLLBACK');
	expect(db.pragma('foreign_key_check')).toEqual([]);
	db.close(); vi.unstubAllEnvs();
});

describe('durable cover vision history', () => {
	it('reuses the exact input without another request, attempt, or usage charge', async () => {
		const api = client(wire());
		const first = await assessCover(db, cover, { ...api, source });
		const cached = await assessCover(db, cover, { ...api, source });
		expect(first).toMatchObject({ cached: false, promoted: true, current: true, usage: { input_tokens: 17, output_tokens: 4 } });
		expect(cached).toMatchObject({ cached: true, promoted: false, current: true, attemptId: first.attemptId,
			observation: first.observation, evaluatedAt: first.evaluatedAt, usage: { input_tokens: 0, output_tokens: 0 } });
		expect(api.request).toHaveBeenCalledOnce();
		expect(count('cover_vision_attempts')).toBe(1);
		expect(count('cover_vision_heads')).toBe(1);
		expect(count('cover_observations')).toBe(1);
		expect(hasUnpromotedVisionAttempt(db, first.cacheKey)).toBe(false);
		const saved = loadVisionAttempt(db, first.cacheKey)!;
		expect(saved.response_text).toBe(wire());
		expect(JSON.parse(saved.usage_json!)).toEqual(payload().usage);
		expect(saved.legacy_observation_json).toBeNull();
		expect(saved.response_text).not.toContain('private-test-key');
		expect(saved.response_text).not.toContain(cover.data.toString('base64'));
	});

	it('promotes a forced result atomically while retaining old observations, full responses, and usage', async () => {
		const api = client(wire(), wire('sexualized', 31));
		const first = await assessCover(db, cover, { ...api, source });
		const forced = await assessCover(db, cover, { ...api, source, force: true });
		expect(forced).toMatchObject({ cached: false, promoted: true, current: true, observation: { level: 'sexualized' } });
		expect(forced.attemptId).not.toBe(first.attemptId);
		expect(JSON.parse(publicCover()!.observation_json)).toEqual(forced.observation);
		expect(db.prepare('SELECT attempt_id FROM cover_vision_heads').get()).toEqual({ attempt_id: forced.attemptId });
		const attempts = db.prepare('SELECT id,response_text,usage_json FROM cover_vision_attempts ORDER BY sequence').all();
		expect(attempts).toEqual([
			{ id: first.attemptId, response_text: wire(), usage_json: JSON.stringify(payload().usage) },
			{ id: forced.attemptId, response_text: wire('sexualized', 31), usage_json: JSON.stringify(payload('sexualized', 31).usage) }
		]);
		expect(db.prepare("SELECT SUM(json_extract(usage_json,'$.input_tokens')) AS tokens FROM cover_vision_attempts").get()).toEqual({ tokens: 48 });
		expect((await assessCover(db, cover, { ...api, source })).observation).toEqual(forced.observation);
		expect(api.request).toHaveBeenCalledTimes(2);
		expect(count('cover_observations')).toBe(1);
		expect(() => db.prepare('UPDATE cover_vision_attempts SET response_text=? WHERE id=?').run('replaced', first.attemptId)).toThrow(/immutable/);
		expect(() => db.prepare('DELETE FROM cover_vision_attempts WHERE id=?').run(first.attemptId)).toThrow(/immutable/);
	});

	it('resumes from a committed response after interruption before validation without another request', async () => {
		const request = vi.fn(async () => new Response(wire()));
		const interrupted = (input: { data: Buffer; mime: string }, options: VisionOptions = {}) => observeCover(input, {
			...options, apiKey: 'test', fetch: request, onResponse: async raw => {
				await options.onResponse!(raw);
				throw new Error('simulated interruption after response commit');
			}
		});
		await expect(assessCover(db, cover, { source, observe: interrupted })).rejects.toThrow('simulated interruption');
		expect(request).toHaveBeenCalledOnce();
		expect(loadVisionAttempt(db, coverCacheKey(cover.hash))?.response_text).toBe(wire());
		expect(count('cover_vision_heads')).toBe(0);
		expect(publicCover()).toBeUndefined();
		expect(hasUnpromotedVisionAttempt(db, coverCacheKey(cover.hash))).toBe(true);
		const api = client(wire('sexualized'));
		const recovered = await assessCover(db, cover, { ...api, source });
		expect(recovered).toMatchObject({ cached: true, promoted: true, current: true, observation: { level: 'none' }, usage: { input_tokens: 0, output_tokens: 0 } });
		expect(api.observe).not.toHaveBeenCalled();
		expect(count('cover_vision_attempts')).toBe(1);
		expect(JSON.parse(publicCover()!.observation_json).level).toBe('none');
	});

	it('keeps a paid response after a failed promotion and retries only the transaction', async () => {
		const api = client(wire(), wire('sexualized', 31));
		const first = await assessCover(db, cover, { ...api, source });
		db.exec("CREATE TRIGGER reject_head BEFORE UPDATE ON cover_vision_heads BEGIN SELECT RAISE(ABORT,'test promotion failure'); END");
		await expect(assessCover(db, cover, { ...api, source, force: true })).rejects.toThrow('test promotion failure');
		expect(count('cover_vision_attempts')).toBe(2);
		expect(JSON.parse(publicCover()!.observation_json)).toEqual(first.observation);
		expect(db.prepare('SELECT attempt_id FROM cover_vision_heads').get()).toEqual({ attempt_id: first.attemptId });
		db.exec('DROP TRIGGER reject_head');
		const replay = await assessCover(db, cover, { ...api, source });
		expect(replay).toMatchObject({ cached: true, promoted: true, observation: { level: 'sexualized' }, usage: { input_tokens: 0, output_tokens: 0 } });
		expect(api.request).toHaveBeenCalledTimes(2);
		expect(count('cover_vision_attempts')).toBe(2);
	});

	it('uses only the newest retained response when an older promotion was interrupted', async () => {
		const old = saveVisionResponse(db, { imageHash: cover.hash, requestedModel, responseText: wire() });
		const latest = saveVisionResponse(db, { imageHash: cover.hash, requestedModel, responseText: wire('sexualized', 31) });
		const api = client(wire());
		const result = await assessCover(db, cover, { ...api, source });
		expect(result.attemptId).toBe(latest.id);
		expect(result.attemptId).not.toBe(old.id);
		expect(result.observation.level).toBe('sexualized');
		expect(api.observe).not.toHaveBeenCalled();
		expect(count('cover_vision_attempts')).toBe(2);
	});
});

describe('invalid responses remain cached for review', () => {
	const missingUsage = { ...payload(), usage: undefined };
	const refusal = { ...payload(), output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private provider refusal' }] }] };
	const invalidObservation = { ...payload(), output: [{ type: 'message', content: [{ type: 'output_text', text: '{"level":"none","confidence":9,"observations":[]}' }] }] };
	for (const [name, raw, reportedUsage] of [
		['malformed JSON', 'private malformed provider response', null],
		['invalid observation', JSON.stringify(invalidObservation), JSON.stringify(payload().usage)],
		['refusal', JSON.stringify(refusal), JSON.stringify(payload().usage)],
		['incomplete response', JSON.stringify({ ...payload(), status: 'incomplete' }), JSON.stringify(payload().usage)],
		['missing usage', JSON.stringify(missingUsage), null],
		['invalid usage', JSON.stringify({ ...payload(), usage: { input_tokens: -2, output_tokens: 4 } }), '{"input_tokens":-2,"output_tokens":4}']
	] as const) {
		it(`retains ${name} before validation and never silently buys its replacement`, async () => {
			const api = client(raw, wire());
			const first = await assessCover(db, cover, { ...api, source }).catch(error => error);
			expect(first).toBeInstanceOf(VisionCacheReviewError);
			expect(first).toMatchObject({ cached: false });
			const attempt = loadVisionAttempt(db, coverCacheKey(cover.hash))!;
			expect(attempt).toMatchObject({ response_text: raw, usage_json: reportedUsage });
			expect(first.message).not.toContain('private');
			expect(first.message).toContain('--force');
			const again = await assessCover(db, cover, { ...api, source }).catch(error => error);
			expect(again).toBeInstanceOf(VisionCacheReviewError);
			expect(again).toMatchObject({ cached: true, attemptId: attempt.id });
			expect(api.request).toHaveBeenCalledOnce();
			expect(count('cover_vision_attempts')).toBe(1);
			expect(count('cover_observations')).toBe(0);
			expect(count('cover_vision_heads')).toBe(0);
			expect(publicCover()).toBeUndefined();
			expect(loadCoverImageSource(db, url)?.image_hash).toBe(cover.hash);
			expect(hasUnpromotedVisionAttempt(db, coverCacheKey(cover.hash))).toBe(true);
		});
	}

	it('keeps the last valid same-image head after a forced failure and requires force to buy a replacement', async () => {
		const invalid = JSON.stringify({ ...payload('none', 23), status: 'incomplete' });
		const api = client(wire(), invalid, wire('sexualized', 31));
		const first = await assessCover(db, cover, { ...api, source });
		await expect(assessCover(db, cover, { ...api, source, force: true })).rejects.toBeInstanceOf(VisionCacheReviewError);
		expect(JSON.parse(publicCover()!.observation_json)).toEqual(first.observation);
		expect(db.prepare('SELECT attempt_id FROM cover_vision_heads').get()).toEqual({ attempt_id: first.attemptId });
		await expect(assessCover(db, cover, { ...api, source })).rejects.toMatchObject({ cached: true });
		expect(api.request).toHaveBeenCalledTimes(2);
		const recovered = await assessCover(db, cover, { ...api, source, force: true });
		expect(recovered.observation.level).toBe('sexualized');
		expect(count('cover_vision_attempts')).toBe(3);
		expect(db.prepare("SELECT SUM(json_extract(usage_json,'$.input_tokens')) AS tokens FROM cover_vision_attempts").get()).toEqual({ tokens: 71 });
		expect(hasUnpromotedVisionAttempt(db, recovered.cacheKey)).toBe(false);
	});
});

describe('cover image and model identity', () => {
	it('removes an old URL verdict before requesting an assessment of changed bytes, even if the new response is invalid', async () => {
		const changed = image('replacement bytes');
		await assessCover(db, cover, { ...client(wire('sexualized')), source });
		const otherUrl = 'https://m.media-amazon.com/images/I/another.jpg';
		await assessCover(db, cover, { ...client(wire()), source: { url: otherUrl, checkedAt: firstCheck } });
		const beforeRequest = vi.fn(async (input: { data: Buffer; mime: string }, options: VisionOptions = {}) => {
			expect(publicCover()).toBeUndefined();
			expect(loadCoverImageSource(db, url)?.image_hash).toBe(changed.hash);
			return client(JSON.stringify({ ...payload(), status: 'incomplete' })).observe(input, options);
		});
		await expect(assessCover(db, changed, { observe: beforeRequest, source: { url, checkedAt: nextCheck } })).rejects.toBeInstanceOf(VisionCacheReviewError);
		expect(publicCover()).toBeUndefined();
		expect(count('cover_observations')).toBe(1); // Historical assessment remains available for its original bytes.
		expect(count('cover_vision_attempts')).toBe(2);
		expect(db.prepare('SELECT cache_key FROM cover_sources WHERE cover_url=?').get(otherUrl)).toEqual({ cache_key: coverCacheKey(cover.hash) });
		const api = client(wire());
		await expect(assessCover(db, changed, { ...api, source: { url, checkedAt: nextCheck } })).rejects.toMatchObject({ cached: true });
		expect(api.observe).not.toHaveBeenCalled();
		expect(publicCover()).toBeUndefined();
	});

	it('does not reuse a different image or model, and keeps a separate head for each exact cache key', async () => {
		const api = client(wire(), wire('sexualized', 19), wire('suggestive', 23));
		const first = await assessCover(db, cover, { ...api, source });
		const changed = image('replacement bytes');
		const second = await assessCover(db, changed, { ...api, source: { url, checkedAt: nextCheck } });
		const third = await assessCover(db, changed, { ...api, model: 'another-model', source: { url, checkedAt: nextCheck } });
		expect(new Set([first.cacheKey, second.cacheKey, third.cacheKey]).size).toBe(3);
		expect(count('cover_vision_attempts')).toBe(3);
		expect(count('cover_vision_heads')).toBe(3);
		expect(api.request).toHaveBeenCalledTimes(3);
		expect(publicCover()?.cache_key).toBe(third.cacheKey);
		expect((await assessCover(db, cover, { ...api })).attemptId).toBe(first.attemptId);
		expect(api.request).toHaveBeenCalledTimes(3);
	});

	it('retains an in-flight answer but never reattaches it after another image is observed at the URL', async () => {
		const changed = image('replacement bytes');
		const request = vi.fn(async () => {
			recordCoverImage(db, { cover_url: url, image_hash: changed.hash, checked_at: nextCheck });
			return new Response(wire('sexualized'));
		});
		const observe = (input: { data: Buffer; mime: string }, options: VisionOptions = {}) => observeCover(input, { ...options, apiKey: 'test', fetch: request });
		const result = await assessCover(db, cover, { observe, source });
		expect(result).toMatchObject({ cached: false, promoted: true, current: false });
		expect(count('cover_vision_attempts')).toBe(1);
		expect(publicCover()).toBeUndefined();
		expect(loadCoverImageSource(db, url)?.image_hash).toBe(changed.hash);
		const api = client(wire());
		await expect(assessCover(db, cover, { ...api, source })).rejects.toThrow(/newer image bytes/);
		expect(api.observe).not.toHaveBeenCalled();
	});

	it('pins the requested model for history and does not relink an obsolete model when settings change in flight', async () => {
		const request = vi.fn(async () => {
			vi.stubEnv('COVER_MODEL', 'changed-model');
			return new Response(wire());
		});
		const observe = (input: { data: Buffer; mime: string }, options: VisionOptions = {}) => observeCover(input, { ...options, apiKey: 'test', fetch: request });
		const result = await assessCover(db, cover, { observe, source });
		expect(result.current).toBe(false);
		expect(loadVisionAttempt(db, coverCacheKey(cover.hash, requestedModel))).toMatchObject({ requested_model: requestedModel, model: 'vision-actual' });
		expect(loadVisionAttempt(db, coverCacheKey(cover.hash))).toBeNull();
		expect(publicCover()).toBeUndefined();
	});

	it('rejects a wrong byte hash before making a request or changing URL evidence', async () => {
		const api = client(wire());
		await expect(assessCover(db, { ...cover, data: Buffer.from('different bytes') }, { ...api, source })).rejects.toThrow(/cache hash/);
		expect(api.observe).not.toHaveBeenCalled();
		expect(count('cover_image_sources')).toBe(0);
	});

	it('does not reuse an older rubric even for the same image and model', async () => {
		legacy();
		db.prepare('DELETE FROM cover_sources').run();
		db.prepare('UPDATE cover_observations SET cache_key=?,rubric_version=?').run('older-rubric-key', 'cover-v0');
		const api = client(wire('sexualized'));
		const result = await assessCover(db, cover, api);
		expect(result).toMatchObject({ cached: false, observation: { level: 'sexualized' } });
		expect(api.observe).toHaveBeenCalledOnce();
		expect(count('cover_observations')).toBe(2);
		expect(db.prepare('SELECT rubric_version FROM cover_observations WHERE cache_key=?').get('older-rubric-key')).toEqual({ rubric_version: 'cover-v0' });
	});

	it('treats inconsistent legacy identity as review instead of reusing it or buying silently', async () => {
		legacy();
		db.prepare('UPDATE cover_observations SET image_hash=?').run(image('other bytes').hash);
		const api = client(wire());
		await expect(assessCover(db, cover, api)).rejects.toThrow(/image, model, or rubric/);
		expect(api.observe).not.toHaveBeenCalled();
	});
});

describe('legacy compatibility and durable write prerequisites', () => {
	it('reads a pre-migration cache without writes and refuses an unmigrated paid miss or force', async () => {
		db.close(); database(false); legacy();
		const original = db.prepare('SELECT * FROM cover_observations').get();
		const api = client(wire('sexualized'));
		const cached = await assessCover(db, cover, api);
		expect(cached).toMatchObject({ cached: true, promoted: false, current: true, attemptId: null, observation: { level: 'none' } });
		expect(loadCoverImageSource(db, url)).toEqual({ cover_url: url, image_hash: cover.hash, checked_at: firstCheck });
		expect(db.prepare('SELECT * FROM cover_observations').get()).toEqual(original);
		await expect(assessCover(db, cover, { ...api, force: true })).rejects.toThrow('012_cover_vision_history.sql');
		await expect(assessCover(db, image('uncached'), api)).rejects.toThrow('012_cover_vision_history.sql');
		expect(api.observe).not.toHaveBeenCalled();
	});

	it('backfills an honest legacy observation/usage record and keeps it when the first forced response replaces the head', async () => {
		db.close(); database(false); legacy();
		migrate('012_cover_vision_history.sql');
		const archived = loadVisionAttempt(db, coverCacheKey(cover.hash))!;
		expect(archived).toMatchObject({ id: `legacy:${coverCacheKey(cover.hash)}`, response_text: null, evaluated_at: firstCheck,
			legacy_observation_json: JSON.stringify(parseVisionResponse(wire()).observation), usage_json: JSON.stringify(payload().usage) });
		expect(loadCoverImageSource(db, url)?.image_hash).toBe(cover.hash);
		const result = await assessCover(db, cover, { ...client(wire('sexualized', 31)), source, force: true });
		expect(result.observation.level).toBe('sexualized');
		expect(count('cover_vision_attempts')).toBe(2);
		expect(db.prepare('SELECT * FROM cover_vision_attempts WHERE id=?').get(archived.id)).toEqual(archived);
	});

	it('archives a legacy row written after migration before replacing its paid history', async () => {
		legacy();
		await assessCover(db, cover, { ...client(wire('sexualized')), source, force: true });
		expect(count('cover_vision_attempts')).toBe(2);
		expect(db.prepare('SELECT legacy_observation_json,response_text FROM cover_vision_attempts WHERE id=?').get(`legacy:${coverCacheKey(cover.hash)}`))
			.toEqual({ legacy_observation_json: JSON.stringify(parseVisionResponse(wire()).observation), response_text: null });
	});

	it('rejects a caller-owned transaction before purchasing a response that could be rolled back with validation', async () => {
		const api = client(wire());
		db.exec('BEGIN');
		await expect(assessCover(db, cover, api)).rejects.toThrow(/caller transaction/);
		expect(api.observe).not.toHaveBeenCalled();
		expect(count('cover_vision_attempts')).toBe(0);
		db.exec('ROLLBACK');
	});
});
