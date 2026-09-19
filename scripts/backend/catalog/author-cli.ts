/**
 * Bounded author-profile runner. Every stage is explicit offline work: `plan` only queues
 * authors whose evidence already clears the deterministic gate, `show` inspects an author
 * without spending a token, and `run --confirm evidence` is a full dry run with no API call.
 */
import { parseArgs } from 'node:util';
import { getDb, closeDb } from '../db.js';
import { runMigrations } from '../migrate.js';
import { claim, fail, finish } from './queue.js';
import { authorFields, collectAuthorEvidence, planAuthorJobs, processAuthorProfile, summarizeAuthor } from './authors.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    limit: { type: 'string', default: '10' }, confirm: { type: 'string', default: 'jev' }, author: { type: 'string' }, help: { type: 'boolean' }
  } });
  const command = positionals[0] ?? 'status';
  if (values.help) {
    console.log('npm run pipeline:authors -- plan | run --limit 10 [--confirm evidence] | show --author <id> | status\n' +
      'plan queues only authors whose evidence already meets the threshold. run resumes queued jobs and reuses cached reviews. ' +
      '--confirm evidence records the deterministic verdict without calling Jev. show prints one author\'s evidence and spends nothing.');
  } else {
    runMigrations();
    const db = getDb();
    if (command === 'plan') console.log(`Queued ${planAuthorJobs(db)} author profile jobs.`);
    else if (command === 'show') {
      const evidence = collectAuthorEvidence(db);
      const author = values.author ? evidence.get(values.author) : undefined;
      if (!author) throw new Error(values.author ? `No catalog evidence for author ${values.author}.` : 'Pass --author <id>.');
      const summaries = summarizeAuthor(author);
      console.log(JSON.stringify({ author: { id: author.id, name: author.name, works: author.works.length },
        fields: Object.fromEntries(authorFields.map(f => [f, { samples: summaries[f].samples, positives: summaries[f].positives,
          negatives: summaries[f].negatives, share: summaries[f].share, ceiling: summaries[f].ceiling, series: summaries[f].positiveSeries, evidenceSource: summaries[f].evidenceSource, eligible: summaries[f].eligible }])),
        titles: author.works.map(w => ({ title: w.title, number: w.number, cover: w.cover?.level ?? null,
          signals: Object.fromEntries(authorFields.map(f => [f, `${w.signals[f].verdict}/${w.signals[f].confidence}/${w.signals[f].source}`])) })) }, null, 2));
    } else if (command === 'run') {
      const limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('--limit must be between 1 and 50.');
      if (!['jev', 'evidence'].includes(values.confirm!)) throw new Error('--confirm must be jev or evidence.');
      let stopped = false;
      process.on('SIGINT', () => { stopped = true; console.log('Stopping after the active job; remaining jobs are saved.'); });
      // One scan of the catalog serves the whole bounded run.
      const evidence = collectAuthorEvidence(db);
      const usage = { input_tokens: 0, output_tokens: 0 };
      let completed = 0, errors = 0;
      for (let i = 0; i < limit && !stopped; i++) {
        const job = claim(db, ['author-profile']);
        if (!job) break;
        try {
          const result = await processAuthorProfile(db, job.entity_id, { evidence, confirm: values.confirm as 'jev' | 'evidence' });
          finish(db, job, result);
          completed++;
          usage.input_tokens += result.input_tokens; usage.output_tokens += result.output_tokens;
          console.log(`author ${job.entity_id}: ${JSON.stringify(result)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Author profile job failed';
          fail(db, job, message); errors++;
          console.error(`author ${job.entity_id}: ${message}`);
          if (/HTTP (401|403|429)/.test(message)) break;
        }
      }
      console.log(JSON.stringify({ completed, errors, tokens: usage }));
    } else if (command === 'status') {
      console.log(JSON.stringify({
        jobs: db.prepare("SELECT status,COUNT(*) AS count FROM catalog_jobs WHERE kind='author-profile' GROUP BY status").all(),
        authors: db.prepare('SELECT COUNT(*) AS count FROM catalog_authors').get(),
        profiles: db.prepare(`SELECT a.name,p.field,p.verdict,p.confidence,p.signal_source,p.positive_count,p.sample_size,p.evaluated_at
          FROM catalog_author_profiles p JOIN catalog_authors a ON a.id=p.author_id ORDER BY p.evaluated_at DESC LIMIT 25`).all(),
        review: db.prepare("SELECT entity_id,last_error FROM catalog_jobs WHERE kind='author-profile' AND status IN ('review','failed')").all()
      }, null, 2));
    } else throw new Error('Unknown author command. Use --help.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Author command failed.');
  process.exitCode = 1;
} finally { closeDb(); }
