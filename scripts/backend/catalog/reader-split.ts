/**
 * Reviewed Impressions / Critiques bullets for a published reader observation.
 *
 * The observation itself stays the source of record. These bullets are a reviewed reading OF
 * that sentence, never a second opinion about the book and never a re-derivation from the raw
 * comments, so they cannot introduce a claim the observation did not already carry.
 *
 * Nothing here classifies prose. A sentence like "comments describe both brisk pacing and a
 * slow opening" has no side, and a regex that guessed one would silently invent a reader
 * consensus. The split is therefore an editorial reading — drafted by an agent, reviewed and
 * approved before deploy — bound to the exact text it was read from:
 *
 *   - BOTH bindings must match what is currently published. `inputHash` identifies the evidence
 *     and sample the observation was derived from; `textHash` identifies the exact prose. They
 *     are separate because a reviewed CORRECTION replaces the text while leaving the input
 *     unchanged, so binding to the input alone would let bullets survive a rewrite of the very
 *     sentence they were read from;
 *   - exactly one approved split may claim an entity and hash; duplicates fail closed;
 *   - a bullet may not assert how many readers held a view, because the sample cannot support
 *     it — the same policy the observation prose itself must satisfy;
 *   - a bullet may mention narration only when the observation does, since audio evidence is a
 *     separate claim that reader prose does not automatically license;

 * Reusing the observation's own wording is deliberately ALLOWED. These bullets present prose
 * that was already original and already approved, so demanding a fresh paraphrase would buy no
 * privacy and introduce semantic drift. Overlap with raw comment text is guarded upstream,
 * where the observation itself is validated.
 *
 * A disagreement belongs on BOTH sides. When readers called Jason witty and also called him
 * arrogant, that is the finding; collapsing it to one side would misreport the sample. Equally,
 * neither side is padded to match the other — an empty side is an honest answer, and a book the
 * sample only criticised should look that way.
 */
import { readFileSync } from 'node:fs';
import { hash } from './queue.js';
import { reviewedInThePast } from './reader-corrections.js';

/** Committed, restore-durable. Holds no raw comment text. */
export const SPLITS_CONFIG = 'scripts/backend/config/reader-observation-splits.json';
/** Ignored: proposals awaiting review, which quote the observation they were read from. */
export const SPLITS_DRAFT = 'data/reader-splits.json';
/** Bumped when this validation policy changes. Deliberately NOT the observation rubric:
 *  bumping that would invalidate every cached answer and repurchase the evidence. */
export const SPLIT_VALIDATOR_VERSION = 'reader-split-v1';

/** `reader-evidence` imports this module, so importing its policy back would close a cycle.
 *  Both patterns are therefore declared here and a test asserts they stay identical to the
 *  observation validator's, which catches drift mechanically instead of by hope. */
export const SPLIT_PREVALENCE_QUANTIFIER = /\b(consistently|commonly|universally|unanimously|generally|widely|typically|frequently|often|mostly|most|many|majority|almost all|nearly all|all readers|everyone|few readers|several readers)\b/i;
export const SPLIT_AUDIO_TERM = /\b(narrator|narrators|narration|narrated|narrating|audiobook|audio|listener|listeners|listening|voice acting)\b/i;

/** Binds bullets to the exact prose, so a corrected rewrite drops them rather than keeping
 *  a reading of a sentence that no longer exists. */
export const observationTextHash = (observation: string) => hash(['reader-observation-text', observation]);

export const SPLIT_LIMITS = { perSide: 3, maxWords: 12, minWords: 2, maxChars: 90 } as const;

export interface ReaderSplit {
  entityType: 'series' | 'work';
  entityId: string;
  /** The evidence and sample the published observation was derived from. */
  inputHash: string;
  /** Digest of the exact published prose. Changes when a correction rewrites it. */
  textHash: string;
  impressions: string[];
  critiques: string[];
  reviewedAt: string | null;
  reviewedBy: string | null;
  validatorVersion?: string;
  note?: string;
}
export type SplitOutcome =
  | { status: 'none' }
  | { status: 'applied'; split: ReaderSplit }
  | { status: 'refused'; reason: string };

