/**
 * Actual-model regression examples, deliberately isolated from the catalog.
 *
 * Default: readonly report. --run uses the exact production evidence/assessment path in the
 * fixed private data/quality/eval.db. No DB-path option and no CATALOG_DB_PATH handling exists.
 * The examples are invented and rubric-aware, not a blind holdout or real catalog evidence.
 * Paid answers remain cached when expectations or interpretation change; only changed model
 * inputs/questions/model require a new answer. This tool never imports or exports the catalog.
 */
import Database from 'better-sqlite3';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { hash } from '../catalog/queue.js';
import { JevPaidStorageError, JevReviewError, JevTransactionError } from '../catalog/paid-jev.js';
import { PaidResponseStorageError } from '../catalog/types.js';
import { qualityEvidenceFor, type QualityReview } from './evidence.js';
import { aspectDirection, loadReviewJudgement, processQualityReview, qualityAspects, qualityModel, qualityReviewHash,
  QUALITY_INTERPRETATION_VERSION, QUALITY_REVIEW_KIND, QUALITY_RUBRIC_VERSION,
  type QualityAspect, type QualityDirection, type ReviewJudgement } from './assessment.js';

const here = dirname(fileURLToPath(import.meta.url));
export const QUALITY_EVAL_DATABASE = resolve(here, '../../../data/quality/eval.db');
const fixturesFile = join(here, 'model-eval-fixtures.json');
const evalMarker = 'synthetic-quality-evaluation-only-v1';
type Polarity = 'positive' | 'negative' | 'mixed';
export interface ModelEvalFixture {
  id: string; description: string; text: string;
  expected: Partial<Record<QualityAspect, Polarity>>;
  /** Optional legitimate overlap. It is never counted as a required success. */
  allowedAdditional: Partial<Record<QualityAspect, Polarity[]>>;
  rationale: string;
}
export interface ModelEvalFixtures { version: string; provenance: string; fixtures: ModelEvalFixture[] }

export function validateModelEvalFixtures(value: unknown): ModelEvalFixtures {
  const data = value as ModelEvalFixtures;
  if (!data || typeof data.version !== 'string' || !data.version || typeof data.provenance !== 'string' ||
    !data.provenance.includes('not real reviews') || !Array.isArray(data.fixtures) || data.fixtures.length < 12 || data.fixtures.length > 16) {
    throw new Error('Quality eval needs 12–16 explicitly synthetic fixtures with a version and provenance.');
  }
  const ids = new Set<string>();
  const polarity = (v: unknown) => ['positive', 'negative', 'mixed'].includes(String(v));
  for (const fixture of data.fixtures) {
    if (!fixture || typeof fixture.id !== 'string' || !/^[a-z][a-z0-9-]{2,80}$/.test(fixture.id) || ids.has(fixture.id) ||
      typeof fixture.text !== 'string' || fixture.text.length < 40 || fixture.text.length > 12_000 ||
      typeof fixture.description !== 'string' || !fixture.description || typeof fixture.rationale !== 'string' || !fixture.rationale ||
      !fixture.expected || Array.isArray(fixture.expected) || typeof fixture.expected !== 'object' ||
      !fixture.allowedAdditional || Array.isArray(fixture.allowedAdditional) || typeof fixture.allowedAdditional !== 'object') {
      throw new Error('Malformed or repeated quality eval fixture.');
    }
    ids.add(fixture.id);
    for (const [aspect, expected] of Object.entries(fixture.expected)) {
      if (!qualityAspects.includes(aspect as QualityAspect) || !polarity(expected)) throw new Error(`Invalid expectation in ${fixture.id}.`);
    }
    for (const [aspect, allowed] of Object.entries(fixture.allowedAdditional)) {
      if (!qualityAspects.includes(aspect as QualityAspect) || aspect in fixture.expected || !Array.isArray(allowed) ||
        !allowed.length || allowed.some(v => !polarity(v)) || new Set(allowed).size !== allowed.length) {
        throw new Error(`Invalid secondary allowance in ${fixture.id}.`);
      }
    }
  }
  return data;
}
export const loadModelEvalFixtures = () => validateModelEvalFixtures(JSON.parse(readFileSync(fixturesFile, 'utf8')));

/** Same text keeps the same paid identity if only an expected answer is corrected. */
function identity(fixture: ModelEvalFixture) {
  const key = `${fixture.id}-${hash(['invented-quality-example', fixture.id, fixture.text]).slice(0, 16)}`;
  return { series: `quality-eval-series-${key}`, work: `quality-eval-work-${key}`, review: `quality-eval-review-${key}`, key };
}

