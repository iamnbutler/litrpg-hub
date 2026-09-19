/**
 * Reviewed replacements for reader observations.
 *
 * When stored prose no longer passes validation it is NOT edited and no regex rewrites the
 * model's words: the observation is withheld and the context stays evidence-only, which is the
 * correct resting state rather than a degraded one. A reviewed sentence may be bound to the
 * exact answer it supersedes, and it is applied only when every one of these holds:
 *
 *   - it has been reviewed (`reviewedAt` a real past timestamp, `reviewedBy` set);
 *   - `inputHash` matches the observation currently derived from the evidence, so a correction
 *     written against older evidence can never ride onto newer evidence;
 *   - the retained receipt still exists and agrees — `inferenceId`, model, rubric version and
 *     the evidence's source URLs must all match what is on file, not merely the same entity;
 *   - exactly one approved correction claims that input; duplicates fail closed;
 *   - the replacement passes the same validation the model's prose must pass.
 *
 * Approved corrections live in a committed config so they survive a database restore; the
 * unreviewed draft lives in an ignored file.
 */
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { hash } from './queue.js';

/** Committed, restore-durable, and free of raw comment text. */
export const CORRECTIONS_CONFIG = 'scripts/backend/config/reader-observation-corrections.json';
/** Ignored: proposals awaiting review, which may quote the prose they supersede. */
export const CORRECTIONS_DRAFT = 'data/reader-corrections.json';
/** Bumped when the validation policy changes. Deliberately NOT the inference input rubric:
 *  bumping that would invalidate every cached answer and repurchase all of the evidence. */
export const VALIDATOR_VERSION = 'reader-validator-v1';

/** Which retained receipt a correction is answering. An observation that was parked never
 * produced a judged answer, so a reviewed replacement for it can only bind to the raw wire that
 * was paid for. The kind must be declared: defaulting to the judged answer keeps every existing
 * approval, and every existing wrong-kind refusal, exactly as it was. */
export const receiptKinds = ['reader-observation', 'reader-observation-raw', 'reader-observation-wire'] as const;
export type ReceiptKind = typeof receiptKinds[number];

export interface ReaderCorrection {
  entityType: 'series' | 'work';
  entityId: string;
  inputHash: string;
  /** The retained receipt for the answer being superseded. */
  inferenceId: string;
  model: string;
  rubricVersion: string;
  /** Defaults to the judged answer; declare it to answer a parked raw or wire receipt instead. */
  receiptKind?: ReceiptKind;
  sourceUrls: string[];
  observation: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  validatorVersion?: string;
  note?: string;
}
export type CorrectionOutcome =
  | { status: 'none' }
  | { status: 'applied'; correction: ReaderCorrection }
  | { status: 'refused'; reason: string };

export function loadCorrections(path = CORRECTIONS_CONFIG): ReaderCorrection[] {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  try {
    const parsed = JSON.parse(raw) as { corrections?: ReaderCorrection[] } | ReaderCorrection[];
    const list = Array.isArray(parsed) ? parsed : parsed.corrections ?? [];
    return list.filter(entry => entry && typeof entry.entityId === 'string' && typeof entry.observation === 'string');
  } catch { return []; }
}
/** A real timestamp that has already happened. A blank or future review is not a review. */
export function reviewedInThePast(value: string | null | undefined, now = new Date()): boolean {
  if (!value?.trim()) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now.getTime();
}
export const isApproved = (correction: ReaderCorrection, now = new Date()): boolean =>
  reviewedInThePast(correction.reviewedAt, now) && !!correction.reviewedBy?.trim();

/**
 * Resolve the correction for one observation against its retained receipt. The caller still
 * validates the prose: being hand-written earns a sentence no exemption from the rules.
 */
export function resolveCorrection(db: Database.Database, corrections: ReaderCorrection[], context: {
  entityType: 'series' | 'work'; entityId: string; inputHash: string; sourceUrls: string[]; now?: Date;
}): CorrectionOutcome {
  const claiming = corrections.filter(c => c.entityType === context.entityType && c.entityId === context.entityId && c.inputHash === context.inputHash);
  const approved = claiming.filter(c => isApproved(c, context.now));
  if (!approved.length) {
    return claiming.length ? { status: 'refused', reason: 'A correction is proposed for this input but has not been reviewed.' } : { status: 'none' };
  }
  // Two reviewed corrections for one input is an unresolved disagreement, not a tie to break.
  if (approved.length > 1) return { status: 'refused', reason: `${approved.length} reviewed corrections claim this input; refusing until exactly one does.` };
  const correction = approved[0];
  // The id must be the one this entity's own observation would have. Evidence linked to both a
  // series and its work can produce an identical input hash, so matching hash and model alone
  // would let a correction bind to a different entity's receipt, or to the raw wire instead of
  // the judged answer.
  const kind = correction.receiptKind ?? 'reader-observation';
  if (!receiptKinds.includes(kind)) return { status: 'refused', reason: `${kind} is not a reader observation receipt kind.` };
  const expected = hash(['reader', `${context.entityType}:${context.entityId}`, kind, context.inputHash]);
  if (correction.inferenceId !== expected) {
    return { status: 'refused', reason: `The correction names a receipt that is not this entity's ${kind} for this input.` };
  }
  const receipt = db.prepare(`SELECT input_hash, actual_model, rubric_version, entity_type, entity_id, kind
    FROM catalog_inferences WHERE id=?`).get(correction.inferenceId) as
    { input_hash: string; actual_model: string; rubric_version: string; entity_type: string; entity_id: string; kind: string } | undefined;
  if (!receipt) return { status: 'refused', reason: `No retained inference ${correction.inferenceId} for this correction.` };
  if (receipt.entity_type !== 'reader' || receipt.entity_id !== `${context.entityType}:${context.entityId}` || receipt.kind !== kind) {
    return { status: 'refused', reason: `The receipt belongs to ${receipt.entity_type}/${receipt.entity_id}/${receipt.kind}, not this entity's ${kind}.` };
  }
  if (receipt.input_hash !== context.inputHash) return { status: 'refused', reason: 'The receipt records a different input than the evidence now produces.' };
  if (receipt.actual_model !== correction.model) return { status: 'refused', reason: `The receipt records model ${receipt.actual_model}, the correction claims ${correction.model}.` };
  if (receipt.rubric_version !== correction.rubricVersion) return { status: 'refused', reason: `The receipt records rubric ${receipt.rubric_version}, the correction claims ${correction.rubricVersion}.` };
  const wanted = [...new Set(context.sourceUrls)].sort().join('|');
  if ([...new Set(correction.sourceUrls ?? [])].sort().join('|') !== wanted) {
    return { status: 'refused', reason: 'The correction names different source URLs than the evidence it would describe.' };
  }
  return { status: 'applied', correction };
}
