import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioProductUrl } from './audio.js';
import { parseGrindArgs, runCatalogGrind, type GrindHooks } from './grind.js';
import { enqueue, hash } from './queue.js';
import { ReviewError, type SeedSeries } from './types.js';

const AT = '2026-09-19T04:00:00.000Z';
const seed: SeedSeries = { id: 'test', title: 'Test', author: 'A. Writer', authorAliases: ['A. Writer'], aliases: [], genres: [], priority: 1, sources: [] };
const other = { ...seed, id: 'test-longer', title: 'Other' };
let db: Database.Database;
let hooks: GrindHooks;
let serial: number;
const work = (number: number, series = seed.id) => `work-${series}-${number}`;
const sourceUrl = (name: string) => `https://aethonbooks.com/book/${name}/`;

function queue(kind: string, entity: string, seriesId = seed.id, overrides: { input?: string; status?: string; priority?: number; payload?: Record<string, unknown> } = {}) {
  const payload = overrides.payload ?? (kind === 'source' ? { url: entity, adapter: 'aethon-book', seriesId }
    : kind === 'audio-edition' ? { workId: work(1, seriesId), seriesId, asin: 'B000000001', sourceUrl: entity }
    : { workId: entity });
  const input = overrides.input ?? `input-${++serial}`;
  enqueue(db, kind, entity, input, payload, overrides.priority ?? 0, new Date(AT));
  const id = hash([kind, entity, input]);
  if (overrides.status) db.prepare('UPDATE catalog_jobs SET status=? WHERE id=?').run(overrides.status, id);
  return id;
}

