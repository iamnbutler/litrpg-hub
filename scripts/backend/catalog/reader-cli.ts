/**
 * Bounded reader-evidence runner.
 *
 * `import-cached` reads pages the source pipeline already fetched and never touches the
 * network. `import-hardcover` takes explicit targets only — there is no bulk discovery — and
 * resolves from a durable snapshot at zero HTTP until the snapshot expires. `plan` and `run`
 * use the same durable queue as the rest of the catalog, so an interrupted run resumes.
 */
import { parseArgs } from 'node:util';
import { getDb, closeDb } from '../db.js';
import { runMigrations } from '../migrate.js';
import { claim, defer, fail, finish } from './queue.js';
import {
  importReaderEvidence, planReaderTraitJobs, processReaderObservation, processReaderTraits, readerContext,
  LEGACY_READER_JOB_KINDS, ObservationReviewError, observationStatus, ReaderPaidStorageError, ReaderTransactionError, readerEvidenceFor, readerJobKinds, summarizeReaderEvidence, surveyReaderEvidence
} from './reader-evidence.js';
import { CORRECTIONS_CONFIG, CORRECTIONS_DRAFT, isApproved, loadCorrections } from './reader-corrections.js';
import { PaidResponseStorageError, ReviewError } from './types.js';
import { JevPaidStorageError, JevReviewError, JevTransactionError } from './paid-jev.js';
import { importHardcoverReviews, MAX_REVIEWS, RetryableError } from './hardcover-reader.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    title: { type: 'string' }, author: { type: 'string' }, entity: { type: 'string' },
    scope: { type: 'string', default: 'work' }, limit: { type: 'string', default: '10' },
    force: { type: 'boolean' }, draft: { type: 'boolean' }, help: { type: 'boolean' }
  } });
  const command = positionals[0] ?? 'status';
  const scope = values.scope === 'series' ? 'series' as const : 'work' as const;
  if (values.help) {
    console.log(`npm run pipeline:readers -- <command>

  import-cached                      import reviews from already-cached publisher pages; never fetches
  import-hardcover --title T --author A [--limit ${MAX_REVIEWS}] [--force]
                                     one explicit book over the official API; reuses a 30-day snapshot
  plan [--scope work|series]         queue trait jobs, only for entities above the evidence threshold
  run --limit 10 [--scope work]      work the queue; refuses to spend a call below the threshold
  status [--scope work]              evidence and eligibility per entity
  show --entity <id> [--scope work]  the export-safe context for one entity
  corrections [--scope work] [--draft]
                                     what each context publishes, and why; checks the approved
                                     config against its retained receipts before you rely on it

Reader opinion is never written to a book's content signals.`);
  } else {
    runMigrations();
    const db = getDb();
    if (command === 'import-cached') {
      console.log(JSON.stringify(importReaderEvidence(db)));
    } else if (command === 'import-hardcover') {
      if (!values.title || !values.author) throw new Error('Pass --title and --author; there is no bulk discovery here.');
      const limit = Number(values.limit === '10' ? MAX_REVIEWS : values.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REVIEWS) throw new Error(`--limit must be between 1 and ${MAX_REVIEWS}.`);
      for (const result of await importHardcoverReviews(db, [{ title: values.title, author: values.author }], { limit, force: values.force })) {
        console.log(JSON.stringify(result));
      }
    } else if (command === 'plan') {
      console.log(`Queued ${planReaderTraitJobs(db, scope)} reader trait jobs.`);
    } else if (command === 'run') {
      const limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('--limit must be between 1 and 50.');
      let stopped = false;
      process.on('SIGINT', () => { stopped = true; console.log('Stopping after the active job; remaining jobs are saved.'); });
      // Tracked beside the token totals: a paid response that never said what it cost must not
      // be summarised as a free one.
      const usage = { input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0 };
      let completed = 0, errors = 0;
      // Scope is in the kind, so claim filters it in SQL and nothing out of scope is ever held.
      try {
        for (let i = 0; i < limit && !stopped; i++) {
          const job = claim(db, readerJobKinds(scope));
          if (!job) break;
          const payload = JSON.parse(job.payload_json) as { entityType: 'series' | 'work'; entityId: string };
          try {
            const result = job.kind.startsWith('reader-observation')
              ? await processReaderObservation(db, payload.entityType, payload.entityId)
              : await processReaderTraits(db, payload.entityType, payload.entityId);
            // The result already exists even if marking its queue job complete fails.
            usage.input_tokens += result.input_tokens; usage.output_tokens += result.output_tokens;
            usage.unknownUsageResponses += result.unknownUsageResponses;
            finish(db, job, result);
            completed++;
            console.log(`reader ${job.entity_id}: ${JSON.stringify(result)}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Reader trait job failed';
            // A rejected answer was still paid for; do not report the run as free.
            // Trait jobs report through the shared Jev classes and observation jobs through their
            // own; either way a rejected answer was paid for and the run must not look free.
            if (error instanceof ObservationReviewError || error instanceof ReaderPaidStorageError
              || error instanceof JevReviewError || error instanceof JevPaidStorageError) {
              usage.input_tokens += error.usage.input_tokens; usage.output_tokens += error.usage.output_tokens;
              usage.unknownUsageResponses += error.unknownUsageResponses;
            }
            // A source that named a time is deferred to exactly that time, keeping its attempt.
            // An archived answer that still fails validation is a review item: retrying it would
            // re-judge the same bytes and reach the same verdict.
            errors++;
            if (error instanceof RetryableError) defer(db, job, message, new Date(Date.now() + error.retryAfterMs));
            else fail(db, job, message, error instanceof ReviewError);
            console.error(`reader ${job.entity_id}: ${message}`);
            // A paid answer that could not be stored stops the run: every further job would risk
            // buying an answer we cannot keep either.
            if (/HTTP (401|403|429)/.test(message) || error instanceof RetryableError || error instanceof PaidResponseStorageError || error instanceof ReaderTransactionError || error instanceof JevTransactionError) break;
          }
        }
      } finally {
        // Even a queue write failure must not suppress the cost of a response already received.
        console.log(JSON.stringify({ completed, errors, tokens: usage }));
      }
    } else if (command === 'status') {
      console.log(JSON.stringify({
        jobs: db.prepare("SELECT kind,status,COUNT(*) AS count FROM catalog_jobs WHERE kind LIKE 'reader-%' GROUP BY kind,status").all(),
        legacyKinds: LEGACY_READER_JOB_KINDS,
        evidence: db.prepare('SELECT source_name, COUNT(*) AS count, COUNT(DISTINCT author_key) AS voices FROM catalog_reader_evidence WHERE removed_at IS NULL GROUP BY source_name').all(),
        snapshots: db.prepare("SELECT COUNT(*) AS count FROM catalog_documents WHERE url LIKE 'reader-snapshot://%'").get(),
        entities: surveyReaderEvidence(db, scope).map(s => ({ entity: s.entity, voices: s.voices, substantiveVoices: s.substantiveVoices, eligible: s.eligible, reason: s.reason })),
        traits: db.prepare('SELECT COUNT(*) AS count FROM catalog_reader_traits').get()
      }, null, 2));
    } else if (command === 'show') {
      if (!values.entity) throw new Error('Pass --entity <id>.');
      const context = readerContext(db, scope, values.entity);
      if (!context) throw new Error(`No reader evidence for ${values.entity}.`);
      console.log(JSON.stringify({ ...context, summary: summarizeReaderEvidence(values.entity, readerEvidenceFor(db, scope, values.entity)) }, null, 2));
    } else if (command === 'corrections') {
      // Reads the same diagnostic the exporter uses, so this can never report a correction as
      // live when export would refuse it.
      const approved = loadCorrections();
      const entities = surveyReaderEvidence(db, scope).filter(e => e.eligible);
      const report = entities.map(e => {
        const status = observationStatus(db, scope, e.entity, readerEvidenceFor(db, scope, e.entity), { corrections: approved });
        return { entity: status.entity, status: status.status, reason: status.reason };
      });
      const claimed = new Set(report.map(r => r.entity));
      console.log(JSON.stringify({
        config: CORRECTIONS_CONFIG,
        approved: approved.length,
        unreviewed: approved.filter(c => !isApproved(c)).length,
        orphaned: approved.filter(c => !claimed.has(`${c.entityType}:${c.entityId}`)).map(c => `${c.entityType}:${c.entityId}`),
        counts: report.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {}),
        contexts: report,
        ...(values.draft ? { draft: CORRECTIONS_DRAFT, proposals: loadCorrections(CORRECTIONS_DRAFT).map(c => ({ entity: `${c.entityType}:${c.entityId}`, reviewedAt: c.reviewedAt, observation: c.observation })) } : {})
      }, null, 2));
    } else throw new Error('Unknown reader command. Use --help.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Reader command failed.');
  process.exitCode = 1;
} finally { closeDb(); }
