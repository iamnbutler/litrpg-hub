import Database from 'better-sqlite3';
import { lstatSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DB_PATH } from '../db.js';
import { PaidResponseStorageError } from '../catalog/types.js';
import { qualityEvidenceFor, type QualityReview } from './evidence.js';
import { ClaimsPaidStorageError, ClaimsReviewError, ClaimsTransactionError, loadQualityClaims, processQualityClaims,
  qualityClaimsHash, qualityClaimsModel } from './claims.js';
import { writeQualityReport } from './store.js';

interface Scope { work?: string; series?: string }
interface Options extends Scope { model?: string }
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
function validateScope(scope: Scope, required = false) {
  const specified = [scope.work, scope.series].filter(value => value !== undefined);
  if (specified.length > 1 || required && specified.length !== 1 || specified.some(value => !value?.trim()))
    throw new Error(required ? 'run requires exactly one --work or --series scope.' : 'Choose at most one --work or --series scope.');
}
function selected(db: Database.Database, options: Options): { workId: string; reviews: QualityReview[] }[] {
  validateScope(options);
  const works = options.work ? db.prepare('SELECT id FROM catalog_works WHERE id=?').all(options.work)
    : options.series ? db.prepare('SELECT id FROM catalog_works WHERE series_id=? ORDER BY number,id').all(options.series)
      : db.prepare('SELECT id FROM catalog_works ORDER BY series_id,number,id').all();
  if ((options.work || options.series) && !works.length) throw new Error('No catalog works match that scope.');
  return (works as { id: string }[]).map(work => ({ workId: work.id, reviews: qualityEvidenceFor(db, work.id).reviews }));
}

/** The default report contains no source text, quotes, rationale, private voice keys or paid bodies. */
export function qualityClaimsSummary(db: Database.Database, options: Options = {}) {
  const model = options.model ?? qualityClaimsModel(), works = selected(db, options);
  const reviews = works.flatMap(work => work.reviews.map(review => {
    const base = { reviewId: review.id, workId: work.workId, inputHash: qualityClaimsHash(review, model) };
    try {
      const held = loadQualityClaims(db, review, { model });
      return { ...base, status: held ? 'cached' as const : 'pending' as const,
        receiptId: held?.receiptId ?? null, receiptKind: held?.receiptKind ?? null,
        aspects: held?.claims.map(claim => ({ aspect: claim.aspect, polarity: claim.polarity })) ?? [] };
    } catch (error) {
      if (!(error instanceof ClaimsReviewError)) throw error;
      return { ...base, status: 'review' as const, receiptId: null, receiptKind: null, aspects: [] };
    }
  }));
  return { mode: 'experimental-classifier-comparison' as const, scoreInput: false, model,
    note: 'Extractive comparison only. These labels do not feed quality scores; exact quotes and rationales stay in private receipts.',
    coverage: { selectedWorks: works.length, worksWithReviews: works.filter(work => work.reviews.length).length,
      selectedReviews: reviews.length, cachedReviews: reviews.filter(review => review.status === 'cached').length,
      pendingReviews: reviews.filter(review => review.status === 'pending').length, reviewItems: reviews.filter(review => review.status === 'review').length },
    reviews };
}