function assertEvalDatabase(db: Database.Database, allowEmpty = false) {
  // The memory path exists only for credential-free mechanical tests. On disk there is exactly
  // one accepted path, and an existing unmarked database is refused BEFORE migrations or writes.
  if (db.name !== ':memory:' && resolve(db.name) !== QUALITY_EVAL_DATABASE) throw new Error('Refusing a database outside the isolated quality eval path.');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  if (!tables.length && allowEmpty) return;
  if (!tables.some(t => t.name === 'quality_eval_meta') ||
    (db.prepare("SELECT value FROM quality_eval_meta WHERE key='purpose'").get() as { value?: string } | undefined)?.value !== evalMarker) {
    throw new Error('Refusing an existing database without the synthetic quality-eval marker.');
  }
}

/** Only --run calls this on disk. No pipeline/getDb helper is imported, so the live DB is unreachable. */
export function prepareModelEvalDatabase(db: Database.Database, fixtures: ModelEvalFixtures) {
  assertEvalDatabase(db, true);
  validateModelEvalFixtures(fixtures);
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS quality_eval_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_eval_migrations(name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS quality_eval_runs(id TEXT PRIMARY KEY,recorded_at TEXT NOT NULL,report_json TEXT NOT NULL);`);
    db.prepare("INSERT OR IGNORE INTO quality_eval_meta VALUES('purpose',?)").run(evalMarker);
    const applied = new Set((db.prepare('SELECT name FROM quality_eval_migrations').all() as { name: string }[]).map(r => r.name));
    // Use the real schema without runMigrations(), whose global getDb() would open the catalog.
    for (const file of readdirSync(join(here, '../migrations')).filter(f => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      db.exec(readFileSync(join(here, '../migrations', file), 'utf8'));
      db.prepare('INSERT INTO quality_eval_migrations VALUES(?)').run(file);
    }
    for (const fixture of fixtures.fixtures) {
      const ids = identity(fixture), stamp = '2026-01-01T00:00:00.000Z';
      const metadata = JSON.stringify({ synthetic: true, qualityEvalOnly: true, fixture: fixture.id });
      db.prepare(`INSERT OR IGNORE INTO catalog_series(id,title,author,metadata_json,updated_at)
        VALUES(?,?,'Synthetic Evaluation Author',?,?)`).run(ids.series, `Synthetic evaluation ${fixture.id}`, metadata, stamp);
      db.prepare(`INSERT OR IGNORE INTO catalog_works(id,series_id,number,title,author,source_url,metadata_json,updated_at)
        VALUES(?,?,1,?,'Synthetic Evaluation Author',?,?,?)`)
        .run(ids.work, ids.series, `Invented example ${fixture.id}`, `https://example.com/quality-evaluation/${fixture.id}`, metadata, stamp);
      db.prepare(`INSERT OR IGNORE INTO catalog_reader_evidence(id,series_id,work_id,source_url,external_id,body,contains_spoilers,
        observed_at,source_name,author_key,rating,rating_best,published_at,kind)
        VALUES(?,?,?,?,?,?,0,?,'synthetic-evaluation',?,NULL,NULL,'2026-01-01','review')`)
        .run(ids.review, ids.series, ids.work, `https://example.com/quality-evaluation/${fixture.id}`, ids.key, fixture.text,
          stamp, `quality-eval-voice-${ids.key}`);
    }
  })();
}

type EvalObserved = Partial<Record<QualityAspect, { polarity: QualityDirection; grade: string; score: number; confidence: number }>>;
export interface ModelEvalCaseResult {
  id: string; description: string; status: 'pending' | 'pass' | 'fail' | 'review';
  expected: ModelEvalFixture['expected']; allowedAdditional: ModelEvalFixture['allowedAdditional'];
  observed: EvalObserved;
  failures: { aspect: QualityAspect; expected: string; actual: string; reason: string }[];
  withheld?: ReviewJudgement['withheld'];
  receiptId?: string; inputHash?: string; actualModel?: string; retainedResponse?: boolean; error?: string;
}

