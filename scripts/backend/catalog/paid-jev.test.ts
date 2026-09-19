import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hash } from './queue.js';
import { PaidResponseStorageError, ReviewError } from './types.js';
import { JevPaidStorageError, JevReviewError, JevTransactionError, paidJev, retainedUsage } from './paid-jev.js';
import type { Question } from '../jev/client.js';

let db: Database.Database;
const dir = join(import.meta.dirname, '../migrations');
const questions: Record<string, Question> = {
  mood: { type: 'choice', instructions: 'Pick one.', criteria: { warm: 'warm', cold: 'cold' } }
};
const answer = { model: 'jev-test', usage: { input_tokens: 90, output_tokens: 7 },
  answers: { mood: { type: 'choice', choice: 'warm', confidence: 0.9, probabilities: { warm: 0.9, cold: 0.1 } } } };

const request = (evaluate?: never) => ({
  entityType: 'author', entity: 'an-author', kind: 'author-profile', inputHash: 'hash-1',
  rubricVersion: 'v1', requestedModel: 'jev-latest', questions, evaluate
});
const rows = (kind: string) => db.prepare('SELECT result_json,usage_json FROM catalog_inferences WHERE kind=?').all(kind) as { result_json: string; usage_json: string }[];
const respond = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

beforeEach(() => {
  db = new Database(':memory:');
  for (const f of ['001_initial.sql', '002_assessments.sql', '003_covers.sql', '004_content.sql', '005_overrides.sql', '006_catalog_pipeline.sql']) {
    try { db.exec(readFileSync(join(dir, f), 'utf8')); } catch { /* not every schema is needed here */ }
  }
});
afterEach(() => { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); vi.unstubAllEnvs(); });

