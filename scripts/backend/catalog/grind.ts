import type Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { audioProductUrl, planAudio, processAudio } from './audio.js';
import { processIdentifiedAudio } from './identified-audio.js';
import { processSource, seeds } from './pipeline.js';
import { claim, defer, enqueue, fail, finish, hash, type Job } from './queue.js';
import { PaidResponseStorageError, ReviewError, type AudioPayload, type IdentifiedAudioPayload, type SeedSeries, type SourcePayload } from './types.js';

export type GrindStage = 'sources' | 'audio' | 'extract' | 'assess';
export type GrindLimits = Record<GrindStage, number>;
export const DEFAULT_GRIND_LIMITS: Readonly<GrindLimits> = { sources: 25, audio: 25, extract: 25, assess: 25 };
const stages: GrindStage[] = ['sources', 'audio', 'extract', 'assess'];
const kinds: Record<GrindStage, string[]> = {
  sources: ['source'], audio: ['audio-edition', 'identified-audio'], extract: ['describe-series', 'extract'], assess: ['assess']
};
type Tokens = { input_tokens: number; output_tokens: number };
type StopReason = 'drained' | 'limit' | 'disabled' | 'interrupted' | 'authentication' | 'rate-limit' | 'configuration' | 'storage' | 'paid-stop';
type Remaining = { pending: number; retry: number; running: number; review: number; failed: number; total: number };
export interface GrindStageSummary {
  limit: number;
  attempted: number;
  completed: number;
  errors: number;
  review: number;
  deferred: number;
  tokens: Tokens;
  stopReason: StopReason;
  remaining: Remaining;
}
export interface GrindSummary {
  startedAt: string;
  finishedAt: string;
  seriesId: string | null;
  enrich: boolean;
  refresh: boolean;
  interrupted: boolean;
  paidStopped: boolean;
  planned: { refresh: number; audio: number; inference: number };
  completed: number;
  errors: number;
  review: number;
  deferred: number;
  tokens: Tokens;
  stages: Record<GrindStage, GrindStageSummary>;
}
export interface GrindOptions {
  seriesId?: string;
  enrich?: boolean;
  refresh?: boolean;
  limits?: Partial<GrindLimits>;
  /** Stop between jobs. The active request retains its own timeout and may finish saving. */
  signal?: AbortSignal;
}
export interface GrindHooks {
  registry?: readonly SeedSeries[];
  now?: () => Date;
  source?: (db: Database.Database, payload: SourcePayload) => Promise<unknown>;
  audio?: (db: Database.Database, payload: AudioPayload, selected: SeedSeries[]) => Promise<unknown>;
  identifiedAudio?: (db: Database.Database, payload: IdentifiedAudioPayload, selected: SeedSeries[]) => Promise<unknown>;
  extract?: (db: Database.Database, entity: string, kind: 'extract' | 'describe-series', payload: Record<string, unknown>) => Promise<unknown>;
  assess?: (db: Database.Database, entity: string, seed: SeedSeries) => Promise<unknown>;
  planAudio?: (db: Database.Database, selected: SeedSeries[]) => number | Promise<number>;
  planInference?: (db: Database.Database, selected: SeedSeries[]) => number | Promise<number>;
}

const emptyTokens = (): Tokens => ({ input_tokens: 0, output_tokens: 0 });
const emptyRemaining = (): Remaining => ({ pending: 0, retry: 0, running: 0, review: 0, failed: 0, total: 0 });
const selectedScope = (seriesId?: string) => seriesId === undefined ? { sql: '', args: [] as string[] } : {
  sql: " AND (json_extract(payload_json,'$.seriesId')=? OR entity_id=? OR entity_id IN (SELECT id FROM catalog_works WHERE series_id=?))",
  args: [seriesId, seriesId, seriesId]
};

class GrindOptionError extends Error {}
function checkedOptions(options: GrindOptions, registry: readonly SeedSeries[]) {
  const limits = { ...DEFAULT_GRIND_LIMITS, ...options.limits };
  for (const stage of stages) {
    if (!Number.isInteger(limits[stage]) || limits[stage] < 0 || limits[stage] > 300) {
      throw new GrindOptionError(`${stage} limit must be an integer from 0 to 300.`);
    }
  }
  const selected = registry.filter(seed => options.seriesId === undefined || seed.id === options.seriesId);
  if (!selected.length) throw new GrindOptionError('No configured series matches the exact selected series ID.');
  return { limits, selected };
}

