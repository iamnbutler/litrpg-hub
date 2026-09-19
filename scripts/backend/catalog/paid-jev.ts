/**
 * One paid Jev answer, retained before it is judged.
 *
 * A 2xx body is committed as its own receipt before anything parses or validates it, so a
 * malformed or unusable answer is never bought twice. Replay order is the normalized cache, then
 * that receipt, then a paid call — so nothing bought before wire retention existed is re-bought,
 * and an unchanged unusable body re-judges for free and parks for review.
 *
 * Mirrors the guarantees `catalog/inference.ts` gives the core extraction path; its equivalents
 * are private to that module, so these are shared between the author and reader paths instead.
 */
import type Database from 'better-sqlite3';
import { evaluate as callJev, parseResponseText, type JevResponse, type Question } from '../jev/client.js';
import { hash } from './queue.js';
import { PaidResponseStorageError, ReviewError } from './types.js';

export type Usage = { input_tokens: number; output_tokens: number };
const ZERO: Usage = { input_tokens: 0, output_tokens: 0 };

/** Raised before any spend: a receipt that a caller can roll back is not durable. */
export class JevTransactionError extends ReviewError {
  constructor(why: string) {
    super(`Refusing to buy a Jev answer while ${why}: the paid receipt could not be committed independently of it.`);
  }
}

/** The answer arrived but its receipt did not commit. Stops the worker; never retried. */
export class JevPaidStorageError extends PaidResponseStorageError {
  constructor(readonly usage: Usage, cause: string) {
    super();
    this.message = `${this.message} Cause: ${cause}`;
  }
}

/** A retained answer that cannot be used. Re-judging costs nothing, so it parks for review. */
export class JevReviewError extends ReviewError {
  constructor(message: string, readonly usage: Usage) { super(message); }
}

export function independentCommitBlocker(db: Database.Database): string | null {
  if (db.inTransaction) return 'a caller transaction is open';
  if (db.readonly) return 'the cache is read-only';
  return null;
}

/** Older receipts stored the parsed answer; retained ones hold the exact HTTP text. */
export function retainedText(resultJson: string): string | null {
  try {
    const held = JSON.parse(resultJson) as { text?: unknown };
    return typeof held?.text === 'string' ? held.text : null;
  } catch { return null; }
}

