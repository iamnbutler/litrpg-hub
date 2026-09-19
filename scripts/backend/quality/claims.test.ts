import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaidResponseStorageError, ReviewError } from '../catalog/types.js';
import { hash } from '../catalog/queue.js';
import { qualityAspects, qualityQuestions } from './assessment.js';
import { QUALITY_EVIDENCE_VERSION, qualityEvidenceFor, qualityReviewState, type QualityReview } from './evidence.js';
import { ClaimsPaidStorageError, ClaimsReviewError, ClaimsTransactionError, loadQualityClaims, parseQualityClaimsWire,
  processQualityClaims, qualityClaimsHash, qualityClaimsInstructions, qualityClaimsModel, qualityClaimsReceiptId,
  qualityClaimsSchema, qualityClaimsSettings, QUALITY_CLAIMS_VERSION, validateQualityClaims, type QualityClaimExtraction } from './claims.js';

let db: Database.Database;
const prose = 'The prose is precise and fluent.';
const praise = 'The plot sets up consequences effectively';
const criticism = 'its payoff is rushed';
const text = `${prose} ${praise}, but ${criticism}. The narrator gives distinct voices.`;
const good: QualityClaimExtraction = { claims: [{ aspect: 'prose', polarity: 'positive',
  quotes: [{ polarity: 'positive', text: prose }], rationale: 'The reviewer explicitly praises sentence-level execution.' }] };