function payloadOf(job: Pick<Job, 'payload_json'>): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(job.payload_json);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Do not copy source text from a JSON parser error into a log. */ }
  throw new ReviewError('The queued catalog payload needs review.');
}

/** Explicit refresh creates another attempt without erasing completed or review history.
 * Any unresolved sibling blocks it: refresh is never a shortcut around backoff or review. */
function scheduleDue(db: Database.Database, now: Date, seriesId?: string): number {
  const scope = selectedScope(seriesId);
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id,kind,entity_id,payload_json,status,priority FROM catalog_jobs
      WHERE kind IN ('source','audio-edition','identified-audio')${scope.sql} ORDER BY updated_at DESC,created_at DESC,id`)
      .all(...scope.args) as (Pick<Job, 'id' | 'kind' | 'entity_id' | 'payload_json'> & { status: string; priority: number })[];
    const entities = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.kind}:${row.entity_id}`;
      (entities.get(key) ?? entities.set(key, []).get(key)!).push(row);
    }
    let added = 0;
    for (const siblings of entities.values()) {
      if (siblings.some(job => job.status !== 'completed')) continue;
      const job = siblings[0], payload = payloadOf(job);
      const url = job.kind === 'source' ? job.entity_id : audioProductUrl(String(payload.asin ?? ''));
      const saved = db.prepare('SELECT document_id,checked_at,next_check_at FROM catalog_urls WHERE url=?').get(url) as
        { document_id: string; checked_at: string; next_check_at: string } | undefined;
      // A missing/invalid source observation needs a review, not an invented refresh date.
      if (!saved || !Number.isFinite(Date.parse(saved.next_check_at)) || Date.parse(saved.next_check_at) > now.getTime()) continue;
      const inputHash = hash({ version: 'catalog-grind-refresh-v1', previous: job.id,
        document: saved.document_id, observedAt: saved.checked_at, dueAt: saved.next_check_at });
      added += Number(enqueue(db, job.kind, job.entity_id, inputHash, payload, job.priority, now));
    }
    return added;
  }).immediate();
}

function remaining(db: Database.Database, stage: GrindStage, seriesId?: string): Remaining {
  const scope = selectedScope(seriesId), result = emptyRemaining();
  const rows = db.prepare(`SELECT status,COUNT(*) AS count FROM catalog_jobs WHERE kind IN (${kinds[stage].map(() => '?').join(',')})
    AND status!='completed'${scope.sql} GROUP BY status`).all(...kinds[stage], ...scope.args) as { status: keyof Omit<Remaining, 'total'>; count: number }[];
  for (const row of rows) { result[row.status] = row.count; result.total += row.count; }
  return result;
}

function tokensFrom(value: unknown): Tokens {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const token = (name: string) => typeof data[name] === 'number' && Number.isSafeInteger(data[name]) && data[name] >= 0 ? data[name] as number : 0;
  return { input_tokens: token('input_tokens'), output_tokens: token('output_tokens') };
}

/** Wire responses carry actual usage even if their output later fails validation. Cached
 * replays and previously retained observations do not count again on a resumed pass. */
function inferenceUsage(db: Database.Database, job: Job): Map<string, Tokens> {
  const inferenceKinds = job.kind === 'assess' ? ['jev-wire-response', 'jev'] : ['extract-wire-response', 'extract-response', 'extract'];
  const rows = db.prepare(`SELECT id,usage_json FROM catalog_inferences WHERE entity_id=? AND entity_type=?
    AND kind IN (${inferenceKinds.map(() => '?').join(',')})`).all(job.entity_id, job.kind === 'describe-series' ? 'series' : 'work', ...inferenceKinds) as { id: string; usage_json: string }[];
  return new Map(rows.map(row => {
    try { return [row.id, tokensFrom(JSON.parse(row.usage_json))]; }
    catch { return [row.id, emptyTokens()]; }
  }));
}