/** Only accepted post-interpretation aspects count. A vague/uncertain required result is a miss. */
export function evaluateModelEvalFixture(fixture: ModelEvalFixture, judgement: ReviewJudgement): ModelEvalCaseResult {
  const observed: EvalObserved = {};
  for (const aspect of qualityAspects) {
    const found = judgement.aspects[aspect];
    if (!found) continue;
    observed[aspect] = { polarity: aspectDirection(found),
      grade: found.grade, score: found.score, confidence: found.confidence };
  }
  const failures: ModelEvalCaseResult['failures'] = [];
  for (const aspect of qualityAspects) {
    const expected = fixture.expected[aspect], actual = observed[aspect]?.polarity;
    if (expected && actual !== expected) failures.push({ aspect, expected, actual: actual ?? 'unknown', reason: 'Required aspect/polarity was not accepted.' });
    if (!expected && actual && !fixture.allowedAdditional[aspect]?.some(allowed => allowed === actual)) {
      failures.push({ aspect, expected: fixture.allowedAdditional[aspect]?.join('|') ?? 'unknown', actual, reason: 'Unexpected aspect or polarity was accepted.' });
    }
  }
  return { id: fixture.id, description: fixture.description, status: failures.length ? 'fail' : 'pass',
    expected: fixture.expected, allowedAdditional: fixture.allowedAdditional, observed, failures,
    ...(judgement.withheld ? { withheld: judgement.withheld } : {}), receiptId: judgement.receiptId,
    inputHash: judgement.inputHash, actualModel: judgement.model };
}

function reviewFor(db: Database.Database, fixture: ModelEvalFixture): QualityReview | null {
  const ids = identity(fixture);
  if (!db.prepare('SELECT 1 FROM catalog_works WHERE id=?').get(ids.work)) return null;
  return qualityEvidenceFor(db, ids.work).reviews.find(r => r.id === ids.review) ?? null;
}

export function modelEvalReport(db: Database.Database | null, fixtures = loadModelEvalFixtures(), model = qualityModel()) {
  validateModelEvalFixtures(fixtures);
  if (db) assertEvalDatabase(db);
  const cases: ModelEvalCaseResult[] = fixtures.fixtures.map(fixture => {
    const pending: ModelEvalCaseResult = { id: fixture.id, description: fixture.description, status: 'pending',
      expected: fixture.expected, allowedAdditional: fixture.allowedAdditional, observed: {}, failures: [] };
    if (!db) return pending;
    try {
      const review = reviewFor(db, fixture);
      if (!review) return pending;
      const judgement = loadReviewJudgement(db, review, { model });
      if (judgement) return evaluateModelEvalFixture(fixture, judgement);
      const inputHash = qualityReviewHash(review, model);
      const retainedResponse = !!db.prepare('SELECT 1 FROM catalog_inferences WHERE id=?')
        .get(hash(['reader-evidence', review.id, `${QUALITY_REVIEW_KIND}-wire`, inputHash]));
      return { ...pending, inputHash, retainedResponse };
    } catch (error) { return { ...pending, status: 'review', error: error instanceof Error ? error.message : 'Retained answer could not be used.' }; }
  });
  const counts = { pass: 0, fail: 0, pending: 0, review: 0 };
  for (const result of cases) counts[result.status]++;
  return { version: 'quality-model-eval-report-v1', generatedAt: new Date().toISOString(),
    fixtureVersion: fixtures.version, fixtureHash: hash(fixtures), rubricVersion: QUALITY_RUBRIC_VERSION,
    interpretationVersion: QUALITY_INTERPRETATION_VERSION, requestedModel: model,
    methodology: 'Invented, rubric-aware regression examples; not a blind holdout, prevalence estimate, or proof of real-catalog accuracy. Secondary allowances are declared before the run. Star ratings are absent. No fixture is catalog evidence.',
    counts, evaluated: counts.pass + counts.fail, cases };
}

