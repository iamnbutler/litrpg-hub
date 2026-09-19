import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimsPaidStorageError, ClaimsReviewError, ClaimsTransactionError, processQualityClaims } from './claims.js';
import { qualityEvidenceFor } from './evidence.js';
import { qualityClaimsOutputPath, qualityClaimsSummary, runQualityClaimsCli, runScopedQualityClaims } from './claims-cli.js';

let db: Database.Database, directory: string;
const prose = 'The prose is precise and fluent.';
const neverFetch = vi.fn(() => { throw new Error('Unexpected network.'); });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'quality-claims-cli-')); db = new Database(':memory:');
  db.exec(`CREATE TABLE catalog_series(id TEXT PRIMARY KEY,title TEXT);
    CREATE TABLE catalog_works(id TEXT PRIMARY KEY,series_id TEXT,title TEXT,author TEXT,number REAL);
    CREATE TABLE catalog_reader_evidence(id TEXT PRIMARY KEY,work_id TEXT,body TEXT,author_key TEXT,rating REAL,rating_best REAL,
      published_at TEXT,source_name TEXT,source_url TEXT,contains_spoilers INTEGER,removed_at TEXT);
    CREATE TABLE catalog_inferences(id TEXT PRIMARY KEY,entity_type TEXT,entity_id TEXT,kind TEXT,input_hash TEXT,requested_model TEXT,
      actual_model TEXT,rubric_version TEXT,result_json TEXT,usage_json TEXT,evaluated_at TEXT);
    INSERT INTO catalog_series VALUES('s','Imaginary Saga'),('other','Other Saga');
    INSERT INTO catalog_works VALUES('w','s','Book of Testing','Test Writer',1),('w2','s','Second book','Test Writer',2),('outside','other','Other book','Someone Else',1);`);
  for (const work of ['w', 'w2', 'outside']) for (let i = 0; i < 3; i++) db.prepare(`INSERT INTO catalog_reader_evidence
    VALUES(?,?,?, ?,5,5,'2026-01-01','hardcover.app','https://hardcover.app/books/testing',0,NULL)`)
    .run(`${work}-${i}`, work, `${prose} PRIVATE_REVIEW_${work}_${i} discusses carefully chosen words and distinct dialogue.`, `PRIVATE_VOICE_${work}_${i}`);
  vi.stubEnv('OPENAI_API_KEY', 'dummy-test-key'); vi.stubEnv('QUALITY_CLAIMS_MODEL', 'gpt-4.1-mini-2025-04-14');
  neverFetch.mockClear(); vi.stubGlobal('fetch', neverFetch);
});
afterEach(() => {
  expect(neverFetch).not.toHaveBeenCalled();
  if (db.open) { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); }
  rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', model: 'gpt-4.1-mini-2025-04-14',
  usage: { input_tokens: 100, output_tokens: 20 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ claims: [{
    aspect: 'prose', polarity: 'positive', quotes: [{ polarity: 'positive', text: prose }], rationale: 'PRIVATE_RATIONALE: specific wording.'
  }] }) }] }] })));
const processFake: typeof processQualityClaims = (database, review, options) => processQualityClaims(database, review, { ...options, request: fakeFetch as typeof fetch });