/** What the body says it cost. Unknown stays unknown: zeros would claim the call was free. */
export function retainedUsage(text: string): Usage | Record<string, never> {
  // Safe integers, matching jev/client.ts: a value the client would reject is not a token count.
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  try {
    const usage = (JSON.parse(text) as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
    return usage && whole(usage.input_tokens) && whole(usage.output_tokens)
      ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : {};
  } catch { return {}; }
}

const retainedModel = (text: string, fallback: string): string => {
  try { const m = (JSON.parse(text) as { model?: unknown }).model; return typeof m === 'string' ? m : fallback; }
  catch { return fallback; }
};

export interface PaidJevRequest {
  entityType: string; entity: string; kind: string; inputHash: string;
  rubricVersion: string; requestedModel: string;
  questions: Record<string, Question>;
  evaluate?: typeof callJev;
}

export async function paidJev(db: Database.Database, state: unknown, request: PaidJevRequest): Promise<{ response: JevResponse; cached: boolean; usage: Usage }> {
  const idFor = (kind: string) => hash([request.entityType, request.entity, kind, request.inputHash]);
  const read = (kind: string) => db.prepare('SELECT result_json,requested_model,rubric_version FROM catalog_inferences WHERE id=?')
    .get(idFor(kind)) as { result_json: string; requested_model: string; rubric_version: string } | undefined;
  /**
   * The cache id cannot prove the rubric and model were folded into `inputHash` — every caller
   * does fold them, but a future one might not, and would then be served answers from the old
   * rubric with nothing failing. Comparing what the row recorded is the part we can check, and
   * it fails closed: a mismatch parks for review rather than silently reusing or re-buying.
   */
  const declaredFor = (kind: string, row: { requested_model: string; rubric_version: string }) => {
    if (row.requested_model !== request.requestedModel) {
      throw new JevReviewError(`The retained ${kind} was requested from ${row.requested_model}, not ${request.requestedModel}; refusing to reuse it.`, ZERO);
    }
    if (row.rubric_version !== request.rubricVersion) {
      throw new JevReviewError(`The retained ${kind} was written under rubric ${row.rubric_version}, not ${request.rubricVersion}; refusing to reuse it.`, ZERO);
    }
  };
  const save = (kind: string, actual: string, result: unknown, usage: unknown) =>
    db.prepare(`INSERT OR IGNORE INTO catalog_inferences(id,entity_type,entity_id,kind,input_hash,requested_model,actual_model,rubric_version,result_json,usage_json,evaluated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(idFor(kind), request.entityType, request.entity, kind, request.inputHash,
        request.requestedModel, actual, request.rubricVersion, JSON.stringify(result), JSON.stringify(usage), new Date().toISOString());

  // The already-validated answer first: whatever was bought before retention existed stays bought.
  const normalized = read(request.kind);
  if (normalized) {
    declaredFor(request.kind, normalized);
    // Validated, not merely cast: valid JSON of the wrong shape — null, {}, a missing answer —
    // would otherwise escape here and fail downstream as a TypeError the queue reads as
    // transient. Nothing new was spent, so retrying can only read the same bad row again.
    try { return { response: parseResponseText(normalized.result_json, request.questions), cached: true, usage: ZERO }; }
    catch (error) {
      throw new JevReviewError(`${error instanceof Error ? error.message : 'The retained Jev answer could not be read.'} Nothing new would be bought by retrying it.`, ZERO);
    }
  }

  const wireKind = `${request.kind}-wire`;
  const held = read(wireKind);
  if (held) {
    declaredFor(wireKind, held);
    const text = retainedText(held.result_json);
    try {
      if (text === null) throw new Error('The retained Jev response could not be read.');
      const response = parseResponseText(text, request.questions);
      save(request.kind, response.model, response, ZERO);
      return { response, cached: true, usage: ZERO };
    } catch (error) {
      throw new JevReviewError(`${error instanceof Error ? error.message : 'The retained Jev answer could not be used.'} The paid answer is archived; re-judging it will not cost anything.`, ZERO);
    }
  }

  // Refused before the spend, not discovered after it.
  const blocked = independentCommitBlocker(db);
  if (blocked) throw new JevTransactionError(blocked);

  let paid: Usage = ZERO, archived = false;
  const response = await (request.evaluate ?? callJev)(state, request.questions, {
    model: request.requestedModel,
    onResponse: (text: string) => {
      const usage = retainedUsage(text);
      paid = 'input_tokens' in usage ? usage as Usage : ZERO;
      // Rechecked here: a caller can open a transaction while the request is in flight.
      const late = independentCommitBlocker(db);
      if (late) throw new JevPaidStorageError(paid, `${late} while the request was in flight`);
      try { save(wireKind, retainedModel(text, request.requestedModel), { text }, usage); }
      catch (error) { throw new JevPaidStorageError(paid, error instanceof Error ? error.message : 'unknown database error'); }
      archived = true;
    }
  }).catch((error: unknown) => {
    // A storage failure is already terminal, and a transport failure archived nothing, so a
    // non-2xx keeps its own semantics and stays retryable.
    if (error instanceof ReviewError || !archived) throw error;
    throw new JevReviewError(`${error instanceof Error ? error.message : 'The Jev answer could not be used.'} The paid answer is archived; re-judging it will not cost anything.`, paid);
  });
  // Whichever receipt exists owns the cost exactly once. A trusted injected evaluator can return
  // a parsed answer without ever handing us a body to retain, and then this is the only receipt.
  save(request.kind, response.model, response, archived ? ZERO : response.usage);
  return { response, cached: false, usage: archived ? paid : response.usage };
}
