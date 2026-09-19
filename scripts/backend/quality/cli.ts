import Database from 'better-sqlite3';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDb, closeDb, DB_PATH } from '../db.js';
import { runMigrations } from '../migrate.js';
import { claim, fail, finish } from '../catalog/queue.js';
import { PaidResponseStorageError, ReviewError } from '../catalog/types.js';
import { JevPaidStorageError, JevReviewError, JevTransactionError } from '../catalog/paid-jev.js';
import { buildQualityIndex, planQualityJobs, processQualityJob, QUALITY_JOB_KIND } from './pipeline.js';
import { persistQualityIndex, writeQualityReport } from './store.js';
import { benchmarkQuality } from './benchmark.js';

export async function runQualityCli(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    series: { type: 'string' }, work: { type: 'string' }, author: { type: 'string' }, model: { type: 'string' },
    limit: { type: 'string', default: '12' }, out: { type: 'string' }, help: { type: 'boolean' }
  } });
  const command = positionals[0] ?? 'status';
  if (values.help) {
    console.log(`Quality index (stars excluded)
  plan [--series ID | --work ID]     queue one retained review per resumable job
  run --limit 12 [--series ID]       buy at most N review assessments; retained answers replay free
  score [--out data/quality/index.json]
                                    append a versioned snapshot from CURRENT cached evidence
  export --out PATH                 read-only safe projection; no migrations, model calls or DB writes
  benchmark [--out PATH]            evaluate subjective anchors and synthetic controls without fitting
  status                           current work coverage and quality job counts
  show --work ID | --series ID | --author ID
                                    current score breakdown and evidence coverage for one entity
  --model MODEL                    explicit Jev model for a separately cached experiment

Scores are provisional review-evidence estimates, not manuscript grades. Audio performance,
content fit, renown and release cadence remain identifiable. Missing evidence never becomes zero.
Default outputs are private; exporting a file does not deploy or change the site's ranking.`);
    return;
  }
  if (!['plan', 'run', 'score', 'export', 'benchmark', 'status', 'show'].includes(command)) throw new Error('Unknown quality command. Use --help.');
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be from 1 to 1000.');
  if (command === 'run' && values.work) throw new Error('Use --series for run scope; --work is supported by plan.');
  const mutates = ['plan', 'run', 'score'].includes(command);
  if (mutates) runMigrations();
  const db = mutates ? getDb() : new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    if (command === 'plan') {
      console.log(JSON.stringify(planQualityJobs(db, { seriesId: values.series, workId: values.work, model: values.model })));
    } else if (command === 'run') {
      let stopped = false;
      const stop = () => { stopped = true; };
      process.on('SIGINT', stop);
      const usage = { input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0 };
      let completed = 0, errors = 0;
      try {
        for (let n = 0; n < limit && !stopped; n++) {
          const job = claim(db, [QUALITY_JOB_KIND], new Date(), values.series);
          if (!job) break;
          try {
            const payload = JSON.parse(job.payload_json) as Parameters<typeof processQualityJob>[1];
            const result = await processQualityJob(db, payload);
            usage.input_tokens += result.input_tokens; usage.output_tokens += result.output_tokens;
            usage.unknownUsageResponses += result.unknownUsageResponses;
            // Cost is counted before a queue write can fail; private judgments stay in receipts.
            finish(db, job, 'judgement' in result ? { cached: result.cached, inputHash: result.judgement.inputHash,
              aspects: Object.keys(result.judgement.aspects), input_tokens: result.input_tokens,
              output_tokens: result.output_tokens, unknownUsageResponses: result.unknownUsageResponses } : result);
            completed++;
            console.log(JSON.stringify({ review: job.entity_id, completed, cached: 'cached' in result && result.cached }));
          } catch (error) {
            if (error instanceof JevReviewError || error instanceof JevPaidStorageError) {
              usage.input_tokens += error.usage.input_tokens; usage.output_tokens += error.usage.output_tokens;
              usage.unknownUsageResponses += error.unknownUsageResponses;
            }
            errors++;
            const message = error instanceof Error ? error.message : 'Quality assessment failed.';
            fail(db, job, message, error instanceof ReviewError);
            console.error(JSON.stringify({ review: job.entity_id, error: message }));
            if (error instanceof PaidResponseStorageError || error instanceof JevTransactionError || /HTTP (401|403|429)/.test(message)) break;
          }
        }
      } finally {
        process.off('SIGINT', stop);
        console.log(JSON.stringify({ completed, errors, tokens: usage }));
      }
      if (errors) process.exitCode = 1;
    } else {
      const report = buildQualityIndex(db, { model: values.model });
      if (command === 'show') {
        if ([values.work, values.series, values.author].filter(Boolean).length !== 1) throw new Error('Choose exactly one --work, --series or --author ID.');
        const result = values.work ? report.books.find(b => b.id === values.work)
          : values.series ? report.series.find(s => s.id === values.series) : report.authors.find(a => a.id === values.author);
        if (!result) throw new Error('No quality record for that identity.');
        console.log(JSON.stringify(result, null, 2));
      } else if (command === 'status') {
        console.log(JSON.stringify({ ...report.totals,
          jobs: db.prepare('SELECT status,COUNT(*) AS count FROM catalog_jobs WHERE kind=? GROUP BY status').all(QUALITY_JOB_KIND),
          scored: report.books.filter(b => b.craft.score !== null).map(b => ({ id: b.id, title: b.title, craft: b.craft.score,
            index: b.index.score, confidence: b.craft.confidence, dimensions: b.craft.dimensions.length,
            voices: b.craft.relevantVoices })) }, null, 2));
      } else if (command === 'benchmark') {
        const results = benchmarkQuality(report);
        writeQualityReport(values.out ?? 'data/quality/benchmark.json', results, DB_PATH);
        console.log(JSON.stringify(results, null, 2));
      } else {
        if (!report.books.length) throw new Error('Refusing to write an empty canonical quality index.');
        const runId = command === 'score' ? persistQualityIndex(db, report) : null;
        writeQualityReport(values.out ?? 'data/quality/index.json', report, DB_PATH);
        console.log(JSON.stringify({ runId, version: report.version, ...report.totals, out: values.out ?? 'data/quality/index.json' }));
      }
    }
  } finally { if (mutates) closeDb(); else db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runQualityCli().catch(error => { console.error(error instanceof Error ? error.message : 'Quality command failed.'); process.exitCode = 1; closeDb(); });
}