/** Cached answers cost no attempt. A limit bounds UNCACHED review attempts, including errors. */
export async function runScopedQualityClaims(db: Database.Database, options: Options & { limit: number }, dependencies: {
  process?: typeof processQualityClaims; shouldStop?: () => boolean;
} = {}) {
  validateScope(options, true);
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error('--limit must be from 1 to 100.');
  const model = options.model ?? qualityClaimsModel(), works = selected(db, options);
  const before = qualityClaimsSummary(db, { ...options, model });
  const usage = { input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0 };
  let attempted = 0, completed = 0, cachedSkipped = 0, errors = 0, stopReason: string | null = null;
  const outcomes: { reviewId: string; workId: string; status: string }[] = [];
  for (const review of works.flatMap(work => work.reviews)) {
    if (dependencies.shouldStop?.()) { stopReason = 'interrupted'; break; }
    try {
      if (loadQualityClaims(db, review, { model })) { cachedSkipped++; continue; }
    } catch (error) {
      if (!(error instanceof ClaimsReviewError)) throw error;
      errors++; outcomes.push({ reviewId: review.id, workId: review.workId, status: 'retained-answer-needs-review' });
      continue;
    }
    if (attempted >= options.limit) { stopReason = 'limit'; break; }
    attempted++;
    try {
      const result = await (dependencies.process ?? processQualityClaims)(db, review, { model });
      usage.input_tokens += result.input_tokens; usage.output_tokens += result.output_tokens;
      usage.unknownUsageResponses += result.unknownUsageResponses; completed++;
      outcomes.push({ reviewId: review.id, workId: review.workId, status: result.cached ? 'replayed' : 'completed' });
    } catch (error) {
      if (error instanceof ClaimsReviewError || error instanceof ClaimsPaidStorageError) {
        usage.input_tokens += error.usage.input_tokens; usage.output_tokens += error.usage.output_tokens;
        usage.unknownUsageResponses += error.unknownUsageResponses;
      }
      errors++;
      const message = error instanceof Error ? error.message : '';
      stopReason = error instanceof PaidResponseStorageError ? 'paid-storage-failure'
        : error instanceof ClaimsTransactionError ? 'pre-spend-refusal'
          : /HTTP (401|403)/.test(message) || /Set OPENAI_API_KEY/.test(message) ? 'authentication'
            : /HTTP 429/.test(message) ? 'rate-limit' : /HTTP 4\d\d/.test(message) ? 'request-rejected' : null;
      outcomes.push({ reviewId: review.id, workId: review.workId, status: stopReason ?? (error instanceof ClaimsReviewError ? 'answer-needs-review' : 'request-failed') });
      if (stopReason) break;
    }
  }
  // A storage failure must not erase the paid tally merely because the final read also fails.
  let report = before, reportFresh = false;
  try { report = qualityClaimsSummary(db, { ...options, model }); reportFresh = true; }
  catch { stopReason ??= 'report-refresh-failed'; }
  return { ...report, run: { attempted, completed, cachedSkipped, errors, stopReason, reportFresh, tokens: usage, outcomes } };
}

/** --out is confined to the repository's ignored private data directory, including existing ancestors. */
export function qualityClaimsOutputPath(value: string, root = ROOT): string {
  const output = resolve(root, value), allowed = resolve(root, 'data/quality'), part = relative(allowed, output);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part) || extname(output) !== '.json')
    throw new Error('--out must be a .json file beneath data/quality/.');
  for (let current = output; current !== resolve(root); current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('--out cannot follow a symlink outside the private data directory.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return output;
}

export async function runQualityClaimsCli(args = process.argv.slice(2), dependencies: {
  databasePath?: string; root?: string; log?: (value: string) => void;
} = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    work: { type: 'string' }, series: { type: 'string' }, model: { type: 'string' },
    limit: { type: 'string', default: '12' }, out: { type: 'string' }, help: { type: 'boolean' }
  } });
  const log = dependencies.log ?? console.log, command = positionals[0] ?? 'report';
  if (values.help) {
    log(`Experimental claim comparison; not an input to quality scores.
  report [--work ID | --series ID]   read-only coverage and aspect/polarity summary
  run --work ID | --series ID --limit N
                                   at most N uncached review attempts (1–100; default 12)
  --model MODEL                     separately cached model experiment
  --out data/quality/NAME.json       optional private summary; source quotations stay in receipts
Cached answers replay free. Stored invalid answers need review and are never bought again.
No acquisition, migrations, deployment or ranking changes are performed.`);
    return;
  }
  if (!['report', 'run'].includes(command) || positionals.length > 1) throw new Error('Use claims report or run.');
  const scope = { work: values.work, series: values.series, model: values.model };
  validateScope(scope, command === 'run');
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be from 1 to 100.');
  const output = values.out ? qualityClaimsOutputPath(values.out, dependencies.root) : undefined;
  const databasePath = dependencies.databasePath ?? DB_PATH;
  // A report never opens a writable handle or runs migrations. A missing DB fails explicitly.
  const db = new Database(databasePath, { readonly: command === 'report', fileMustExist: true });
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  if (command === 'run') process.on('SIGINT', interrupt);
  try {
    const report = command === 'report' ? qualityClaimsSummary(db, scope)
      : await runScopedQualityClaims(db, { ...scope, limit }, { shouldStop: () => interrupted });
    log(JSON.stringify(report, null, 2));
    if (output) writeQualityReport(output, report, databasePath);
    if (command === 'run' && (report as Awaited<ReturnType<typeof runScopedQualityClaims>>).run.errors) process.exitCode = 1;
    return report;
  } finally { if (command === 'run') process.off('SIGINT', interrupt); db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runQualityClaimsCli().catch(error => {
    console.error(error instanceof Error && /^(?:run requires|Choose at most|No catalog works|--limit|--out|Use claims)/.test(error.message)
      ? error.message : 'Quality claims command failed. Check its scope, private output path, database and credentials; no source text is printed.');
    process.exitCode = 1;
  });
}