function savedSource(url: string, due = '2026-09-18T00:00:00.000Z') {
  const id = hash(url);
  db.prepare('INSERT OR IGNORE INTO catalog_documents VALUES(?,?,?,?,?)').run(id, url, hash('page'), 'page', '2026-09-01T00:00:00.000Z');
  db.prepare('INSERT OR REPLACE INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
    .run(url, id, '2026-09-01T00:00:00.000Z', due);
}

function retainedUsage(entity: string, id: string, kind: string, input: number, output: number) {
  db.prepare('INSERT INTO catalog_inferences VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'work', entity, kind, 'input', 'requested', 'actual', 'rubric', '{}', JSON.stringify({ input_tokens: input, output_tokens: output }), AT);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const name of ['001_initial.sql', '006_catalog_pipeline.sql']) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  for (const entry of [seed, other]) {
    db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(entry.id, entry.title, entry.author, AT);
    for (let number = 1; number <= 3; number++) {
      db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(work(number, entry.id), entry.id, number, `Book ${number}`, entry.author, sourceUrl(`${entry.id}-${number}`), AT);
    }
  }
  serial = 0;
  hooks = {
    registry: [seed, other], now: () => new Date(AT),
    source: vi.fn(async () => ({ downloaded: false })), audio: vi.fn(async () => ({ downloaded: false })),
    identifiedAudio: vi.fn(async () => ({ downloaded: false })),
    extract: vi.fn(async () => ({ input_tokens: 5, output_tokens: 2 })),
    assess: vi.fn(async () => ({ input_tokens: 7, output_tokens: 3 })),
    planAudio: vi.fn(() => 0), planInference: vi.fn(() => 0)
  };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Tests must not make HTTP or model calls.'); }));
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('bounded resumable catalog pass', () => {
  it('runs selected identified-audio jobs in the shared bounded audio stage without a canonical work', async () => {
    const selectedPayload = { seriesId: seed.id, asin: 'B000000001', number: 9, adapter: 'sarah-lin-author',
      url: 'https://www.audible.com/pd/B000000001', sourceUrl: sourceUrl('author'), sourceDocumentId: 'retained', sourceContentHash: hash('author') };
    const current = queue('identified-audio', `${seed.id}--9--B000000001`, seed.id, { payload: selectedPayload, priority: 10 });
    queue('identified-audio', `${other.id}--9--B000000001`, other.id, { payload: { ...selectedPayload, seriesId: other.id } });
    queue('audio-edition', 'ordinary-audio');
    const result = await runCatalogGrind(db, { seriesId: seed.id, limits: { sources: 0, audio: 1 } }, hooks);
    expect(result).toMatchObject({ completed: 1, errors: 0, stages: { audio: { attempted: 1, stopReason: 'limit', remaining: { pending: 1 } } } });
    expect(hooks.identifiedAudio).toHaveBeenCalledWith(db, selectedPayload, [seed]);
    expect(hooks.audio).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM catalog_jobs WHERE id=?').get(current)).toEqual({ status: 'completed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps failed identified-audio evidence in review and resumes only the remaining jobs', async () => {
    const payload = { seriesId: seed.id, asin: 'B000000001', number: 9 };
    const bad = queue('identified-audio', 'identified-bad', seed.id, { payload, priority: 10 });
    queue('identified-audio', 'identified-good', seed.id, { payload: { ...payload, number: 10 } });
    hooks.identifiedAudio = vi.fn(async (_db, lead) => {
      if (lead.number === 9) throw new ReviewError('Retained product identity conflicts.');
      return { downloaded: false };
    });
    const first = await runCatalogGrind(db, { seriesId: seed.id, limits: { sources: 0, audio: 1 } }, hooks);
    expect(first).toMatchObject({ completed: 0, review: 1, stages: { audio: { remaining: { pending: 1, review: 1 } } } });
    expect(db.prepare('SELECT status FROM catalog_jobs WHERE id=?').get(bad)).toEqual({ status: 'review' });
    const second = await runCatalogGrind(db, { seriesId: seed.id, limits: { sources: 0, audio: 2 } }, hooks);
    expect(second).toMatchObject({ completed: 1, errors: 0, stages: { audio: { remaining: { review: 1 } } } });
    expect(hooks.identifiedAudio).toHaveBeenCalledTimes(2);
  });

  it('refreshes completed identified-audio jobs from their exact product cache without bypassing review', async () => {
    const payload = { seriesId: seed.id, asin: 'B000000001', number: 9, sourceDocumentId: 'original-proof', sourceContentHash: hash('retained') };
    const old = queue('identified-audio', 'identified-due', seed.id, { payload, status: 'completed' });
    queue('identified-audio', 'identified-blocked', seed.id, { payload, status: 'completed' });
    queue('identified-audio', 'identified-blocked', seed.id, { payload, status: 'review' });
    savedSource(audioProductUrl(payload.asin));
    const before = db.prepare('SELECT * FROM catalog_jobs WHERE id=?').get(old);
    const result = await runCatalogGrind(db, { seriesId: seed.id, refresh: true }, hooks);
    expect(result).toMatchObject({ planned: { refresh: 1 }, completed: 1, errors: 0 });
    expect(hooks.identifiedAudio).toHaveBeenCalledWith(db, payload, [seed]);
    expect(db.prepare('SELECT * FROM catalog_jobs WHERE id=?').get(old)).toEqual(before);
  });

  it('finishes the active job on interruption and skips it when restarted', async () => {
    const urls = ['one', 'two', 'three'].map(sourceUrl);
    for (const url of urls) queue('source', url);
    const controller = new AbortController(), called: string[] = [];
    hooks.source = vi.fn(async (_db, payload) => { called.push(payload.url); controller.abort(); return {}; });
    const first = await runCatalogGrind(db, { signal: controller.signal }, hooks);
    expect(first).toMatchObject({ interrupted: true, completed: 1, errors: 0, stages: { sources: { remaining: { pending: 2, running: 0 } } } });
    expect(hooks.planAudio).not.toHaveBeenCalled();

    hooks.source = vi.fn(async (_db, payload) => { called.push(payload.url); return {}; });
    const resumed = await runCatalogGrind(db, {}, hooks);
    expect(resumed).toMatchObject({ interrupted: false, completed: 2, errors: 0, stages: { sources: { remaining: { total: 0 } } } });
    expect(called).toHaveLength(3);
    expect(new Set(called)).toEqual(new Set(urls));
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_jobs WHERE status='completed'").get()).toEqual({ n: 3 });
  });

  it('does not plan or invoke paid handlers without an explicit opt-in or require keys', async () => {
    vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('TYPESAFE_API_KEY', '');
    queue('source', sourceUrl('one')); queue('audio-edition', 'audio-one');
    queue('extract', work(1)); queue('describe-series', seed.id); queue('assess', work(1));
    const result = await runCatalogGrind(db, {}, hooks);
    expect(result).toMatchObject({ enrich: false, completed: 2, tokens: { input_tokens: 0, output_tokens: 0 },
      stages: { extract: { stopReason: 'disabled', remaining: { pending: 2 } }, assess: { stopReason: 'disabled', remaining: { pending: 1 } } } });
    expect(hooks.planAudio).toHaveBeenCalledOnce();
    expect(hooks.planInference).not.toHaveBeenCalled();
    expect(hooks.extract).not.toHaveBeenCalled(); expect(hooks.assess).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enforces each stage limit and plans later work only after earlier stages finish', async () => {
    for (let number = 1; number <= 3; number++) {
      queue('source', sourceUrl(`book-${number}`)); queue('audio-edition', `audio-${number}`);
      queue('assess', work(number));
    }
    queue('extract', work(1)); queue('extract', work(2)); queue('describe-series', seed.id);
    const order: string[] = [];
    hooks.source = vi.fn(async () => { order.push('source'); return {}; });
    hooks.audio = vi.fn(async () => { order.push('audio'); return {}; });
    hooks.extract = vi.fn(async () => { order.push('extract'); return { input_tokens: 5, output_tokens: 2 }; });
    hooks.assess = vi.fn(async () => { order.push('assess'); return { input_tokens: 7, output_tokens: 3 }; });
    hooks.planAudio = vi.fn(() => { order.push('plan-audio'); return 0; });
    hooks.planInference = vi.fn(() => { order.push('plan-inference'); return 0; });
    const result = await runCatalogGrind(db, { enrich: true, limits: { sources: 2, audio: 1, extract: 2, assess: 1 } }, hooks);
    expect(order).toEqual(['source', 'source', 'plan-audio', 'audio', 'plan-inference', 'extract', 'extract', 'assess']);
    expect(result).toMatchObject({ completed: 6, errors: 0, tokens: { input_tokens: 17, output_tokens: 7 },
      stages: { sources: { remaining: { pending: 1 } }, audio: { remaining: { pending: 2 } },
        extract: { remaining: { pending: 1 } }, assess: { remaining: { pending: 2 } } } });
  });

  it('keeps selection exact for planning, work assessments, series summaries, and remaining counts', async () => {
    for (const entry of [seed, other]) {
      queue('source', sourceUrl(entry.id), entry.id); queue('audio-edition', `audio-${entry.id}`, entry.id);
      queue('extract', work(1, entry.id), entry.id); queue('describe-series', entry.id, entry.id);
      queue('assess', work(1, entry.id), entry.id);
    }
    const result = await runCatalogGrind(db, { seriesId: seed.id, enrich: true }, hooks);
    expect(result).toMatchObject({ seriesId: seed.id, completed: 5, errors: 0 });
    expect(hooks.planAudio).toHaveBeenCalledWith(db, [seed]);
    expect(hooks.planInference).toHaveBeenCalledWith(db, [seed]);
    expect(hooks.assess).toHaveBeenCalledWith(db, work(1), seed);
    expect(Object.values(result.stages).every(stage => stage.remaining.total === 0)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_jobs WHERE status='pending'").get()).toEqual({ n: 5 });
  });

  it('leaves completed, review, failed, and future retry jobs untouched', async () => {
    queue('source', sourceUrl('completed'), seed.id, { status: 'completed' });
    queue('source', sourceUrl('review'), seed.id, { status: 'review' });
    queue('extract', work(1), seed.id, { status: 'review' });
    queue('assess', work(1), seed.id, { status: 'failed' });
    const retry = queue('audio-edition', 'future-retry', seed.id, { status: 'retry' });
    db.prepare('UPDATE catalog_jobs SET available_at=? WHERE id=?').run('2026-09-20T00:00:00.000Z', retry);
    const before = db.prepare('SELECT * FROM catalog_jobs ORDER BY id').all();
    const result = await runCatalogGrind(db, { enrich: true }, hooks);
    expect(result.completed).toBe(0);
    expect(db.prepare('SELECT * FROM catalog_jobs ORDER BY id').all()).toEqual(before);
    expect(hooks.source).not.toHaveBeenCalled(); expect(hooks.audio).not.toHaveBeenCalled();
    expect(hooks.extract).not.toHaveBeenCalled(); expect(hooks.assess).not.toHaveBeenCalled();
  });

  it('honors live leases and resumes an expired lease through the existing queue', async () => {
    const liveUrl = sourceUrl('live'), expiredUrl = sourceUrl('expired');
    const live = queue('source', liveUrl, seed.id, { status: 'running' });
    queue('source', liveUrl);
    const expired = queue('source', expiredUrl, seed.id, { status: 'running' });
    db.prepare("UPDATE catalog_jobs SET attempts=1,lease_owner='old-owner',lease_until=? WHERE id=?")
      .run('2026-09-19T04:05:00.000Z', live);
    db.prepare("UPDATE catalog_jobs SET attempts=1,lease_owner='old-owner',lease_until=? WHERE id=?")
      .run('2026-09-19T03:59:00.000Z', expired);
    const result = await runCatalogGrind(db, {}, hooks);
    expect(result.completed).toBe(1);
    expect(hooks.source).toHaveBeenCalledWith(db, expect.objectContaining({ url: expiredUrl }));
    expect(db.prepare('SELECT status,attempts FROM catalog_jobs WHERE id=?').get(expired)).toEqual({ status: 'completed', attempts: 2 });
    expect(db.prepare('SELECT status,attempts,lease_owner FROM catalog_jobs WHERE id=?').get(live))
      .toEqual({ status: 'running', attempts: 1, lease_owner: 'old-owner' });
  });

  it('plans paid work once when extraction is disabled but assessment is enabled', async () => {
    hooks.planInference = vi.fn(() => Number(enqueue(db, 'assess', work(1), 'planned', {}, 0, new Date(AT))));
    const result = await runCatalogGrind(db, { enrich: true, limits: { sources: 0, audio: 0, extract: 0, assess: 1 } }, hooks);
    expect(result).toMatchObject({ planned: { audio: 0, inference: 1 }, completed: 1 });
    expect(hooks.planInference).toHaveBeenCalledOnce();
    expect(hooks.extract).not.toHaveBeenCalled(); expect(hooks.planAudio).not.toHaveBeenCalled();
  });

  it('refreshes only due selected sources and audio without resetting historical jobs or bypassing review/backoff', async () => {
    const due = sourceUrl('due'), fresh = sourceUrl('fresh'), reviewUrl = sourceUrl('blocked-review'), retryUrl = sourceUrl('blocked-retry');
    const original = queue('source', due, seed.id, { status: 'completed' }); savedSource(due);
    queue('source', fresh, seed.id, { status: 'completed' }); savedSource(fresh, '2026-10-01T00:00:00.000Z');
    queue('source', reviewUrl, seed.id, { status: 'completed' }); savedSource(reviewUrl);
    const reviewed = queue('source', reviewUrl, seed.id, { status: 'review' });
    queue('source', retryUrl, seed.id, { status: 'completed' }); savedSource(retryUrl);
    const retry = queue('source', retryUrl, seed.id, { status: 'retry' });
    db.prepare('UPDATE catalog_jobs SET available_at=? WHERE id=?').run('2026-10-01T00:00:00.000Z', retry);
    queue('source', sourceUrl('other'), other.id, { status: 'completed' }); savedSource(sourceUrl('other'));
    const audio = queue('audio-edition', 'audio-due', seed.id, { status: 'completed' }); savedSource(audioProductUrl('B000000001'));
    const historical = db.prepare('SELECT * FROM catalog_jobs ORDER BY id').all() as { id: string }[];

    expect((await runCatalogGrind(db, { seriesId: seed.id }, hooks)).planned.refresh).toBe(0);
    expect(hooks.source).not.toHaveBeenCalled(); expect(hooks.audio).not.toHaveBeenCalled();
    const result = await runCatalogGrind(db, { seriesId: seed.id, refresh: true }, hooks);
    expect(result).toMatchObject({ planned: { refresh: 2 }, completed: 2, errors: 0 });
    expect(hooks.source).toHaveBeenCalledWith(db, expect.objectContaining({ url: due }));
    expect(hooks.audio).toHaveBeenCalledOnce();
    for (const row of historical) expect(db.prepare('SELECT * FROM catalog_jobs WHERE id=?').get(row.id)).toEqual(row);
    expect(db.prepare('SELECT status FROM catalog_jobs WHERE id=?').get(original)).toEqual({ status: 'completed' });
    expect(db.prepare('SELECT status FROM catalog_jobs WHERE id=?').get(audio)).toEqual({ status: 'completed' });
    expect(db.prepare('SELECT status FROM catalog_jobs WHERE id=?').get(reviewed)).toEqual({ status: 'review' });
  });

  it('defers the rate-limited job without consuming its attempt and stops all further paid calls', async () => {
    const first = queue('extract', work(1), seed.id, { priority: 10 });
    queue('extract', work(2)); queue('assess', work(1));
    hooks.extract = vi.fn(async () => { throw Object.assign(new Error('HTTP 429 PRIVATE_SOURCE_AND_SECRET'), { retryAfterMs: 60_000 }); });
    const result = await runCatalogGrind(db, { enrich: true }, hooks);
    expect(result).toMatchObject({ paidStopped: true, errors: 1, deferred: 1,
      stages: { extract: { attempted: 1, stopReason: 'rate-limit' }, assess: { stopReason: 'paid-stop' } } });
    expect(hooks.assess).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status,attempts,available_at,last_error FROM catalog_jobs WHERE id=?').get(first))
      .toEqual({ status: 'retry', attempts: 0, available_at: '2026-09-19T04:01:00.000Z', last_error: 'Catalog job returned HTTP 429.' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each([401, 403])('stops paid work after HTTP %s instead of consuming the rest of the queue', async status => {
    queue('extract', work(1)); queue('extract', work(2)); queue('assess', work(1));
    hooks.extract = vi.fn(async () => { throw new Error(`Model returned HTTP ${status}.`); });
    const result = await runCatalogGrind(db, { enrich: true }, hooks);
    expect(result).toMatchObject({ paidStopped: true, errors: 1, stages: { extract: { attempted: 1, stopReason: 'authentication' } } });
    expect(hooks.assess).not.toHaveBeenCalled();
  });

  it('counts retained paid failures once and does not count cached observations again', async () => {
    queue('extract', work(1), seed.id, { priority: 10 }); queue('extract', work(2));
    retainedUsage(work(2), 'already-paid', 'extract-wire-response', 900, 90);
    hooks.extract = vi.fn(async (_db, entity) => {
      if (entity === work(1)) {
        retainedUsage(entity, 'new-paid-response', 'extract-wire-response', 120, 30);
        throw new ReviewError('PRIVATE_SOURCE unsupported model output needs review.');
      }
      return { cached: true, input_tokens: 0, output_tokens: 0 };
    });
    const result = await runCatalogGrind(db, { enrich: true }, hooks);
    expect(result).toMatchObject({ completed: 1, errors: 1, review: 1, tokens: { input_tokens: 120, output_tokens: 30 } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE');
    expect(db.prepare("SELECT last_error FROM catalog_jobs WHERE status='review'").get())
      .toEqual({ last_error: 'Catalog job requires review of its retained evidence.' });
    const resumed = await runCatalogGrind(db, { enrich: true }, hooks);
    expect(resumed).toMatchObject({ completed: 0, errors: 0, tokens: { input_tokens: 0, output_tokens: 0 } });
    expect(hooks.extract).toHaveBeenCalledTimes(2);
  });

  it('does not double-count successful usage returned and retained by a model handler', async () => {
    queue('extract', work(1));
    hooks.extract = vi.fn(async (_db, entity) => {
      retainedUsage(entity, 'wire', 'extract-wire-response', 50, 20);
      retainedUsage(entity, 'decoded', 'extract-response', 0, 0);
      retainedUsage(entity, 'validated', 'extract', 0, 0);
      return { input_tokens: 50, output_tokens: 20 };
    });
    expect(await runCatalogGrind(db, { enrich: true }, hooks)).toMatchObject({ completed: 1, tokens: { input_tokens: 50, output_tokens: 20 } });
  });

  it('counts retained assessment wire usage after failed validation and excludes cached or normalized duplicates', async () => {
    queue('assess', work(1), seed.id, { priority: 10 }); queue('assess', work(2));
    retainedUsage(work(2), 'old-jev', 'jev', 900, 90);
    hooks.assess = vi.fn(async (_db, entity) => {
      if (entity === work(1)) {
        retainedUsage(entity, 'new-jev-wire', 'jev-wire-response', 120, 30);
        retainedUsage(entity, 'new-jev-normalized', 'jev', 0, 0);
        throw new ReviewError('Retained assessment response needs review.');
      }
      return { cached: true, input_tokens: 0, output_tokens: 0 };
    });
    expect(await runCatalogGrind(db, { enrich: true }, hooks)).toMatchObject({ completed: 1, review: 1, tokens: { input_tokens: 120, output_tokens: 30 } });
  });

  it('validates limits and unknown series before claiming or refreshing any work', async () => {
    queue('source', sourceUrl('one'));
    for (const value of [-1, 0.5, 301, NaN]) {
      await expect(runCatalogGrind(db, { refresh: true, limits: { sources: value } }, hooks)).rejects.toThrow('integer from 0 to 300');
    }
    await expect(runCatalogGrind(db, { seriesId: 'tes' }, hooks)).rejects.toThrow('exact selected series ID');
    expect(db.prepare('SELECT status,attempts FROM catalog_jobs').get()).toEqual({ status: 'pending', attempts: 0 });
    expect(parseGrindArgs(['--source-limit', '0', '--audio-limit', '3', '--enrich'])).toMatchObject({ enrich: true, refresh: false, limits: { sources: 0, audio: 3 } });
    for (const value of ['1.5', '-1', '301', '1e2', '']) expect(() => parseGrindArgs(['--source-limit', value])).toThrow();
  });
});