describe('small scoped claims CLI', () => {
  it('requires a scope before any uncached run and rejects ambiguous or unknown scopes', async () => {
    const process = vi.fn(processFake);
    await expect(runScopedQualityClaims(db, { limit: 1 }, { process })).rejects.toThrow(/requires exactly one/);
    await expect(runScopedQualityClaims(db, { work: 'w', series: 's', limit: 1 }, { process })).rejects.toThrow(/requires exactly one/);
    await expect(runScopedQualityClaims(db, { work: 'missing', limit: 1 }, { process })).rejects.toThrow(/No catalog/);
    expect(process).not.toHaveBeenCalled();
  });
  it('bounds uncached work, skips cached reviews freely, and resumes from receipts', async () => {
    await processFake(db, qualityEvidenceFor(db, 'w').reviews[0]);
    const process = vi.fn(processFake);
    const first = await runScopedQualityClaims(db, { work: 'w', limit: 1 }, { process });
    expect(first.run).toMatchObject({ attempted: 1, completed: 1, cachedSkipped: 1, stopReason: 'limit',
      tokens: { input_tokens: 100, output_tokens: 20, unknownUsageResponses: 0 } });
    expect(first.coverage).toMatchObject({ selectedWorks: 1, selectedReviews: 3, cachedReviews: 2, pendingReviews: 1 });
    const second = await runScopedQualityClaims(db, { work: 'w', limit: 1 }, { process });
    expect(second.run).toMatchObject({ attempted: 1, completed: 1, cachedSkipped: 2 });
    const third = await runScopedQualityClaims(db, { work: 'w', limit: 1 }, { process });
    expect(third.run).toMatchObject({ attempted: 0, completed: 0, cachedSkipped: 3,
      tokens: { input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0 } });
    expect(process).toHaveBeenCalledTimes(2);
  });
  it('selects only the named series and does not leak source text or rationale into reports', async () => {
    const result = await runScopedQualityClaims(db, { series: 's', limit: 6 }, { process: processFake });
    expect(result.coverage).toMatchObject({ selectedWorks: 2, selectedReviews: 6, cachedReviews: 6 });
    expect(result.reviews.every(review => ['w', 'w2'].includes(review.workId))).toBe(true);
    const encoded = JSON.stringify(result);
    for (const value of ['PRIVATE_REVIEW', 'PRIVATE_VOICE', 'PRIVATE_RATIONALE', prose, 'quotes', 'rationale', 'body', 'dummy-test-key'])
      expect(encoded).not.toContain(`"${value}"`); // also check ordinary source strings below
    expect(encoded).not.toContain('PRIVATE_'); expect(encoded).not.toContain(prose); expect(encoded).not.toContain('dummy-test-key');
    expect(result.reviews[0]).toMatchObject({ aspects: [{ aspect: 'prose', polarity: 'positive' }], receiptId: expect.any(String), inputHash: expect.any(String) });
    expect(qualityClaimsSummary(db, { work: 'outside' }).coverage.cachedReviews).toBe(0);
  });
  it('reports current pending and parked receipts without altering them', async () => {
    await processFake(db, qualityEvidenceFor(db, 'w').reviews[0]);
    db.exec("UPDATE catalog_inferences SET result_json='null' WHERE kind='quality-claims'");
    const before = db.serialize();
    const report = qualityClaimsSummary(db, { work: 'w' });
    expect(report.coverage).toMatchObject({ reviewItems: 1, pendingReviews: 2, cachedReviews: 0 });
    expect(db.serialize()).toEqual(before);
    const process = vi.fn(processFake);
    const run = await runScopedQualityClaims(db, { work: 'w', limit: 1 }, { process });
    expect(run.run).toMatchObject({ attempted: 1, errors: 1 });
    expect(process).toHaveBeenCalledTimes(1);
  });
  it.each([
    [new ClaimsPaidStorageError({ input_tokens: 9, output_tokens: 2 }, 'test failure', 1), 'paid-storage-failure'],
    [new ClaimsTransactionError('the cache is read-only'), 'pre-spend-refusal'],
    [new Error('OpenAI quality claims returned HTTP 401. PRIVATE_ECHO'), 'authentication'],
    [new Error('OpenAI quality claims returned HTTP 403.'), 'authentication'],
    [new Error('OpenAI quality claims returned HTTP 429.'), 'rate-limit'],
    [new Error('Set OPENAI_API_KEY in the ignored .env file.'), 'authentication']
  ])('stops after a terminal request condition %# and prints no raw error body', async (error, reason) => {
    const process = vi.fn(async () => { throw error; });
    const run = await runScopedQualityClaims(db, { work: 'w', limit: 3 }, { process });
    expect(process).toHaveBeenCalledTimes(1); expect(run.run.stopReason).toBe(reason);
    expect(JSON.stringify(run)).not.toContain('PRIVATE_ECHO');
    if (error instanceof ClaimsPaidStorageError) expect(run.run.tokens).toEqual({ input_tokens: 9, output_tokens: 2, unknownUsageResponses: 1 });
    else expect(run.run.tokens).toEqual({ input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0 });
  });
  it('accounts for a parked paid rejection and still respects the attempt cap', async () => {
    const process = vi.fn(async () => { throw new ClaimsReviewError('PRIVATE_MODEL_TEXT', { input_tokens: 17, output_tokens: 3 }, 1); });
    const run = await runScopedQualityClaims(db, { work: 'w', limit: 2 }, { process });
    expect(run.run).toMatchObject({ attempted: 2, errors: 2, stopReason: 'limit', tokens: { input_tokens: 34, output_tokens: 6, unknownUsageResponses: 2 } });
    expect(JSON.stringify(run)).not.toContain('PRIVATE_MODEL_TEXT');
  });
  it('does not lose the paid tally if the final database report cannot be refreshed', async () => {
    const process = vi.fn(async () => { db.close(); throw new ClaimsPaidStorageError({ input_tokens: 12, output_tokens: 4 }, 'DB unavailable'); });
    const run = await runScopedQualityClaims(db, { work: 'w', limit: 2 }, { process });
    expect(run.run).toMatchObject({ reportFresh: false, stopReason: 'paid-storage-failure', tokens: { input_tokens: 12, output_tokens: 4, unknownUsageResponses: 0 } });
  });
  it('stops cleanly between reviews when interrupted', async () => {
    const process = vi.fn(processFake);
    const run = await runScopedQualityClaims(db, { work: 'w', limit: 3 }, { process, shouldStop: () => true });
    expect(run.run).toMatchObject({ attempted: 0, stopReason: 'interrupted' }); expect(process).not.toHaveBeenCalled();
  });
  it('CLI report opens a real readonly snapshot, never migrates it, and emits only the safe summary', async () => {
    await processFake(db, qualityEvidenceFor(db, 'w').reviews[0]);
    const file = join(directory, 'report.sqlite'); writeFileSync(file, db.serialize());
    const before = readFileSync(file), log = vi.fn();
    const result = await runQualityClaimsCli(['report', '--work', 'w'], { databasePath: file, log });
    expect(result?.coverage.cachedReviews).toBe(1); expect(readFileSync(file)).toEqual(before);
    expect(log).toHaveBeenCalledTimes(1); expect(log.mock.calls[0][0]).not.toContain('PRIVATE_');
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ mode: 'experimental-classifier-comparison', scoreInput: false });
  });
  it('allows output only beneath the ignored directory and rejects symlink escapes', () => {
    mkdirSync(join(directory, 'data/quality'), { recursive: true });
    expect(qualityClaimsOutputPath('data/quality/report.json', directory)).toBe(join(directory, 'data/quality/report.json'));
    for (const value of ['static/data/report.json', 'data/quality/../../exposed.json', 'data/quality/a.sqlite', '/tmp/outside.json', 'data/quality'])
      expect(() => qualityClaimsOutputPath(value, directory)).toThrow(/--out/);
    const elsewhere = join(directory, 'elsewhere'); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(directory, 'data/quality/link'));
    expect(() => qualityClaimsOutputPath('data/quality/link/report.json', directory)).toThrow(/symlink/);
    symlinkSync(join(elsewhere, 'not-created.json'), join(directory, 'data/quality/file.json'));
    expect(() => qualityClaimsOutputPath('data/quality/file.json', directory)).toThrow(/symlink/);
  });
  it('writes the optional private summary after readonly reporting', async () => {
    const file = join(directory, 'report.sqlite'); writeFileSync(file, db.serialize());
    await runQualityClaimsCli(['report', '--work', 'w', '--out', 'data/quality/out.json'], { databasePath: file, root: directory, log: vi.fn() });
    expect(JSON.parse(readFileSync(join(directory, 'data/quality/out.json'), 'utf8'))).toMatchObject({ coverage: { selectedReviews: 3 } });
  });
});
