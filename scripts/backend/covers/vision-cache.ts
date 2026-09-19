import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CoverImage } from './assets.js';
import {
	COVER_RUBRIC_VERSION, coverCacheKey, coverModel, observeCover, parseVisionResponse,
	validateObservation, validateVisionUsage, VisionResponseError, type VisionResult
} from './vision.js';

const hasTable = (db: Database.Database, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const hasHistory = (db: Database.Database) => ['cover_vision_attempts', 'cover_vision_heads', 'cover_image_sources'].every(name => hasTable(db, name));

function requireHistory(db: Database.Database) {
	if (!hasHistory(db)) throw new Error('Apply migration 012_cover_vision_history.sql before requesting a cover vision response.');
}
function requireDurableWrite(db: Database.Database) {
	requireHistory(db);
	// A caller-owned transaction could roll the paid response back on validation
	// failure. Refuse before requesting anything that cannot be committed alone.
	if (db.inTransaction) throw new Error('Cover vision responses must be saved outside a caller transaction.');
}

export interface CoverImageSource { cover_url: string; image_hash: string; checked_at: string }
export interface VisionAttempt {
	sequence: number; id: string | null; cache_key: string; image_hash: string;
	requested_model: string; rubric_version: string; model: string | null;
	response_text: string | null; legacy_observation_json: string | null;
	usage_json: string | null; evaluated_at: string;
}

/** Read-only fallback keeps old snapshots and --dry-run usable before migration. */
export function loadCoverImageSource(db: Database.Database, coverUrl: string): CoverImageSource | null {
	if (hasTable(db, 'cover_image_sources')) {
		const current = db.prepare('SELECT * FROM cover_image_sources WHERE cover_url=?').get(coverUrl) as CoverImageSource | undefined;
		if (current) return current;
	}
	return db.prepare(`SELECT s.cover_url,o.image_hash,s.checked_at FROM cover_sources s
		JOIN cover_observations o ON o.cache_key=s.cache_key WHERE s.cover_url=?`).get(coverUrl) as CoverImageSource | undefined ?? null;
}

/** Remember observed bytes before any paid call, invalidating only other bytes. */
export function recordCoverImage(db: Database.Database, source: CoverImageSource): void {
	requireDurableWrite(db);
	if (!Number.isFinite(Date.parse(source.checked_at))) throw new Error('Cover image check time is invalid.');
	const checkedAt = new Date(source.checked_at).toISOString();
	db.transaction(() => {
		db.prepare(`INSERT INTO cover_image_sources (cover_url,image_hash,checked_at) VALUES (?,?,?)
			ON CONFLICT(cover_url) DO UPDATE SET image_hash=excluded.image_hash,checked_at=excluded.checked_at
			WHERE julianday(cover_image_sources.checked_at) IS NULL
				OR julianday(excluded.checked_at) >= julianday(cover_image_sources.checked_at)`).run(source.cover_url, source.image_hash, checkedAt);
		// A failed assessment of new bytes must not leave the old image's verdict
		// attached to this URL. Same-image force failures keep the valid old head.
		db.prepare(`DELETE FROM cover_sources WHERE cover_url=? AND cache_key IN (
			SELECT o.cache_key FROM cover_observations o JOIN cover_image_sources s ON s.cover_url=?
			WHERE o.image_hash<>s.image_hash)`).run(source.cover_url, source.cover_url);
	}).immediate();
}

export function loadVisionAttempt(db: Database.Database, cacheKey: string): VisionAttempt | null {
	if (hasTable(db, 'cover_vision_attempts')) {
		const latest = db.prepare('SELECT * FROM cover_vision_attempts WHERE cache_key=? ORDER BY sequence DESC LIMIT 1').get(cacheKey) as VisionAttempt | undefined;
		if (latest) return latest;
	}
	return db.prepare(`SELECT 0 AS sequence,NULL AS id,cache_key,image_hash,requested_model,rubric_version,model,
		NULL AS response_text,observation_json AS legacy_observation_json,usage_json,evaluated_at
		FROM cover_observations WHERE cache_key=?`).get(cacheKey) as VisionAttempt | undefined ?? null;
}

/** Include interrupted/invalid attempts in normal CLI selection even with an older valid head. */
export function hasUnpromotedVisionAttempt(db: Database.Database, cacheKey: string): boolean {
	if (!hasHistory(db)) return false;
	const latest = loadVisionAttempt(db, cacheKey);
	if (!latest?.id) return false;
	const head = db.prepare('SELECT attempt_id FROM cover_vision_heads WHERE cache_key=?').get(cacheKey) as { attempt_id: string } | undefined;
	return head?.attempt_id !== latest.id;
}

/** Commit raw text and any reported usage without validating the paid answer. */
export function saveVisionResponse(db: Database.Database, input: {
	imageHash: string; requestedModel: string; responseText: string; evaluatedAt?: string;
}): VisionAttempt {
	requireDurableWrite(db);
	let model: string | null = null, usage: string | null = null;
	try {
		const raw = JSON.parse(input.responseText);
		if (raw && typeof raw === 'object') {
			model = typeof raw.model === 'string' ? raw.model : null;
			if (raw.usage !== undefined) usage = JSON.stringify(raw.usage);
		}
	} catch { /* Invalid JSON is still an important paid response. Retain it verbatim. */ }
	const id = randomUUID(), cacheKey = coverCacheKey(input.imageHash, input.requestedModel);
	archiveLegacyHead(db, cacheKey);
	db.prepare(`INSERT INTO cover_vision_attempts
		(id,cache_key,image_hash,requested_model,rubric_version,model,response_text,usage_json,evaluated_at)
		VALUES (?,?,?,?,?,?,?,?,?)`).run(id, cacheKey, input.imageHash, input.requestedModel, COVER_RUBRIC_VERSION,
			model, input.responseText, usage, input.evaluatedAt ?? new Date().toISOString());
	return db.prepare('SELECT * FROM cover_vision_attempts WHERE id=?').get(id) as VisionAttempt;
}

// A legacy writer/test may insert a current row after migration. Preserve it
// before our first replacement, just as the migration preserves existing rows.
function archiveLegacyHead(db: Database.Database, cacheKey: string): void {
	db.transaction(() => {
		db.prepare(`INSERT OR IGNORE INTO cover_vision_attempts
			(id,cache_key,image_hash,requested_model,rubric_version,model,legacy_observation_json,usage_json,evaluated_at)
			SELECT 'legacy:' || cache_key,cache_key,image_hash,requested_model,rubric_version,model,observation_json,usage_json,evaluated_at
			FROM cover_observations WHERE cache_key=? AND NOT EXISTS (SELECT 1 FROM cover_vision_attempts WHERE cache_key=?)`).run(cacheKey, cacheKey);
		db.prepare(`INSERT OR IGNORE INTO cover_vision_heads (cache_key,attempt_id,promoted_at)
			SELECT cache_key,id,evaluated_at FROM cover_vision_attempts
			WHERE cache_key=? AND legacy_observation_json IS NOT NULL`).run(cacheKey);
	}).immediate();
}

export class VisionCacheReviewError extends Error {
	constructor(readonly attemptId: string | null, readonly cacheKey: string, readonly cached: boolean, error: VisionResponseError) {
		super(`Saved cover response needs review. ${error.message} Normal runs revalidate the saved response; use --force only to buy a new attempt.`);
	}
}

function validateAttempt(attempt: VisionAttempt, imageHash: string, requestedModel: string): VisionResult {
	try {
		if (attempt.image_hash !== imageHash || attempt.requested_model !== requestedModel || attempt.rubric_version !== COVER_RUBRIC_VERSION ||
			attempt.cache_key !== coverCacheKey(imageHash, requestedModel)) {
			throw new VisionResponseError('The saved cover response does not match its image, model, or rubric.');
		}
		if (attempt.response_text !== null) return parseVisionResponse(attempt.response_text);
		if (!attempt.model) throw new VisionResponseError('The legacy cover observation has no model.');
		return { model: attempt.model, observation: validateObservation(JSON.parse(attempt.legacy_observation_json!)),
			usage: validateVisionUsage(JSON.parse(attempt.usage_json ?? 'null')) };
	} catch (error) {
		if (error instanceof VisionResponseError) throw error;
		throw new VisionResponseError('The saved cover observation is invalid.');
	}
}

function promoteAttempt(db: Database.Database, attempt: VisionAttempt, result: VisionResult, source?: {
	url: string; currentCacheKey: () => string;
}): { promoted: boolean; current: boolean } {
	if (!attempt.id) return { promoted: false, current: true }; // Read-only, pre-migration legacy hit.
	return db.transaction(() => {
		// An interrupted promotion must not replace a newer retained response,
		// even if that newer response is still invalid or awaiting validation.
		if (loadVisionAttempt(db, attempt.cache_key)?.id !== attempt.id) return { promoted: false, current: false };
		const head = db.prepare('SELECT attempt_id FROM cover_vision_heads WHERE cache_key=?').get(attempt.cache_key) as { attempt_id: string } | undefined;
		const promoted = head?.attempt_id !== attempt.id;
		if (promoted) {
			db.prepare(`INSERT INTO cover_observations (cache_key,image_hash,requested_model,model,rubric_version,observation_json,usage_json,evaluated_at)
				VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET
				image_hash=excluded.image_hash,requested_model=excluded.requested_model,model=excluded.model,rubric_version=excluded.rubric_version,
				observation_json=excluded.observation_json,usage_json=excluded.usage_json,evaluated_at=excluded.evaluated_at`).run(
					attempt.cache_key, attempt.image_hash, attempt.requested_model, result.model, attempt.rubric_version,
					JSON.stringify(result.observation), attempt.usage_json!, attempt.evaluated_at);
			db.prepare(`INSERT INTO cover_vision_heads (cache_key,attempt_id,promoted_at) VALUES (?,?,?)
				ON CONFLICT(cache_key) DO UPDATE SET attempt_id=excluded.attempt_id,promoted_at=excluded.promoted_at`).run(attempt.cache_key, attempt.id, new Date().toISOString());
		}
		if (source) {
			const current = loadCoverImageSource(db, source.url);
			if (current?.image_hash !== attempt.image_hash || source.currentCacheKey() !== attempt.cache_key) return { promoted, current: false };
			db.prepare(`INSERT INTO cover_sources (cover_url,cache_key,checked_at) VALUES (?,?,?)
				ON CONFLICT(cover_url) DO UPDATE SET cache_key=excluded.cache_key,checked_at=excluded.checked_at`).run(source.url, attempt.cache_key, current.checked_at);
		}
		return { promoted, current: true };
	}).immediate();
}

export interface CoverVisionResult extends VisionResult {
	cacheKey: string; imageHash: string; evaluatedAt: string; attemptId: string | null;
	cached: boolean; promoted: boolean; current: boolean;
}

/** All paid responses commit before validation; replay and promotion never rebuy. */
export async function assessCover(db: Database.Database, image: CoverImage, options: {
	force?: boolean; model?: string; observe?: typeof observeCover;
	source?: { url: string; checkedAt: string };
} = {}): Promise<CoverVisionResult> {
	const imageHash = image.hash, requestedModel = options.model ?? coverModel(), cacheKey = coverCacheKey(imageHash, requestedModel);
	if (createHash('sha256').update(image.data).digest('hex') !== imageHash) throw new Error('Cover image bytes do not match their cache hash.');
	if (options.source) {
		recordCoverImage(db, { cover_url: options.source.url, image_hash: imageHash, checked_at: options.source.checkedAt });
		if (loadCoverImageSource(db, options.source.url)?.image_hash !== imageHash) throw new Error('The cover URL has newer image bytes. Refresh its saved image before assessment.');
	}
	if (hasHistory(db)) archiveLegacyHead(db, cacheKey);
	let attempt = options.force ? null : loadVisionAttempt(db, cacheKey);
	const cached = !!attempt;
	if (!attempt) {
		requireDurableWrite(db); // A cache miss must not buy a response it cannot retain.
		const retained: { attempt: VisionAttempt | null } = { attempt: null };
		try {
			await (options.observe ?? observeCover)(image, { model: requestedModel, onResponse: responseText => {
				if (retained.attempt) throw new Error('Cover vision client returned more than one response for an attempt.');
				retained.attempt = saveVisionResponse(db, { imageHash, requestedModel, responseText });
			} });
		} catch (error) {
			if (retained.attempt && error instanceof VisionResponseError) throw new VisionCacheReviewError(retained.attempt.id, cacheKey, false, error);
			throw error;
		}
		attempt = retained.attempt;
		if (!attempt) throw new Error('Cover vision client did not retain its response.');
	}
	let result: VisionResult;
	try { result = validateAttempt(attempt, imageHash, requestedModel); }
	catch (error) { throw new VisionCacheReviewError(attempt.id, cacheKey, cached, error as VisionResponseError); }
	const head = promoteAttempt(db, attempt, result, options.source && { url: options.source.url,
		currentCacheKey: () => coverCacheKey(imageHash, options.model ?? coverModel()) });
	return { ...result, ...head, cacheKey, imageHash, evaluatedAt: attempt.evaluated_at, attemptId: attempt.id,
		cached, usage: cached ? { input_tokens: 0, output_tokens: 0 } : result.usage };
}