export function loadSplits(path = SPLITS_CONFIG): ReaderSplit[] {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  try {
    const parsed = JSON.parse(raw) as { splits?: ReaderSplit[] } | ReaderSplit[];
    const list = Array.isArray(parsed) ? parsed : parsed.splits ?? [];
    return list.filter(entry => entry && typeof entry.entityId === 'string'
      && typeof entry.inputHash === 'string' && typeof entry.textHash === 'string'
      && Array.isArray(entry.impressions) && Array.isArray(entry.critiques));
  } catch { return []; }
}

export const isApprovedSplit = (split: ReaderSplit, now = new Date()): boolean =>
  reviewedInThePast(split.reviewedAt, now) && !!split.reviewedBy?.trim();

const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/** Throws with the reason a reviewed split may not be published. */
export function validateSplit(split: ReaderSplit, observation: string): void {
  const sides: [string, string[]][] = [['impressions', split.impressions], ['critiques', split.critiques]];
  if (!split.impressions.length && !split.critiques.length) throw new Error('has no bullets on either side');
  const seen = new Set<string>();
  for (const [side, bullets] of sides) {
    if (bullets.length > SPLIT_LIMITS.perSide) throw new Error(`lists more than ${SPLIT_LIMITS.perSide} ${side}`);
    for (const bullet of bullets) {
      if (typeof bullet !== 'string' || !bullet.trim()) throw new Error(`has an empty ${side} bullet`);
      const count = words(bullet).length;
      if (count < SPLIT_LIMITS.minWords || count > SPLIT_LIMITS.maxWords || bullet.length > SPLIT_LIMITS.maxChars) {
        throw new Error(`has a ${side} bullet outside ${SPLIT_LIMITS.minWords}-${SPLIT_LIMITS.maxWords} words: "${bullet}"`);
      }
      const key = words(bullet).join(' ');
      if (seen.has(key)) throw new Error(`repeats the bullet "${bullet}"`);
      seen.add(key);
      const quantifier = bullet.match(SPLIT_PREVALENCE_QUANTIFIER);
      if (quantifier) throw new Error(`claims "${quantifier[0]}" readers in "${bullet}", which the sample cannot support`);
      if (SPLIT_AUDIO_TERM.test(bullet) && !SPLIT_AUDIO_TERM.test(observation)) {
        throw new Error(`mentions narration in "${bullet}" though the observation does not`);
      }
    }
  }
}

/**
 * Resolve the reviewed split for one published observation. Returns `none` when no reviewed
 * split claims this exact text, which is the resting state, and `refused` when one does but
 * may not be published. The caller publishes BOTH arrays or NEITHER.
 */
export function resolveSplit(
  splits: ReaderSplit[],
  context: { entityType: 'series' | 'work'; entityId: string; inputHash: string; observation: string },
  now = new Date(),
): SplitOutcome {
  const claiming = splits.filter(split => split.entityType === context.entityType
    && split.entityId === context.entityId
    && split.inputHash === context.inputHash
    && split.textHash === observationTextHash(context.observation)
    && isApprovedSplit(split, now));
  if (!claiming.length) return { status: 'none' };
  if (claiming.length > 1) {
    return { status: 'refused', reason: `${claiming.length} reviewed splits claim this observation; none is applied.` };
  }
  const [split] = claiming;
  if (split.validatorVersion && split.validatorVersion !== SPLIT_VALIDATOR_VERSION) {
    return { status: 'refused', reason: `Reviewed under ${split.validatorVersion}, not ${SPLIT_VALIDATOR_VERSION}.` };
  }
  try {
    validateSplit(split, context.observation);
  } catch (error) {
    return { status: 'refused', reason: `The reviewed split ${error instanceof Error ? error.message : 'could not be validated'}.` };
  }
  return { status: 'applied', split };
}
