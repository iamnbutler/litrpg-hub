import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CoverAssessment } from '../../../src/lib/catalog.js';
import { hash } from '../catalog/queue.js';
import { PaidResponseStorageError, ReviewError } from '../catalog/types.js';
import { evaluate, parseResponseText, type JevResponse } from '../jev/client.js';
import { CONTENT_RUBRIC_VERSION, contentAssessmentHash, contentQuestions, contentState, toContentAssessment, type ContentAssessment } from './content.js';

const hasTable = (db: Database.Database, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const WIRE_KIND = 'cover-content-wire-response';
const noUsage = () => ({ input_tokens: 0, output_tokens: 0 });

function requireRunTables(db: Database.Database) {
	if (!['catalog_inferences', 'cover_content_inference_heads', 'cover_content_inference_responses'].every(name => hasTable(db, name))) {
		throw new Error('Apply migration 009_cover_inference_heads.sql before creating a cover-content inference run.');
	}
}

function requireIndependentCommit(db: Database.Database) {
	requireRunTables(db);
	// Validation or the caller's rollback must never undo a paid receipt.
	if (db.inTransaction) throw new Error('Cover-content responses must be saved outside a caller transaction.');
	if (db.readonly) throw new Error('Cover-content responses require a writable cache before making a paid request.');
}

function parseAssessment(json: string, inputHash: string): ContentAssessment | null {
	try {
		const value = JSON.parse(json) as ContentAssessment;
		if (!value || value.inputHash !== inputHash || typeof value.model !== 'string' || typeof value.evaluatedAt !== 'string') return null;
		for (const field of ['sexualized', 'explicit', 'harem'] as const) {
			const signal = value[field];
			if (!signal || !['present', 'absent', 'unknown'].includes(signal.verdict) ||
				!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1 ||
				!['publisher', 'jev', 'vision', 'manual', 'unknown'].includes(signal.source) || typeof signal.note !== 'string') return null;
		}
		return value;
	} catch { return null; }
}

/** Read only the exact requested input. Works both before and after migration 009. */
export function loadContentAssessment(db: Database.Database, editionId: string, inputHash: string): ContentAssessment | null {
	if (hasTable(db, 'cover_content_inference_heads') && hasTable(db, 'catalog_inferences')) {
		const head = db.prepare(`SELECT i.result_json FROM cover_content_inference_heads h
			JOIN catalog_inferences i ON i.id=h.inference_id
			WHERE h.edition_id=? AND h.input_hash=? AND i.entity_type='edition'
				AND i.entity_id=h.edition_id AND i.kind='cover-content' AND i.input_hash=h.input_hash`)
			.get(editionId, inputHash) as { result_json: string } | undefined;
		// An explicit head is authoritative; a malformed head must not revive an old verdict.
		if (head) return parseAssessment(head.result_json, inputHash);
	}

	const legacy: { assessment: ContentAssessment; evaluatedAt: number }[] = [];
	if (hasTable(db, 'catalog_inferences')) {
		const row = db.prepare(`SELECT result_json,evaluated_at FROM catalog_inferences
			WHERE id=? AND entity_type='edition' AND entity_id=? AND kind='cover-content' AND input_hash=?`)
			.get(hash(['edition', editionId, 'cover-content', inputHash]), editionId, inputHash) as { result_json: string; evaluated_at: string } | undefined;
		const assessment = row && parseAssessment(row.result_json, inputHash);
		if (assessment) legacy.push({ assessment, evaluatedAt: Date.parse(row.evaluated_at) || 0 });
	}
	if (hasTable(db, 'book_content_assessments')) {
		const row = db.prepare('SELECT assessment_json,evaluated_at FROM book_content_assessments WHERE book_id=? AND input_hash=?')
			.get(editionId, inputHash) as { assessment_json: string; evaluated_at: string } | undefined;
		const assessment = row && parseAssessment(row.assessment_json, inputHash);
		if (assessment) legacy.push({ assessment, evaluatedAt: Date.parse(row.evaluated_at) || 0 });
	}
	// Before heads existed, --force could update only the per-book row. Keep that
	// newer matching answer readable without mutating either historical source.
	return legacy.sort((a, b) => b.evaluatedAt - a.evaluatedAt)[0]?.assessment ?? null;
}

export interface ContentWireResponse {
	id: string;
	entity_id: string;
	input_hash: string;
	requested_model: string;
	actual_model: string;
	rubric_version: string;
	/** JSON-encoded exact HTTP text; private audit data, never a public synopsis. */
	result_json: string;
	usage_json: string;
	evaluated_at: string;
}

/** Receipt insertion order, independent of wall-clock ties or clock corrections. */
export function loadContentWireResponse(db: Database.Database, editionId: string, inputHash: string): ContentWireResponse | null {
	if (!hasTable(db, 'catalog_inferences')) return null;
	return db.prepare(`SELECT * FROM catalog_inferences WHERE entity_type='edition'
		AND entity_id=? AND kind=? AND input_hash=? ORDER BY rowid DESC LIMIT 1`)
		.get(editionId, WIRE_KIND, inputHash) as ContentWireResponse | undefined ?? null;
}

const projectionId = (receipt: ContentWireResponse) => hash(['edition', receipt.entity_id, 'cover-content', receipt.input_hash, 'wire', receipt.id]);

function contentHeadId(db: Database.Database, editionId: string, inputHash: string): string | null {
	if (!hasTable(db, 'cover_content_inference_heads')) return null;
	return (db.prepare('SELECT inference_id FROM cover_content_inference_heads WHERE edition_id=? AND input_hash=?')
		.get(editionId, inputHash) as { inference_id: string } | undefined)?.inference_id ?? null;
}

/** Select interrupted/invalid responses even when an older valid public head remains. */
export function hasUnpromotedContentResponse(db: Database.Database, editionId: string, inputHash: string): boolean {
	const receipt = loadContentWireResponse(db, editionId, inputHash);
	return !!receipt && contentHeadId(db, editionId, inputHash) !== projectionId(receipt);
}

/** Append and independently commit the paid HTTP text before any answer validation. */
export function saveContentWireResponse(db: Database.Database, input: {
	editionId: string; inputHash: string; requestedModel: string; responseText: string;
}): ContentWireResponse {
	let model = 'unknown', usage: unknown = {};
	try {
		const raw = JSON.parse(input.responseText);
		if (raw && typeof raw === 'object') {
			if (typeof raw.model === 'string') model = raw.model;
			if (raw.usage !== undefined) usage = raw.usage;
		}
	} catch { /* Malformed JSON still represents a paid response. Retain it verbatim. */ }
	const receipt: ContentWireResponse = {
		id: hash(['edition', input.editionId, WIRE_KIND, input.inputHash, randomUUID()]),
		entity_id: input.editionId, input_hash: input.inputHash, requested_model: input.requestedModel,
		actual_model: model, rubric_version: CONTENT_RUBRIC_VERSION, result_json: JSON.stringify(input.responseText),
		usage_json: JSON.stringify(usage), evaluated_at: new Date().toISOString()
	};
	// Recheck here as well as before HTTP: a caller can BEGIN while it is awaited.
	requireIndependentCommit(db);
	db.prepare(`INSERT INTO catalog_inferences
		(id,entity_type,entity_id,kind,input_hash,requested_model,actual_model,rubric_version,result_json,usage_json,evaluated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(receipt.id, 'edition', receipt.entity_id, WIRE_KIND, receipt.input_hash,
			receipt.requested_model, receipt.actual_model, receipt.rubric_version, receipt.result_json, receipt.usage_json, receipt.evaluated_at);
	return receipt;
}

export class ContentCacheReviewError extends ReviewError {
	constructor(readonly responseId: string | null, readonly inputHash: string, readonly cached: boolean) {
		super('Saved cover-content response needs review. Normal runs revalidate the retained response; use --force only to buy a new attempt.');
		this.name = 'ContentCacheReviewError';
	}
}

function validateReceipt(receipt: ContentWireResponse, editionId: string, inputHash: string, requestedModel: string): JevResponse {
	if (receipt.entity_id !== editionId || receipt.input_hash !== inputHash || receipt.requested_model !== requestedModel ||
		receipt.rubric_version !== CONTENT_RUBRIC_VERSION) throw new Error('Saved cover-content response does not match its inference input.');
	const text: unknown = JSON.parse(receipt.result_json);
	if (typeof text !== 'string') throw new Error('Saved cover-content response text is invalid.');
	return parseResponseText(text, contentQuestions);
}

function hasStoredAssessment(db: Database.Database, editionId: string, inputHash: string): boolean {
	return (hasTable(db, 'catalog_inferences') && !!db.prepare(`SELECT 1 FROM catalog_inferences
		WHERE entity_type='edition' AND entity_id=? AND kind='cover-content' AND input_hash=? LIMIT 1`).get(editionId, inputHash)) ||
		(hasTable(db, 'book_content_assessments') && !!db.prepare('SELECT 1 FROM book_content_assessments WHERE book_id=? AND input_hash=?').get(editionId, inputHash));
}

export interface SaveContentAssessment {
	editionId: string;
	inputHash: string;
	requestedModel: string;
	assessment: ContentAssessment;
	response: JevResponse;
	/** New runs project this independently committed receipt; legacy callers may omit it. */
	wireResponseId?: string;
	/** Re-read current source metadata and cover evidence inside the transaction. */
	currentInputHash: () => string | null;
}

/** Project a retained response once; atomically promote only current, newest evidence. */
export function saveContentAssessment(db: Database.Database, run: SaveContentAssessment): { inferenceId: string; promoted: boolean } {
	requireRunTables(db);
	if (!parseAssessment(JSON.stringify(run.assessment), run.inputHash) || run.assessment.model !== run.response.model) {
		throw new Error('Cover-content assessment does not match its inference input or model.');
	}
	const receipt = run.wireResponseId ? db.prepare(`SELECT * FROM catalog_inferences WHERE id=? AND entity_type='edition' AND kind=?`)
		.get(run.wireResponseId, WIRE_KIND) as ContentWireResponse | undefined : undefined;
	if (run.wireResponseId && (!receipt || JSON.stringify(validateReceipt(receipt, run.editionId, run.inputHash, run.requestedModel)) !== JSON.stringify(run.response) ||
		run.assessment.evaluatedAt !== receipt.evaluated_at)) throw new Error('Cover-content projection does not match its retained response.');
	const inferenceId = receipt ? projectionId(receipt) : hash(['edition', run.editionId, 'cover-content', run.inputHash, randomUUID()]);
	const resultJson = JSON.stringify(run.assessment), responseJson = JSON.stringify(run.response);
	return db.transaction(() => {
		db.prepare(`INSERT OR IGNORE INTO catalog_inferences
			(id,entity_type,entity_id,kind,input_hash,requested_model,actual_model,rubric_version,result_json,usage_json,evaluated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(inferenceId, 'edition', run.editionId, 'cover-content', run.inputHash,
				run.requestedModel, run.response.model, CONTENT_RUBRIC_VERSION, resultJson, JSON.stringify(receipt ? noUsage() : run.response.usage), run.assessment.evaluatedAt);
		db.prepare('INSERT OR IGNORE INTO cover_content_inference_responses (inference_id,response_json) VALUES (?,?)')
			.run(inferenceId, responseJson);
		const existing = db.prepare(`SELECT i.result_json,r.response_json FROM catalog_inferences i
			JOIN cover_content_inference_responses r ON r.inference_id=i.id WHERE i.id=?`).get(inferenceId) as { result_json: string; response_json: string };
		if (existing.result_json !== resultJson || existing.response_json !== responseJson) throw new Error('Cover-content projection conflicts with its saved history.');
		const current = run.currentInputHash() === run.inputHash &&
			(!receipt || loadContentWireResponse(db, run.editionId, run.inputHash)?.id === receipt.id);
		const promoted = current && contentHeadId(db, run.editionId, run.inputHash) !== inferenceId;
		if (promoted) db.prepare(`INSERT INTO cover_content_inference_heads (edition_id,input_hash,inference_id,promoted_at)
			VALUES (?,?,?,?) ON CONFLICT(edition_id,input_hash) DO UPDATE SET inference_id=excluded.inference_id,promoted_at=excluded.promoted_at`)
			.run(run.editionId, run.inputHash, inferenceId, new Date().toISOString());
		return { inferenceId, promoted };
	}).immediate();
}

/** Shared runner keeps the CLI's normal cache path and forced path testable without APIs. */
export async function assessContent(db: Database.Database, book: Parameters<typeof contentState>[0] & { id: string }, cover: CoverAssessment, options: {
	force?: boolean;
	currentInputHash: () => string | null;
	evaluate?: typeof evaluate;
}): Promise<{ assessment: ContentAssessment; cached: boolean; promoted: boolean; inferenceId: string | null; usage: JevResponse['usage'] }> {
	const requestBook = { ...book }, requestCover = { ...cover, observations: [...cover.observations] };
	const editionId = requestBook.id, inputHash = contentAssessmentHash(requestBook, requestCover), requestedModel = process.env.JEV_MODEL ?? 'jev-latest';
	let receipt = options.force ? null : loadContentWireResponse(db, editionId, inputHash);
	const assessment = options.force ? null : loadContentAssessment(db, editionId, inputHash);
	if (assessment && (!receipt || contentHeadId(db, editionId, inputHash) === projectionId(receipt))) {
		return { assessment, cached: true, promoted: false, inferenceId: null, usage: noUsage() };
	}
	// A damaged legacy cache or an unpromoted old run still represents paid work.
	// Keep it available for review instead of silently purchasing a replacement.
	if (!options.force && !receipt && hasStoredAssessment(db, editionId, inputHash)) throw new ContentCacheReviewError(null, inputHash, true);
	// Legacy databases remain readable, but a miss must not buy a response it cannot save.
	requireRunTables(db);
	const cached = !!receipt;
	if (!receipt) {
		requireIndependentCommit(db);
		const retained: { receipt: ContentWireResponse | null } = { receipt: null };
		try {
			await (options.evaluate ?? evaluate)(contentState(requestBook, requestCover), contentQuestions, { model: requestedModel,
				onResponse: responseText => {
					if (retained.receipt) throw new Error('Cover-content client returned more than one response for an attempt.');
					try { retained.receipt = saveContentWireResponse(db, { editionId, inputHash, requestedModel, responseText }); }
					catch { throw new PaidResponseStorageError(); }
				}
			});
		} catch (error) {
			if (retained.receipt) throw new ContentCacheReviewError(retained.receipt.id, inputHash, false);
			throw error;
		}
		receipt = retained.receipt;
		if (!receipt) throw new Error('Cover-content client did not retain its response.');
	}
	let response: JevResponse;
	try { response = validateReceipt(receipt, editionId, inputHash, requestedModel); }
	catch { throw new ContentCacheReviewError(receipt.id, inputHash, cached); }
	// Preserve the key of the actual request even if runtime settings changed while awaiting it.
	const projected = { ...toContentAssessment(requestBook, requestCover, response), inputHash, evaluatedAt: receipt.evaluated_at };
	const saved = saveContentAssessment(db, { editionId, inputHash, requestedModel, assessment: projected, response,
		wireResponseId: receipt.id, currentInputHash: options.currentInputHash });
	return { assessment: projected, cached, ...saved, usage: cached ? noUsage() : response.usage };
}