describe('a paid Jev answer is never bought twice', () => {
  it.each([200, 401])('accounts for an unreadable body after HTTP %i without retrying a purchase', async status => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    const fetchStub = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream interrupted')); } }), { status }));
    const evaluate = ((state: unknown, q: Record<string, Question>, options: { onResponse?: (t: string) => void }) =>
      import('../jev/client.js').then(m => m.evaluate(state, q, { ...options, fetch: fetchStub }))) as never;
    const failed = await paidJev(db, {}, request(evaluate)).catch((error: unknown) => error);
    if (status === 200) {
      expect(failed).toBeInstanceOf(JevPaidStorageError);
      expect(failed).toMatchObject({ usage: { input_tokens: 0, output_tokens: 0 }, unknownUsageResponses: 1 });
    } else {
      expect(failed).not.toBeInstanceOf(JevPaidStorageError);
      expect(failed).not.toHaveProperty('unknownUsageResponses');
    }
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(rows('author-profile-wire')).toHaveLength(0);
  });

  it('retains the body before judging it, and counts the cost once', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    let calls = 0;
    const fetchStub = (async () => { calls++; return respond(answer); }) as typeof fetch;
    const evaluate = ((state: unknown, q: Record<string, Question>, options: { onResponse?: (t: string) => void }) =>
      import('../jev/client.js').then(m => m.evaluate(state, q, { ...options, fetch: fetchStub }))) as never;

    const first = await paidJev(db, { any: 'state' }, request(evaluate));
    expect(first).toMatchObject({ cached: false, usage: { input_tokens: 90, output_tokens: 7 } });
    // The raw body is retained, and only it carries the tokens.
    expect(rows('author-profile-wire')).toHaveLength(1);
    expect(JSON.parse(rows('author-profile-wire')[0].usage_json)).toEqual({ input_tokens: 90, output_tokens: 7 });
    expect(JSON.parse(rows('author-profile')[0].usage_json)).toEqual({ input_tokens: 0, output_tokens: 0 });

    const second = await paidJev(db, { any: 'state' }, request(evaluate));
    expect(second).toMatchObject({ cached: true, usage: { input_tokens: 0, output_tokens: 0 } });
    expect(calls).toBe(1);
  });

  it('replays a retained body that cannot be judged into review, with no call', async () => {
    // A 2xx body that was paid for but does not answer the questions.
    db.prepare(`INSERT INTO catalog_inferences(id,entity_type,entity_id,kind,input_hash,requested_model,actual_model,rubric_version,result_json,usage_json,evaluated_at)
      VALUES(?,'author','an-author','author-profile-wire','hash-1','jev-latest','jev-test','v1',?,'{"input_tokens":90}',?)`)
      .run(hash(['author', 'an-author', 'author-profile-wire', 'hash-1']), JSON.stringify({ text: '{"model":"jev-test","answers":{}}' }), '2026-09-19T00:00:00.000Z');
    const evaluate = (() => { throw new Error('must not be called'); }) as never;
    const parked = await paidJev(db, {}, request(evaluate)).catch((e: unknown) => e);
    expect(parked).toBeInstanceOf(JevReviewError);
    expect(parked).toBeInstanceOf(ReviewError);
    expect((parked as Error).message).toMatch(/will not cost anything/);
    expect(rows('author-profile')).toHaveLength(0);   // nothing invalid was promoted
  });

  it('parks valid JSON of the wrong shape instead of failing downstream', async () => {
    const store = (body: string) => db.prepare(`INSERT OR REPLACE INTO catalog_inferences(id,entity_type,entity_id,kind,input_hash,requested_model,actual_model,rubric_version,result_json,usage_json,evaluated_at)
      VALUES(?,'author','an-author','author-profile','hash-1','jev-latest','jev-test','v1',?,'{}','2026-09-19T00:00:00.000Z')`)
      .run(hash(['author', 'an-author', 'author-profile', 'hash-1']), body);
    const never = (() => { throw new Error('must not be called'); }) as never;
    // Each of these parses as JSON and would previously have been cast straight through, then
    // blown up downstream as a TypeError the queue treats as transient and retries.
    const shapes: [string, string][] = [
      ['null', 'null'],
      ['empty object', '{}'],
      ['missing answers', JSON.stringify({ model: 'jev-test', usage: { input_tokens: 1, output_tokens: 1 } })],
      ['missing the question', JSON.stringify({ ...answer, answers: {} })],
      ['answer of the wrong type', JSON.stringify({ ...answer, answers: { mood: { type: 'noul', noul: 0.5 } } })],
      ['probabilities that do not sum', JSON.stringify({ ...answer, answers: { mood: { type: 'choice', choice: 'warm', confidence: 0.9, probabilities: { warm: 0.2, cold: 0.1 } } } })],
      ['unsafe usage', JSON.stringify({ ...answer, usage: { input_tokens: -1, output_tokens: 1 } })]
    ];
    for (const [label, body] of shapes) {
      store(body);
      const parked = await paidJev(db, {}, request(never)).catch((e: unknown) => e);
      expect(parked, label).toBeInstanceOf(JevReviewError);
      expect(parked, label).toBeInstanceOf(ReviewError);
      expect((parked as JevReviewError).usage, label).toEqual({ input_tokens: 0, output_tokens: 0 });
      expect((parked as Error).message, label).toMatch(/Nothing new would be bought/);
    }
  });

  it('reuses a legacy normalized receipt that predates retention', async () => {
    db.prepare(`INSERT INTO catalog_inferences(id,entity_type,entity_id,kind,input_hash,requested_model,actual_model,rubric_version,result_json,usage_json,evaluated_at)
      VALUES(?,'author','an-author','author-profile','hash-1','jev-latest','jev-test','v1',?,'{"input_tokens":90,"output_tokens":7}',?)`)
      .run(hash(['author', 'an-author', 'author-profile', 'hash-1']), JSON.stringify(answer), '2026-09-19T00:00:00.000Z');
    const evaluate = (() => { throw new Error('must not be called'); }) as never;
    const reused = await paidJev(db, {}, request(evaluate));
    // Bought before wire retention existed, so it is never bought again, and its history stands.
    expect(reused).toMatchObject({ cached: true, usage: { input_tokens: 0, output_tokens: 0 } });
    expect(reused.response.model).toBe('jev-test');
    expect(rows('author-profile-wire')).toHaveLength(0);
  });

  it('keeps a non-2xx out of the cache so a fixed key is not poisoned', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    let calls = 0;
    const fetchStub = (async () => { calls++; return calls === 1 ? respond('{"error":"bad key"}', 401) : respond(answer); }) as typeof fetch;
    const evaluate = ((state: unknown, q: Record<string, Question>, options: { onResponse?: (t: string) => void }) =>
      import('../jev/client.js').then(m => m.evaluate(state, q, { ...options, fetch: fetchStub, sleep: async () => {} }))) as never;
    const failed = await paidJev(db, {}, request(evaluate)).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(ReviewError);   // transport stays retryable
    expect(rows('author-profile-wire')).toHaveLength(0);
    // Nothing was archived, so the retry genuinely re-requests and succeeds.
    expect(await paidJev(db, {}, request(evaluate))).toMatchObject({ cached: false });
    expect(calls).toBe(2);
  });

  it('refuses to buy under a caller transaction, and stops if one opens mid-flight', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    let calls = 0;
    const fetchStub = (async () => { calls++; return respond(answer); }) as typeof fetch;
    const evaluate = ((state: unknown, q: Record<string, Question>, options: { onResponse?: (t: string) => void }) =>
      import('../jev/client.js').then(m => m.evaluate(state, q, { ...options, fetch: fetchStub }))) as never;

    db.exec('BEGIN');
    const refused = await paidJev(db, {}, request(evaluate)).catch((e: unknown) => e);
    db.exec('ROLLBACK');
    expect(refused).toBeInstanceOf(JevTransactionError);
    expect(calls).toBe(0);   // refused before the spend, not after it

    // A transaction that opens while the request is in flight cannot be committed around.
    const racing = ((state: unknown, q: Record<string, Question>, options: { onResponse?: (t: string) => void }) => {
      db.exec('BEGIN');
      return import('../jev/client.js').then(m => m.evaluate(state, q, { ...options, fetch: fetchStub }));
    }) as never;
    const late = await paidJev(db, {}, request(racing)).catch((e: unknown) => e);
    db.exec('ROLLBACK');
    expect(late).toBeInstanceOf(PaidResponseStorageError);
    expect((late as JevPaidStorageError).usage).toEqual({ input_tokens: 90, output_tokens: 7 });
    expect((late as Error).message).toMatch(/in flight/);
  });

  it('parks, rather than retries, when the receipt cannot be written', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    const fetchStub = (async () => respond(answer)) as typeof fetch;
    const evaluate = ((state: unknown, q: Record<string, Question>, options: { onResponse?: (t: string) => void }) =>
      import('../jev/client.js').then(m => m.evaluate(state, q, { ...options, fetch: fetchStub }))) as never;
    db.exec("CREATE TRIGGER no_wire BEFORE INSERT ON catalog_inferences WHEN NEW.kind='author-profile-wire' BEGIN SELECT RAISE(ABORT,'disk is full'); END");
    const failed = await paidJev(db, {}, request(evaluate)).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(PaidResponseStorageError);
    expect(failed).toBeInstanceOf(ReviewError);
    expect((failed as Error).message).toMatch(/disk is full/);
    expect((failed as JevPaidStorageError).usage).toEqual({ input_tokens: 90, output_tokens: 7 });
  });

  it('lets the only receipt own the cost when no body was handed back', async () => {
    // A trusted injected evaluator returns a parsed answer and never calls onResponse, so the
    // normalized row is the sole receipt and must carry the spend rather than reporting zero.
    const evaluate = (async () => answer) as never;
    const result = await paidJev(db, {}, request(evaluate));
    expect(result).toMatchObject({ cached: false, usage: { input_tokens: 90, output_tokens: 7 } });
    expect(rows('author-profile-wire')).toHaveLength(0);
    expect(JSON.parse(rows('author-profile')[0].usage_json)).toEqual({ input_tokens: 90, output_tokens: 7 });
    // Replaying it is free and buys nothing.
    expect(await paidJev(db, {}, request((() => { throw new Error('must not be called'); }) as never)))
      .toMatchObject({ cached: true, usage: { input_tokens: 0, output_tokens: 0 } });
  });

  it('stops a parsed-only evaluator from saving its sole receipt inside a mid-flight transaction', async () => {
    const evaluate = vi.fn(async () => {
      await Promise.resolve();
      db.exec('BEGIN');
      return answer; // No onResponse callback: the normalized row would be the only receipt.
    });
    const failed = await paidJev(db, {}, request(evaluate as never)).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(JevPaidStorageError);
    expect(failed).not.toBeInstanceOf(JevTransactionError); // The response was already bought.
    expect(failed).toMatchObject({ usage: { input_tokens: 90, output_tokens: 7 }, unknownUsageResponses: 0 });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(rows('author-profile')).toHaveLength(0);
    expect(rows('author-profile-wire')).toHaveLength(0);
    db.exec('ROLLBACK');
    expect(rows('author-profile')).toHaveLength(0);
  });

  it('parks a corrupt normalized receipt instead of cycling retries', async () => {
    db.prepare(`INSERT INTO catalog_inferences(id,entity_type,entity_id,kind,input_hash,requested_model,actual_model,rubric_version,result_json,usage_json,evaluated_at)
      VALUES(?,'author','an-author','author-profile','hash-1','jev-latest','jev-test','v1','{not json',' {}',?)`)
      .run(hash(['author', 'an-author', 'author-profile', 'hash-1']), '2026-09-19T00:00:00.000Z');
    const parked = await paidJev(db, {}, request((() => { throw new Error('must not be called'); }) as never)).catch((e: unknown) => e);
    expect(parked).toBeInstanceOf(JevReviewError);
    expect(parked).toBeInstanceOf(ReviewError);
    expect((parked as JevReviewError).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('gives a runner everything it needs to classify and account for a failure', () => {
    const spent = { input_tokens: 90, output_tokens: 7 };
    // Both CLIs branch on exactly these, so the contract is pinned here rather than in a script.
    for (const carried of [new JevReviewError('unusable', spent), new JevPaidStorageError(spent, 'disk is full')]) {
      expect(carried).toBeInstanceOf(ReviewError);   // parks; never retried into another purchase
      expect(carried.usage).toEqual(spent);          // a paid rejection never reports a free run
    }
    // A receipt that would not commit also stops the worker.
    expect(new JevPaidStorageError(spent, 'disk is full')).toBeInstanceOf(PaidResponseStorageError);
    // The pre-spend refusal is not a paid storage failure: nothing was bought, so there is no
    // cost to report and nothing to review about storage.
    const refused = new JevTransactionError('a caller transaction is open');
    expect(refused).toBeInstanceOf(ReviewError);
    expect(refused).not.toBeInstanceOf(PaidResponseStorageError);
    expect('usage' in refused).toBe(false);
  });

  it('refuses a retained row written under a different model or rubric', async () => {
    const insert = (rubric: string, model: string) => db.prepare(`INSERT OR REPLACE INTO catalog_inferences(id,entity_type,entity_id,kind,input_hash,requested_model,actual_model,rubric_version,result_json,usage_json,evaluated_at)
      VALUES(?,'author','an-author','author-profile','hash-1',?,'jev-test',?,?,'{}',?)`)
      .run(hash(['author', 'an-author', 'author-profile', 'hash-1']), model, rubric, JSON.stringify(answer), '2026-09-19T00:00:00.000Z');
    const never = (() => { throw new Error('must not be called'); }) as never;

    // Matching declarations: reused, exactly as the existing live receipts are.
    insert('v1', 'jev-latest');
    expect(await paidJev(db, {}, request(never))).toMatchObject({ cached: true });
    // A row recorded under another rubric or model parks rather than being reused or re-bought.
    insert('v0-old-rubric', 'jev-latest');
    const staleRubric = await paidJev(db, {}, request(never)).catch((e: unknown) => e);
    expect(staleRubric).toBeInstanceOf(JevReviewError);
    expect((staleRubric as Error).message).toMatch(/rubric v0-old-rubric, not v1/);
    insert('v1', 'some-other-model');
    const staleModel = await paidJev(db, {}, request(never)).catch((e: unknown) => e);
    expect(staleModel).toBeInstanceOf(JevReviewError);
    expect((staleModel as JevReviewError).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('rejects a token count the Jev client itself would refuse', () => {
    // client.ts validates with Number.isSafeInteger; anything it would reject is not a count.
    expect(retainedUsage(`{"usage":{"input_tokens":${Number.MAX_SAFE_INTEGER},"output_tokens":1}}`))
      .toEqual({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 });
    expect(retainedUsage('{"usage":{"input_tokens":9007199254740993,"output_tokens":1}}')).toEqual({});
    expect(retainedUsage('{"usage":{"input_tokens":1e308,"output_tokens":1}}')).toEqual({});
  });

  it('counts a paid response that never said what it cost, and only a fresh one', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    const unpriced = { ...answer, usage: undefined };
    let calls = 0;
    const fetchStub = (async () => { calls++; return respond(unpriced); }) as typeof fetch;
    const evaluate = ((state: unknown, q: Record<string, Question>, options: { onResponse?: (t: string) => void }) =>
      import('../jev/client.js').then(m => m.evaluate(state, q, { ...options, fetch: fetchStub }))) as never;

    // validateResponse requires usage, so this 2xx is bought and then unusable: counted once,
    // priced at nothing, and explicitly flagged as unpriced rather than reported as free.
    const parked = await paidJev(db, {}, request(evaluate)).catch((e: unknown) => e);
    expect(parked).toBeInstanceOf(JevReviewError);
    expect((parked as JevReviewError).unknownUsageResponses).toBe(1);
    expect((parked as JevReviewError).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(JSON.parse((rows('author-profile-wire')[0]).usage_json)).toEqual({});   // receipt stays honest

    // Replaying that same retained body buys nothing, so it counts nothing.
    const replayed = await paidJev(db, {}, request(evaluate)).catch((e: unknown) => e);
    expect((replayed as JevReviewError).unknownUsageResponses).toBe(0);
    expect(calls).toBe(1);
  });

  it('prices a known response and leaves replays and refusals at zero', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    const fetchStub = (async () => respond(answer)) as typeof fetch;
    const evaluate = ((state: unknown, q: Record<string, Question>, options: { onResponse?: (t: string) => void }) =>
      import('../jev/client.js').then(m => m.evaluate(state, q, { ...options, fetch: fetchStub }))) as never;
    const fresh = await paidJev(db, {}, request(evaluate));
    expect(fresh).toMatchObject({ usage: { input_tokens: 90, output_tokens: 7 }, unknownUsageResponses: 0 });
    // A replay is free and unpriced-free, not unpriced-unknown.
    expect(await paidJev(db, {}, request(evaluate))).toMatchObject({ cached: true, unknownUsageResponses: 0 });

    // A replay under an open transaction is still fine: it buys nothing, so there is no receipt
    // to lose, and it reports no cost and no unpriced response.
    db.exec('BEGIN');
    expect(await paidJev(db, {}, request(evaluate))).toMatchObject({ cached: true, unknownUsageResponses: 0 });
    db.exec('ROLLBACK');

    // A miss under one is refused before the spend, so no response is bought to count at all.
    db.prepare("DELETE FROM catalog_inferences WHERE kind LIKE 'author-profile%'").run();
    db.exec('BEGIN');
    const refused = await paidJev(db, {}, request(evaluate)).catch((e: unknown) => e);
    db.exec('ROLLBACK');
    expect(refused).toBeInstanceOf(JevTransactionError);
    expect('unknownUsageResponses' in (refused as object)).toBe(false);
  });

  it('counts an unpriced response whose receipt could not be stored', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    const fetchStub = (async () => respond({ ...answer, usage: { input_tokens: -1, output_tokens: 2 } })) as typeof fetch;
    const evaluate = ((state: unknown, q: Record<string, Question>, options: { onResponse?: (t: string) => void }) =>
      import('../jev/client.js').then(m => m.evaluate(state, q, { ...options, fetch: fetchStub }))) as never;
    db.exec("CREATE TRIGGER no_wire BEFORE INSERT ON catalog_inferences WHEN NEW.kind='author-profile-wire' BEGIN SELECT RAISE(ABORT,'disk is full'); END");
    const failed = await paidJev(db, {}, request(evaluate)).catch((e: unknown) => e);
    db.exec('DROP TRIGGER no_wire');
    // Bought, unpriceable, and unstorable: the worst case must still not read as a free run.
    expect(failed).toBeInstanceOf(JevPaidStorageError);
    expect((failed as JevPaidStorageError).unknownUsageResponses).toBe(1);
    expect((failed as JevPaidStorageError).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it.each([true, false])('keeps purchase accounting when normalized storage fails (wire=%s)', async wire => {
    for (const known of [true, false]) {
      db.prepare('DELETE FROM catalog_inferences').run();
      let calls = 0;
      const evaluate = (async (_state: unknown, _questions: unknown, options: { onResponse?: (text: string) => void }) => {
        calls++;
        if (wire) options.onResponse?.(JSON.stringify({ ...answer, usage: known ? answer.usage : undefined }));
        return known || wire ? answer : { ...answer, usage: undefined };
      }) as never;
      db.exec("CREATE TRIGGER no_normalized BEFORE INSERT ON catalog_inferences WHEN NEW.kind='author-profile' BEGIN SELECT RAISE(ABORT,'disk full'); END");
      const failed = await paidJev(db, {}, request(evaluate)).catch((error: unknown) => error);
      db.exec('DROP TRIGGER no_normalized');
      expect(failed).toBeInstanceOf(JevPaidStorageError);
      expect(failed).toMatchObject({ usage: known ? answer.usage : { input_tokens: 0, output_tokens: 0 }, unknownUsageResponses: known ? 0 : 1 });
      expect(rows('author-profile-wire')).toHaveLength(wire ? 1 : 0);
      expect(rows('author-profile')).toHaveLength(0);
      if (wire) {
        const replay = await paidJev(db, {}, request(evaluate)).catch((error: unknown) => error);
        expect(replay).toMatchObject({ usage: { input_tokens: 0, output_tokens: 0 }, unknownUsageResponses: 0 });
        expect(calls).toBe(1);
      }
    }
  });

  it('records unknown cost as unknown rather than as free', () => {
    expect(retainedUsage('{"usage":{"input_tokens":5,"output_tokens":1}}')).toEqual({ input_tokens: 5, output_tokens: 1 });
    expect(retainedUsage('{"model":"jev-test"}')).toEqual({});
    expect(retainedUsage('{"usage":{"input_tokens":1.5,"output_tokens":1}}')).toEqual({});
    expect(retainedUsage('not json')).toEqual({});
  });
});