const neverFetch = vi.fn(() => { throw new Error('Unexpected network request.'); });
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE catalog_series(id TEXT PRIMARY KEY,title TEXT);
    CREATE TABLE catalog_works(id TEXT PRIMARY KEY,series_id TEXT,title TEXT,author TEXT,number REAL);
    CREATE TABLE catalog_reader_evidence(id TEXT PRIMARY KEY,work_id TEXT,body TEXT,author_key TEXT,rating REAL,rating_best REAL,
      published_at TEXT,source_name TEXT,source_url TEXT,contains_spoilers INTEGER,removed_at TEXT);
    CREATE TABLE catalog_inferences(id TEXT PRIMARY KEY,entity_type TEXT,entity_id TEXT,kind TEXT,input_hash TEXT,requested_model TEXT,
      actual_model TEXT,rubric_version TEXT,result_json TEXT,usage_json TEXT,evaluated_at TEXT);
    INSERT INTO catalog_series VALUES('series-a','Imaginary Saga');
    INSERT INTO catalog_works VALUES('work-a','series-a','Book of Testing','Test Writer',1);`);
  vi.stubEnv('OPENAI_API_KEY', 'dummy-key-not-a-secret'); vi.stubEnv('QUALITY_CLAIMS_MODEL', 'gpt-4.1-mini-2025-04-14');
  neverFetch.mockClear(); vi.stubGlobal('fetch', neverFetch);
});
afterEach(() => {
  expect(neverFetch).not.toHaveBeenCalled();
  if (db.inTransaction) db.exec('ROLLBACK'); db.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
function put(body = text): QualityReview {
  db.prepare(`INSERT INTO catalog_reader_evidence VALUES('review-one','work-a',?,'PRIVATE_VOICE',5,5,'2026-01-01','hardcover.app','https://hardcover.app/books/testing',0,NULL)`).run(body);
  return qualityEvidenceFor(db, 'work-a').reviews[0];
}
function wire(body: unknown = good, patch: Record<string, unknown> = {}) {
  return JSON.stringify({ status: 'completed', model: 'gpt-4.1-mini-2025-04-14', usage: { input_tokens: 100, output_tokens: 20 },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(body) }] }], ...patch });
}
function request(raw = wire(), status = 200) {
  return vi.fn(async () => new Response(raw, { status })) as unknown as typeof fetch;
}
const rows = () => db.prepare('SELECT kind,usage_json,result_json,requested_model FROM catalog_inferences ORDER BY kind').all() as { kind: string; usage_json: string; result_json: string; requested_model: string }[];

describe('quote-grounded private claim shape', () => {
  it('allows unknown or empty instead of inventing a balanced assessment', () => {
    expect(validateQualityClaims({ claims: [] }, text)).toEqual({ claims: [] });
    const unknown = { claims: [{ aspect: 'editing', polarity: 'unknown', quotes: [], rationale: 'No copyediting claim.' }] };
    expect(validateQualityClaims(unknown, text)).toEqual(unknown);
  });
  it('requires exact contained quotations with original punctuation, not plausible paraphrases', () => {
    expect(validateQualityClaims(good, text)).toEqual(good);
    for (const quote of ['The prose is precise & fluent.', 'The prose is concise and fluent.', 'The prose is precise…']) {
      expect(() => validateQualityClaims({ claims: [{ ...good.claims[0], quotes: [{ polarity: 'positive', text: quote }] }] }, text)).toThrow(/quotation/);
    }
  });
  it('mixed requires distinct support for both polarities in that claim', () => {
    const mixed: QualityClaimExtraction = { claims: [{ aspect: 'structure', polarity: 'mixed',
      quotes: [{ polarity: 'positive', text: praise }, { polarity: 'negative', text: criticism }],
      rationale: 'Setup is praised while payoff execution is criticized.' }] };
    expect(validateQualityClaims(mixed, text)).toEqual(mixed);
    expect(() => validateQualityClaims({ claims: [{ ...mixed.claims[0], quotes: mixed.claims[0].quotes.slice(0, 1) }] }, text)).toThrow(/polarity/);
    expect(() => validateQualityClaims({ claims: [{ ...mixed.claims[0], quotes: [{ polarity: 'positive', text: praise }, { polarity: 'negative', text: praise }] }] }, text)).toThrow(/duplicated/);
  });
  it('does not manufacture two sides from differently trimmed versions of the same source span', () => {
    expect(() => validateQualityClaims({ claims: [{ ...good.claims[0], polarity: 'mixed',
      quotes: [{ polarity: 'positive', text: prose }, { polarity: 'negative', text: 'prose is precise and fluent' }] }] }, text)).toThrow(/overlapping/);
  });
  it('does not accept opposite-side quotations in one-sided or unknown claims', () => {
    expect(() => validateQualityClaims({ claims: [{ ...good.claims[0], polarity: 'unknown' }] }, text)).toThrow(/polarity/);
    expect(() => validateQualityClaims({ claims: [{ ...good.claims[0], polarity: 'negative' }] }, text)).toThrow(/polarity/);
    expect(() => validateQualityClaims({ claims: [{ ...good.claims[0], quotes: [] }] }, text)).toThrow(/polarity/);
  });
  it.each([null, {}, { claims: 'no' }, { claims: [{ ...good.claims[0], aspect: 'overall' }] },
    { claims: [good.claims[0], good.claims[0]] }, { claims: [{ ...good.claims[0], rationale: 'x'.repeat(281) }] },
    { claims: [], rating: 5 }])('refuses malformed, duplicated or out-of-taxonomy output %#', bad => {
    expect(() => validateQualityClaims(bad, text)).toThrow();
  });
  it('shares all seven definitions and specifically forbids spillover and forced mixed labels', () => {
    for (const aspect of qualityAspects) expect(qualityClaimsInstructions).toContain(qualityQuestions[`${aspect}_relevance`].instructions);
    expect(qualityClaimsInstructions).toContain('THIS SAME aspect');
    expect(qualityClaimsInstructions).toContain('character liking must not supply a positive pacing/structure claim');
    expect(qualityClaimsInstructions).toContain('not mixed prose or mixed audio');
  });
});

describe('durable Responses API claims', () => {
  it('preserves explicit 4.1 requests and hashes while hashing low reasoning for the Terra default', () => {
    const review = put(), legacyHash = (model: string) => hash({
      version: QUALITY_CLAIMS_VERSION, evidenceVersion: QUALITY_EVIDENCE_VERSION, model, store: false, max_output_tokens: 4096,
      instructions: qualityClaimsInstructions, schema: qualityClaimsSchema,
      provenance: { id: review.id, workId: review.workId, voiceId: review.voiceId, sourceUrl: review.sourceUrl }, state: qualityReviewState(review)
    });
    expect(qualityClaimsSettings('gpt-4.1-mini-2025-04-14')).toEqual({ model: 'gpt-4.1-mini-2025-04-14', store: false, max_output_tokens: 4096 });
    expect(qualityClaimsHash(review, 'gpt-4.1-mini-2025-04-14')).toBe(legacyHash('gpt-4.1-mini-2025-04-14'));
    expect(qualityClaimsSettings('gpt-5.6-terra')).toEqual({ model: 'gpt-5.6-terra', store: false, max_output_tokens: 4096, reasoning: { effort: 'low' } });
    expect(qualityClaimsHash(review, 'gpt-5.6-terra')).not.toBe(legacyHash('gpt-5.6-terra'));
    vi.stubEnv('QUALITY_CLAIMS_MODEL', undefined);
    expect(qualityClaimsModel()).toBe('gpt-5.6-terra');
    expect(qualityClaimsSettings()).toEqual(qualityClaimsSettings('gpt-5.6-terra'));
  });
  it('uses the specified model and structured schema, keeps private provenance out of model input, and buys once', async () => {
    const review = put(`Test Writer: 5 stars. ${text}`), fetcher = request();
    const first = await processQualityClaims(db, review, { request: fetcher });
    expect(first).toMatchObject({ claims: good.claims, cached: false, input_tokens: 100, output_tokens: 20, unknownUsageResponses: 0,
      intendedUse: 'private-classifier-comparison', verification: 'literal-containment-only', receiptKind: 'quality-claims' });
    const [, init] = vi.mocked(fetcher).mock.calls[0], sent = JSON.parse(String(init?.body));
    expect(sent).toMatchObject({ model: 'gpt-4.1-mini-2025-04-14', store: false, text: { format: { type: 'json_schema', strict: true, schema: qualityClaimsSchema } } });
    expect(sent.input).not.toContain('Test Writer'); expect(sent.input).not.toContain('PRIVATE_VOICE');
    expect(sent.input).not.toContain('5 stars'); expect(sent.input).not.toContain('hardcover.app');
    expect(rows().map(row => [row.kind, JSON.parse(row.usage_json)])).toEqual([
      ['quality-claims', { input_tokens: 0, output_tokens: 0 }], ['quality-claims-wire', { input_tokens: 100, output_tokens: 20 }]
    ]);
    const second = await processQualityClaims(db, review, { request: fetcher });
    expect(second).toMatchObject({ claims: good.claims, cached: true, input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0 });
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(1);
    expect(loadQualityClaims(db, review)).toEqual(second);
  });
  it('pins the requested model before the request even if the environment changes while awaiting it', async () => {
    const review = put();
    const fetcher = vi.fn(async () => { process.env.QUALITY_CLAIMS_MODEL = 'changed-mid-request'; return new Response(wire()); }) as unknown as typeof fetch;
    await processQualityClaims(db, review, { request: fetcher });
    expect(rows().every(row => row.requested_model === 'gpt-4.1-mini-2025-04-14')).toBe(true);
  });
  it('invalidates changed text, provenance and model but not extra rating metadata', async () => {
    const review = put(); await processQualityClaims(db, review, { request: request() });
    expect(qualityClaimsHash({ ...review, comment: `${review.comment} Changed.` })).not.toBe(qualityClaimsHash(review));
    expect(qualityClaimsHash({ ...review, workId: 'other' })).not.toBe(qualityClaimsHash(review));
    expect(qualityClaimsHash({ ...review, sourceUrl: 'https://other.example/review' })).not.toBe(qualityClaimsHash(review));
    expect(qualityClaimsHash(review, 'other-model')).not.toBe(qualityClaimsHash(review));
    const extra = { ...review, stars: 1, ratingCount: 9999 };
    expect(qualityClaimsHash(extra)).toBe(qualityClaimsHash(review));
    db.prepare('UPDATE catalog_reader_evidence SET body=?').run(`${text} It also has careful foreshadowing.`);
    expect(loadQualityClaims(db, review)).toBeNull();
    await expect(processQualityClaims(db, review)).rejects.toBeInstanceOf(ClaimsReviewError);
  });
  it('does not promote an answer if the evidence changes during the call, but preserves its paid wire', async () => {
    const review = put();
    const fetcher = vi.fn(async () => { db.exec("UPDATE catalog_reader_evidence SET removed_at='2026-09-19'"); return new Response(wire()); }) as unknown as typeof fetch;
    const error = await processQualityClaims(db, review, { request: fetcher }).catch(error => error);
    expect(error).toBeInstanceOf(ClaimsReviewError); expect(error.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(rows().map(row => row.kind)).toEqual(['quality-claims-wire']);
    expect(loadQualityClaims(db, review)).toBeNull();
  });
  it('retains paid accounting when the source work disappears during the call', async () => {
    const review = put();
    const fetcher = vi.fn(async () => { db.exec("DELETE FROM catalog_works WHERE id='work-a'"); return new Response(wire()); }) as unknown as typeof fetch;
    const error = await processQualityClaims(db, review, { request: fetcher }).catch(error => error);
    expect(error).toBeInstanceOf(ClaimsReviewError); expect(error.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(rows().map(row => row.kind)).toEqual(['quality-claims-wire']);
  });
  it.each([
    ['non-JSON wire', '{not json'],
    ['refusal', wire(good, { output: [{ content: [{ type: 'refusal', refusal: 'Private refusal details.' }] }] })],
    ['truncation', wire(good, { status: 'incomplete' })],
    ['malformed structured result', wire({ claims: 'bad' })],
    ['invented quote', wire({ claims: [{ ...good.claims[0], quotes: [{ polarity: 'positive', text: 'Not in the review at all.' }] }] })],
    ['invalid usage', wire(good, { usage: { input_tokens: -1, output_tokens: 20 } })]
  ])('retains %s before validation, parks it, and replays without another purchase', async (_name, raw) => {
    const review = put(), fetcher = request(raw);
    const first = await processQualityClaims(db, review, { request: fetcher }).catch(error => error);
    expect(first).toBeInstanceOf(ClaimsReviewError);
    expect(rows()).toHaveLength(1); expect(rows()[0].kind).toBe('quality-claims-wire');
    expect(JSON.parse(rows()[0].result_json).text).toBe(raw);
    const second = await processQualityClaims(db, review, { request: fetcher }).catch(error => error);
    expect(second).toBeInstanceOf(ClaimsReviewError); expect(second.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(second.unknownUsageResponses).toBe(0); expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429, 500])('does not poison the cache with HTTP %s or echo its error body', async status => {
    const review = put(), rejected = request('SECRET_OR_PRIVATE_REVIEW_ECHO', status);
    const error = await processQualityClaims(db, review, { request: rejected }).catch(error => error);
    expect(error).not.toBeInstanceOf(ReviewError); expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).not.toContain('SECRET'); expect(rows()).toEqual([]);
    expect((await processQualityClaims(db, review, { request: request() })).claims).toEqual(good.claims);
  });
  it('keeps unknown usage honest on disk and distinguishes a purchase from a free replay', async () => {
    const review = put(), fetcher = request(wire(good, { usage: undefined }));
    const first = await processQualityClaims(db, review, { request: fetcher });
    expect(first).toMatchObject({ input_tokens: 0, output_tokens: 0, unknownUsageResponses: 1 });
    expect(JSON.parse(rows().find(row => row.kind.endsWith('-wire'))!.usage_json)).toEqual({});
    expect(await processQualityClaims(db, review, { request: fetcher })).toMatchObject({ unknownUsageResponses: 0, cached: true });
  });
  it('refuses an already-open transaction before spending; cached reads still work', async () => {
    const review = put(), fetcher = request(); db.exec('BEGIN');
    const error = await processQualityClaims(db, review, { request: fetcher }).catch(error => error);
    expect(error).toBeInstanceOf(ClaimsTransactionError); expect(error).not.toBeInstanceOf(PaidResponseStorageError);
    expect(error.usage).toBeUndefined(); expect(vi.mocked(fetcher)).not.toHaveBeenCalled(); expect(rows()).toEqual([]);
    db.exec('ROLLBACK'); await processQualityClaims(db, review, { request: fetcher }); db.exec('BEGIN');
    expect((await processQualityClaims(db, review, { request: fetcher })).cached).toBe(true);
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(1);
  });
  it('refuses a genuinely read-only cache miss before spending', async () => {
    const review = put(), dir = mkdtempSync(join(tmpdir(), 'quality-claims-')), file = join(dir, 'readonly.sqlite');
    writeFileSync(file, db.serialize()); const readonly = new Database(file, { readonly: true }); const fetcher = request();
    try {
      await expect(processQualityClaims(readonly, review, { request: fetcher })).rejects.toBeInstanceOf(ClaimsTransactionError);
      expect(vi.mocked(fetcher)).not.toHaveBeenCalled();
      expect(readonly.prepare('SELECT COUNT(*) AS n FROM catalog_inferences').get()).toEqual({ n: 0 });
    } finally { readonly.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('stops with accounting when a transaction opens in flight', async () => {
    const review = put();
    const fetcher = vi.fn(async () => { db.exec('BEGIN'); return new Response(wire()); }) as unknown as typeof fetch;
    const error = await processQualityClaims(db, review, { request: fetcher }).catch(error => error);
    expect(error).toBeInstanceOf(ClaimsPaidStorageError); expect(error).toBeInstanceOf(PaidResponseStorageError);
    expect(error.usage).toEqual({ input_tokens: 100, output_tokens: 20 }); expect(rows()).toEqual([]);
  });
  it('stops with accounting when the wire cannot commit', async () => {
    const review = put(); db.exec("CREATE TRIGGER reject_wire BEFORE INSERT ON catalog_inferences BEGIN SELECT RAISE(ABORT,'no writes'); END;");
    const error = await processQualityClaims(db, review, { request: request() }).catch(error => error);
    expect(error).toBeInstanceOf(ClaimsPaidStorageError); expect(error.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(rows()).toEqual([]);
  });
  it('recovers the existing wire free when normalized promotion failed, and reports an existing receipt', async () => {
    const review = put(); db.exec("CREATE TRIGGER reject_normalized BEFORE INSERT ON catalog_inferences WHEN NEW.kind='quality-claims' BEGIN SELECT RAISE(ABORT,'no promotion'); END;");
    const fetcher = request();
    const error = await processQualityClaims(db, review, { request: fetcher }).catch(error => error);
    expect(error).toBeInstanceOf(ClaimsPaidStorageError); expect(error.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    const replay = await processQualityClaims(db, review, { request: fetcher });
    expect(replay).toMatchObject({ cached: true, receiptKind: 'quality-claims-wire', input_tokens: 0, output_tokens: 0 });
    expect(replay.receiptId).toBe(qualityClaimsReceiptId(review, undefined, true));
    expect(db.prepare('SELECT id FROM catalog_inferences WHERE id=?').get(replay.receiptId)).toBeTruthy();
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(1);
  });
  it('does not report an unreadable paid body as a free or retryable failure', async () => {
    const review = put();
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, text: async () => { throw new Error('body lost'); } })) as unknown as typeof fetch;
    const error = await processQualityClaims(db, review, { request: fetcher }).catch(error => error);
    expect(error).toBeInstanceOf(ClaimsPaidStorageError); expect(error.unknownUsageResponses).toBe(1); expect(rows()).toEqual([]);
  });
  it('revalidates stored normalized shape and provenance without buying a replacement', async () => {
    const review = put(), fetcher = request(); await processQualityClaims(db, review, { request: fetcher });
    db.prepare("UPDATE catalog_inferences SET result_json='null' WHERE kind='quality-claims'").run();
    expect(() => loadQualityClaims(db, review)).toThrow(ClaimsReviewError);
    await expect(processQualityClaims(db, review, { request: fetcher })).rejects.toBeInstanceOf(ClaimsReviewError);
    db.prepare("UPDATE catalog_inferences SET result_json=?,entity_id='another-review' WHERE kind='quality-claims'").run(JSON.stringify(good));
    expect(() => loadQualityClaims(db, review)).toThrow(/provenance/);
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(1);
  });
  it('preserves the selected model override and rejects malformed wire shape', () => {
    expect(qualityClaimsModel()).toBe('gpt-4.1-mini-2025-04-14');
    for (const raw of [wire(good, { output: [null] }), wire(good, { model: '' }), wire(good, { output: [] }), wire(good, { output: [{ content: [null] }] })])
      expect(() => parseQualityClaimsWire(raw, text)).toThrow();
  });
});