export async function runModelEvaluation(db: Database.Database, fixtures: ModelEvalFixtures, options: {
  model?: string; limit?: number; evaluate?: NonNullable<Parameters<typeof processQualityReview>[2]>['evaluate'];
} = {}) {
  assertEvalDatabase(db);
  if (options.evaluate && db.name !== ':memory:') throw new Error('Injected evaluators are allowed only in temporary in-memory tool tests, never the persistent actual-model cache.');
  const limit = options.limit ?? fixtures.fixtures.length;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > fixtures.fixtures.length) throw new Error('Eval limit must be between 1 and the fixture count.');
  const model = options.model ?? qualityModel(), usage = { input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0 };
  const errors: { fixture: string; error: string }[] = [];
  let attempted = 0, cached = 0, bought = 0;
  for (const fixture of fixtures.fixtures) {
    const review = reviewFor(db, fixture);
    if (!review) throw new Error(`Eval fixture ${fixture.id} was not prepared or is excluded by current evidence rules.`);
    try {
      if (loadReviewJudgement(db, review, { model })) { cached++; continue; }
    } catch (error) { errors.push({ fixture: fixture.id, error: error instanceof Error ? error.message : 'Invalid cached result.' }); continue; }
    if (attempted >= limit) continue;
    attempted++;
    const inputHash = qualityReviewHash(review, model);
    const hasReceipt = () => !!db.prepare('SELECT 1 FROM catalog_inferences WHERE id IN (?,?)')
      .get(hash(['reader-evidence', review.id, QUALITY_REVIEW_KIND, inputHash]),
        hash(['reader-evidence', review.id, `${QUALITY_REVIEW_KIND}-wire`, inputHash]));
    const retainedBefore = hasReceipt();
    try {
      const result = await processQualityReview(db, review, { model, evaluate: options.evaluate });
      usage.input_tokens += result.input_tokens; usage.output_tokens += result.output_tokens;
      usage.unknownUsageResponses += result.unknownUsageResponses;
      if (result.cached) cached++; else bought++;
    } catch (error) {
      if (error instanceof JevReviewError || error instanceof JevPaidStorageError) {
        usage.input_tokens += error.usage.input_tokens; usage.output_tokens += error.usage.output_tokens;
        usage.unknownUsageResponses += error.unknownUsageResponses;
      }
      // A rejected paid response is still a purchase. Its new receipt identifies that fact
      // even when usage is honestly 0/0; replayed errors and non-2xx transport failures do not.
      if (error instanceof JevPaidStorageError || (!retainedBefore && hasReceipt())) bought++;
      const message = error instanceof Error ? error.message : 'Quality model eval failed.';
      errors.push({ fixture: fixture.id, error: message });
      if (error instanceof PaidResponseStorageError || error instanceof JevTransactionError || /HTTP (401|403|429)/.test(message)) break;
    }
  }
  const result = { ...modelEvalReport(db, fixtures, model), run: { attempted, cached, bought, usage, errors } };
  // Append the report; never rewrite a previous expectation or raw model receipt.
  db.prepare('INSERT INTO quality_eval_runs VALUES(?,?,?)').run(randomUUID(), new Date().toISOString(), JSON.stringify(result));
  return result;
}

export async function runQualityModelEvalCli(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { run: { type: 'boolean' }, report: { type: 'boolean' },
    model: { type: 'string' }, limit: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log(`Quality model regression eval (synthetic examples, isolated private database)
  node --env-file-if-exists=.env --import tsx scripts/backend/quality/model-eval.ts --report
  node --env-file-if-exists=.env --import tsx scripts/backend/quality/model-eval.ts --run [--limit 16] [--model MODEL]

Default --report is read-only and makes no model calls. --run prepares only data/quality/eval.db,
retains each paid response, and resumes missing judgments. Changed expected outcomes re-use the
same answers. There is no database-path override and nothing here feeds the public catalog.
These are rubric-aware invented regression tests, not a blind holdout or real series benchmarks.`);
    return;
  }
  if (values.run && values.report) throw new Error('Choose --run or --report, not both.');
  const fixtures = loadModelEvalFixtures(), model = values.model ?? qualityModel();
  const limit = values.limit === undefined ? fixtures.fixtures.length : Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > fixtures.fixtures.length) throw new Error('--limit must be between 1 and the fixture count.');
  if (existsSync(QUALITY_EVAL_DATABASE) && lstatSync(QUALITY_EVAL_DATABASE).isSymbolicLink()) throw new Error('Refusing a symlink at the isolated eval database path.');
  if (!values.run && !existsSync(QUALITY_EVAL_DATABASE)) { console.log(JSON.stringify(modelEvalReport(null, fixtures, model), null, 2)); return; }
  if (values.run) mkdirSync(dirname(QUALITY_EVAL_DATABASE), { recursive: true });
  const db = new Database(QUALITY_EVAL_DATABASE, values.run ? {} : { readonly: true, fileMustExist: true });
  try {
    if (values.run) prepareModelEvalDatabase(db, fixtures);
    const runReport = values.run ? await runModelEvaluation(db, fixtures, { model, limit }) : null;
    const report = runReport ?? modelEvalReport(db, fixtures, model);
    console.log(JSON.stringify(report, null, 2));
    if (report.counts.fail || report.counts.review || runReport?.run.errors.length) process.exitCode = 1;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runQualityModelEvalCli().catch(error => { console.error(error instanceof Error ? error.message : 'Quality model eval failed.'); process.exitCode = 1; });
}