function jobFailure(error: unknown): { message: string; review: boolean; retryAfterMs: number | null; stop: StopReason | null } {
  const text = error instanceof Error ? error.message : '';
  const http = text.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  const retryAfter = error && typeof error === 'object' ? (error as { retryAfterMs?: unknown }).retryAfterMs : undefined;
  const retryAfterMs = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null;
  const review = error instanceof ReviewError;
  const stop = error instanceof PaidResponseStorageError ? 'storage' : http === '401' || http === '403' ? 'authentication'
    : http === '429' || http === '529' || retryAfterMs !== null ? 'rate-limit'
    : /\b(?:OPENAI_API_KEY|TYPESAFE_API_KEY)\b/.test(text) ? 'configuration' : null;
  // Summaries and stored queue errors never echo an HTTP body, source text, or credentials.
  return { review, retryAfterMs, stop, message: stop === 'storage' ? 'The paid response could not be saved; review database storage before any manual retry.' : review ? 'Catalog job requires review of its retained evidence.'
    : http ? `Catalog job returned HTTP ${http}.` : stop === 'configuration' ? 'Catalog model configuration is missing.'
    : retryAfterMs !== null ? 'Catalog source requested a later attempt.' : 'Catalog job failed; retained data remains available for retry.' };
}

/** One sequential, bounded pass. Importing this module opens no database and runs no jobs.
 * Defaults resume existing queues; refresh and paid enrichment are separate explicit flags. */
export async function runCatalogGrind(db: Database.Database, options: GrindOptions = {}, hooks: GrindHooks = {}): Promise<GrindSummary> {
  const { limits, selected } = checkedOptions(options, hooks.registry ?? seeds);
  const now = hooks.now ?? (() => new Date()), startedAt = now().toISOString();
  const report: GrindSummary = {
    startedAt, finishedAt: startedAt, seriesId: options.seriesId ?? null, enrich: options.enrich === true,
    refresh: options.refresh === true, interrupted: false, paidStopped: false,
    planned: { refresh: 0, audio: 0, inference: 0 }, completed: 0, errors: 0, review: 0, deferred: 0, tokens: emptyTokens(),
    stages: Object.fromEntries(stages.map(stage => [stage, { limit: limits[stage], attempted: 0, completed: 0, errors: 0,
      review: 0, deferred: 0, tokens: emptyTokens(), stopReason: 'disabled', remaining: emptyRemaining() }])) as GrindSummary['stages']
  };
  const stopped = () => options.signal?.aborted === true;
  if (!stopped() && report.refresh) report.planned.refresh = scheduleDue(db, now(), options.seriesId);
  let plannedInference = false;

  for (const stage of stages) {
    const state = report.stages[stage], paid = stage === 'extract' || stage === 'assess';
    if (stopped()) { state.stopReason = 'interrupted'; continue; }
    if (paid && !report.enrich || state.limit === 0) continue;
    if (paid && report.paidStopped) { state.stopReason = 'paid-stop'; continue; }
    if (stage === 'audio') report.planned.audio = await (hooks.planAudio ?? planAudio)(db, selected);
    if (paid && !plannedInference) {
      const planner = hooks.planInference ?? (await import('./inference.js')).planInference;
      report.planned.inference = await planner(db, selected);
      plannedInference = true;
    }
    state.stopReason = 'limit';
    for (let attempt = 0; attempt < state.limit; attempt++) {
      if (stopped()) { state.stopReason = 'interrupted'; break; }
      const job = claim(db, kinds[stage], now(), options.seriesId);
      if (!job) { state.stopReason = 'drained'; break; }
      state.attempted++;
      const before = paid ? inferenceUsage(db, job) : new Map<string, Tokens>();
      let result: unknown;
      try {
        const payload = payloadOf(job);
        if (stage === 'sources') result = hooks.source ? await hooks.source(db, payload as unknown as SourcePayload)
          : await processSource(db, payload as unknown as SourcePayload, hooks.registry ?? seeds);
        else if (stage === 'audio') result = job.kind === 'identified-audio'
          ? await (hooks.identifiedAudio ?? processIdentifiedAudio)(db, payload as unknown as IdentifiedAudioPayload, selected)
          : await (hooks.audio ?? processAudio)(db, payload as unknown as AudioPayload, selected);
        else if (stage === 'extract') {
          const handler = hooks.extract ?? (await import('./inference.js')).processExtraction;
          result = await handler(db, job.entity_id, job.kind as 'extract' | 'describe-series', payload);
        } else {
          const work = db.prepare('SELECT series_id FROM catalog_works WHERE id=?').get(job.entity_id) as { series_id: string } | undefined;
          const seed = selected.find(candidate => candidate.id === work?.series_id);
          if (!seed) throw new ReviewError('Assessment job has no selected canonical work.');
          const handler = hooks.assess ?? (await import('./inference.js')).processAssessment;
          result = await handler(db, job.entity_id, seed);
        }
        finish(db, job, result ?? null);
        state.completed++;
      } catch (error) {
        const failure = jobFailure(error), failedAt = now();
        if (failure.retryAfterMs !== null) {
          defer(db, job, failure.message, new Date(failedAt.getTime() + failure.retryAfterMs), failedAt);
          state.deferred++;
        } else {
          fail(db, job, failure.message, failure.review, failedAt);
          if (failure.review) state.review++;
        }
        state.errors++;
        if (failure.stop) {
          state.stopReason = failure.stop;
          if (paid) report.paidStopped = true;
          break;
        }
      } finally {
        if (paid) {
          const observations = [...inferenceUsage(db, job)].filter(([id]) => !before.has(id));
          const retained = observations.reduce((sum, [, usage]) => ({ input_tokens: sum.input_tokens + usage.input_tokens,
            output_tokens: sum.output_tokens + usage.output_tokens }), emptyTokens());
          // Production handlers retain their usage; injected handlers can return it directly.
          const usage = observations.length ? retained : tokensFrom(result);
          state.tokens.input_tokens += usage.input_tokens;
          state.tokens.output_tokens += usage.output_tokens;
        }
      }
    }
  }
  report.interrupted = stopped();
  report.finishedAt = now().toISOString();
  for (const stage of stages) {
    const state = report.stages[stage];
    state.remaining = remaining(db, stage, options.seriesId);
    report.completed += state.completed; report.errors += state.errors;
    report.review += state.review; report.deferred += state.deferred;
    report.tokens.input_tokens += state.tokens.input_tokens; report.tokens.output_tokens += state.tokens.output_tokens;
  }
  return report;
}

export function parseGrindArgs(args: string[]): GrindOptions & { help: boolean } {
  const { values } = parseArgs({ args, allowPositionals: false, options: {
    series: { type: 'string' }, enrich: { type: 'boolean' }, refresh: { type: 'boolean' }, help: { type: 'boolean' },
    'source-limit': { type: 'string' }, 'audio-limit': { type: 'string' }, 'extract-limit': { type: 'string' }, 'assess-limit': { type: 'string' }
  } });
  const flags = { sources: 'source-limit', audio: 'audio-limit', extract: 'extract-limit', assess: 'assess-limit' } as const;
  const limits: Partial<GrindLimits> = {};
  for (const stage of stages) {
    const value = values[flags[stage]];
    if (value !== undefined) {
      if (!/^\d+$/.test(value)) throw new GrindOptionError(`${flags[stage]} must be an integer from 0 to 300.`);
      limits[stage] = Number(value);
    }
  }
  const options = { seriesId: values.series, enrich: values.enrich === true, refresh: values.refresh === true, limits, help: values.help === true };
  checkedOptions(options, seeds);
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let close: (() => void) | undefined;
  try {
    const options = parseGrindArgs(process.argv.slice(2));
    if (options.help) console.log(`node --env-file-if-exists=.env --import tsx scripts/backend/catalog/grind.ts [options]

One bounded pass: sources -> known audio -> optional descriptions and metadata -> assessment.
Default: resume existing queues; no model calls or credential requirements.
  --series ID          Limit planning, claims, refresh, and counts to one exact configured ID.
  --enrich             Enable paid extraction, series summaries, and Jev assessment.
  --refresh            Queue new attempts for due completed source/audio jobs; leave history intact.
  --source-limit N     Source attempts (default 25).
  --audio-limit N      Exact audiobook attempts (default 25).
  --extract-limit N    Book extraction and series summaries together (default 25).
  --assess-limit N     Assessment attempts (default 25).
All limits are integers from 0 to 300; zero skips that stage. SIGINT finishes the active job.
Register reviewed seeds with the existing catalog seed command. Review/failed jobs need explicit handling.`);
    else {
      const database = await import('../db.js');
      close = database.closeDb;
      const { runMigrations } = await import('../migrate.js');
      runMigrations();
      const report = await runCatalogGrind(database.getDb(), { ...options, signal: controller.signal });
      console.log(JSON.stringify(report, null, 2));
      if (report.interrupted) process.exitCode = 130;
      else if (report.errors) process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof GrindOptionError ? error.message : 'Catalog batch could not complete; inspect queued job status and database configuration.' }));
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    close?.();
  }
}
