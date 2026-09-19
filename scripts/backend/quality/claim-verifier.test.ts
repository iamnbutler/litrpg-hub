import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JevReviewError, JevTransactionError } from '../catalog/paid-jev.js';
import { type JevResponse, type Question, evaluate as callJev } from '../jev/client.js';
import { qualityQuestions } from './assessment.js';
import { loadQualityClaims, qualityClaimsHash, qualityClaimsReceiptId, QUALITY_CLAIMS_VERSION,
  type QualityClaimExtraction } from './claims.js';
import { qualityEvidenceFor, type QualityReview } from './evidence.js';
import { loadVerifiedQualityClaims, planQualityClaimsVerification, processVerifiedQualityClaims,
  qualityClaimVerificationHash, qualityClaimVerificationQuestions, qualityClaimVerificationReceiptId,
  qualityClaimVerificationState, QUALITY_CLAIM_VERIFICATION_KIND, QUALITY_CLAIM_VERIFICATION_VERSION } from './claim-verifier.js';

let db: Database.Database;
const praise = 'The prose is precise and fluent.';
const criticism = 'The final revelation contradicts the established rules.';
const text = `${praise} ${criticism} The final section gives the earlier setup a satisfying payoff.`;
const claimsModel = 'claims-test', model = 'jev-test';
const good: QualityClaimExtraction = { claims: [{ aspect: 'prose', polarity: 'positive',
  quotes: [{ polarity: 'positive', text: praise }], rationale: 'PRIVATE_EXTRACTOR_RATIONALE_DO_NOT_SEND' }] };
const neverFetch = vi.fn(() => { throw new Error('Unexpected real network request.'); });
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
  vi.stubEnv('QUALITY_CLAIMS_MODEL', claimsModel); vi.stubEnv('JEV_MODEL', model);
  neverFetch.mockClear(); vi.stubGlobal('fetch', neverFetch);
});
afterEach(() => {
  expect(neverFetch).not.toHaveBeenCalled();
  if (db.inTransaction) db.exec('ROLLBACK');
  db.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
function put(body = text): QualityReview {
  db.prepare(`INSERT INTO catalog_reader_evidence VALUES('review-one','work-a',?,'PRIVATE_VOICE',5,5,'2026-01-01',
    'hardcover.app','https://hardcover.app/books/testing',0,NULL)`).run(body);
  return qualityEvidenceFor(db, 'work-a').reviews[0];
}
function holdClaims(review: QualityReview, value: QualityClaimExtraction = good) {
  db.prepare(`INSERT INTO catalog_inferences VALUES(?,'reader-evidence',?,'quality-claims',?,?,?, ?,?,?,?)`)
    .run(qualityClaimsReceiptId(review, claimsModel), review.id, qualityClaimsHash(review, claimsModel), claimsModel,
      'claims-actual', QUALITY_CLAIMS_VERSION, JSON.stringify(value), JSON.stringify({ input_tokens: 100, output_tokens: 20 }), '2026-01-02');
}
function answer(questions: Record<string, Question>, support = 0.95, complete = 0.95): JevResponse {
  return { model: 'jev-actual', usage: { input_tokens: 120, output_tokens: 30 },
    answers: Object.fromEntries(Object.keys(questions).map(key => [key, { type: 'noul', noul: key.endsWith('_supported') ? support : complete }])) };
}
function evaluator(support = 0.95, complete = 0.95) {
  return vi.fn(async (_state, questions) => answer(questions, support, complete)) as unknown as typeof callJev;
}
function verificationRows() {
  return db.prepare("SELECT * FROM catalog_inferences WHERE kind LIKE 'quality-claims-verification%' ORDER BY kind").all() as {
    id: string; kind: string; input_hash: string; result_json: string; usage_json: string;
  }[];
}

describe('semantic claim verification contract', () => {
  it('plans without acquisition and refuses to buy extraction as a side effect', async () => {
    const review = put(), evaluate = evaluator();
    expect(planQualityClaimsVerification(db, review)).toMatchObject({ status: 'missing-claims', inputHash: null, candidateAspects: [] });
    expect(loadVerifiedQualityClaims(db, review)).toBeNull();
    await expect(processVerifiedQualityClaims(db, review, { evaluate })).rejects.toThrow(/extraction must be run separately/);
    expect(evaluate).not.toHaveBeenCalled(); expect(verificationRows()).toEqual([]);
  });

  it('builds two noul questions per nonunknown candidate and reuses exact shared definitions', () => {
    const review = put();
    holdClaims(review, { claims: [...good.claims, { aspect: 'editing', polarity: 'unknown', quotes: [], rationale: 'No evidence.' }] });
    const extraction = loadQualityClaims(db, review)!;
    const questions = qualityClaimVerificationQuestions(extraction);
    expect(Object.keys(questions)).toEqual(['prose_supported', 'prose_complete']);
    for (const question of Object.values(questions)) {
      expect(question.type).toBe('noul');
      expect(question.instructions).toContain(qualityQuestions.prose_relevance.instructions);
    }
    const state = JSON.stringify(qualityClaimVerificationState(review, extraction));
    expect(state).toContain(praise); expect(state).toContain(criticism);
    expect(state).not.toContain(good.claims[0].rationale);
    expect(state).not.toContain('PRIVATE_VOICE'); expect(state).not.toContain('rating');
  });

  it('declares support and opposite-side completeness rules without claiming tests prove model accuracy', () => {
    const review = put(); holdClaims(review);
    const questions = qualityClaimVerificationQuestions(loadQualityClaims(db, review)!);
    expect(questions.prose_supported.instructions).toContain('Literal containment alone is not support');
    expect(questions.prose_supported.instructions).toContain('omitted negation');
    expect(questions.prose_supported.instructions).toContain('different-book/series scope');
    expect(questions.prose_supported.instructions).toContain('classifier uncertainty or an ambiguous/adequate judgment is not mixed');
    expect(questions.prose_complete.instructions).toContain('material opposite-side claim');
    expect(questions.prose_complete.instructions).toContain('Praise of a different aspect or liking a character is not an omitted positive side');
  });

  it.each([
    [0.85, 0.85, 'verified', []], [0.849, 0.99, 'needs-review', ['supported']],
    [0.99, 0.849, 'needs-review', ['complete']], [0.1, 0.2, 'needs-review', ['supported', 'complete']]
  ] as const)('requires both semantic gates (%s, %s)', async (supported, complete, status, failedGates) => {
    const review = put(); holdClaims(review);
    const result = await processVerifiedQualityClaims(db, review, { evaluate: evaluator(supported, complete) });
    expect(result.claims).toEqual([{ aspect: 'prose', polarity: 'positive', status, supported, complete, failedGates }]);
  });

  it('keeps unknown and empty extractions unknown without making a Jev call', async () => {
    const review = put(), evaluate = evaluator();
    holdClaims(review, { claims: [{ aspect: 'editing', polarity: 'unknown', quotes: [], rationale: 'Absent.' }] });
    expect(planQualityClaimsVerification(db, review)).toMatchObject({ status: 'no-candidates', candidateAspects: [] });
    expect((await processVerifiedQualityClaims(db, review, { evaluate })).claims).toEqual([
      { aspect: 'editing', polarity: 'unknown', status: 'unknown', supported: null, complete: null, failedGates: [] }
    ]);
    db.prepare('UPDATE catalog_inferences SET result_json=?').run(JSON.stringify({ claims: [] }));
    expect(await processVerifiedQualityClaims(db, review, { evaluate })).toMatchObject({ claims: [], receiptId: null,
      cached: true, input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0 });
    expect(evaluate).not.toHaveBeenCalled(); expect(verificationRows()).toEqual([]);
  });

  it('does not export quotations, complete review text, rationale or voice identity in results or plans', async () => {
    const review = put(); holdClaims(review);
    const result = await processVerifiedQualityClaims(db, review, { evaluate: evaluator() });
    const output = JSON.stringify({ result, plan: planQualityClaimsVerification(db, review) });
    for (const privateValue of [praise, criticism, review.comment, good.claims[0].rationale, 'PRIVATE_VOICE'])
      expect(output).not.toContain(privateValue);
    expect(result).toMatchObject({ verification: 'semantic-support-and-polarity-completeness',
      intendedUse: 'private-classifier-comparison', extraction: { model: 'claims-actual', requestedModel: claimsModel },
      requestedModel: model, model: 'jev-actual' });
    expect(result.claims[0].polarity).toBe('positive');
  });
});

describe('durable and current verifier bindings', () => {
  it('retains the result, reports exact fresh usage and replays it without new calls', async () => {
    const review = put(), evaluate = evaluator(); holdClaims(review);
    const plan = planQualityClaimsVerification(db, review);
    expect(plan).toMatchObject({ status: 'pending', candidateAspects: ['prose'] });
    const first = await processVerifiedQualityClaims(db, review, { evaluate });
    expect(first).toMatchObject({ cached: false, input_tokens: 120, output_tokens: 30, unknownUsageResponses: 0 });
    const second = await processVerifiedQualityClaims(db, review, { evaluate });
    expect(second).toMatchObject({ cached: true, input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0 });
    expect(second).toEqual(loadVerifiedQualityClaims(db, review));
    expect(planQualityClaimsVerification(db, review)).toMatchObject({ status: 'complete', inputHash: plan.inputHash });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('binds review, extraction receipt, content and requested/actual models, excluding rationale', () => {
    const review = put(); holdClaims(review);
    const extraction = loadQualityClaims(db, review)!, original = qualityClaimVerificationHash(review, extraction);
    expect(qualityClaimVerificationHash(review, { ...extraction, claims: good.claims.map(c => ({ ...c, rationale: 'Different non-evidence note.' })) })).toBe(original);
    expect(qualityClaimVerificationHash(review, { ...extraction, model: 'different-actual' })).not.toBe(original);
    expect(qualityClaimVerificationHash(review, extraction, { model: 'different-verifier' })).not.toBe(original);
    expect(() => qualityClaimVerificationHash(review, extraction, { claimsModel: 'different-extractor' })).toThrow();
    expect(() => qualityClaimVerificationHash({ ...review, workId: 'wrong' }, extraction)).toThrow();
    expect(() => qualityClaimVerificationHash(review, { ...extraction, receiptId: 'wrong' })).toThrow();
    expect(() => qualityClaimVerificationHash(review, { ...extraction, receiptKind: 'quality-claims-wire' })).toThrow();
  });

  it('invalidates a previous verification when candidate contents change even under the same extraction input', async () => {
    const review = put(); holdClaims(review);
    const first = await processVerifiedQualityClaims(db, review, { evaluate: evaluator() });
    const changed: QualityClaimExtraction = { claims: [{ aspect: 'coherence', polarity: 'negative',
      quotes: [{ polarity: 'negative', text: criticism }], rationale: 'A different claim.' }] };
    db.prepare('UPDATE catalog_inferences SET result_json=? WHERE id=?').run(JSON.stringify(changed), qualityClaimsReceiptId(review, claimsModel));
    expect(loadVerifiedQualityClaims(db, review)).toBeNull();
    const plan = planQualityClaimsVerification(db, review);
    expect(plan.status).toBe('pending'); expect(plan.inputHash).not.toBe(first.inputHash);
    expect(verificationRows()).toHaveLength(1);
  });

  it.each(['body', 'removed', 'source'])('rejects stale %s evidence before spending', async changed => {
    const review = put(), evaluate = evaluator(); holdClaims(review);
    if (changed === 'body') db.prepare('UPDATE catalog_reader_evidence SET body=?').run(`${text} The dialogue repeats itself unnecessarily.`);
    if (changed === 'removed') db.exec("UPDATE catalog_reader_evidence SET removed_at='2026-02-01'");
    if (changed === 'source') db.exec("UPDATE catalog_reader_evidence SET source_url='https://example.com/new-source'");
    expect(planQualityClaimsVerification(db, review).status).toBe('missing-claims');
    await expect(processVerifiedQualityClaims(db, review, { evaluate })).rejects.toBeInstanceOf(JevReviewError);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('refuses a mismatched retained extraction instead of buying a verifier answer for it', async () => {
    const review = put(), evaluate = evaluator(); holdClaims(review);
    db.exec("UPDATE catalog_inferences SET entity_id='different-review'");
    await expect(processVerifiedQualityClaims(db, review, { evaluate })).rejects.toThrow(/provenance/);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('retains a paid answer but refuses promotion when extraction changes during the request', async () => {
    const review = put(); holdClaims(review);
    const evaluate = vi.fn(async (_state, questions) => {
      db.prepare('UPDATE catalog_inferences SET result_json=? WHERE id=?').run(JSON.stringify({ claims: [] }), qualityClaimsReceiptId(review, claimsModel));
      return answer(questions);
    }) as unknown as typeof callJev;
    const error = await processVerifiedQualityClaims(db, review, { evaluate }).catch(error => error);
    expect(error).toBeInstanceOf(JevReviewError); expect(error.usage).toEqual({ input_tokens: 120, output_tokens: 30 });
    expect(verificationRows()).toHaveLength(1);
    expect(loadVerifiedQualityClaims(db, review)).toMatchObject({ claims: [], receiptId: null });
  });

  it('retains an answer against its original hash when the review changes during verification', async () => {
    const review = put(); holdClaims(review);
    const original = planQualityClaimsVerification(db, review);
    const evaluate = vi.fn(async (_state, questions) => {
      db.prepare('UPDATE catalog_reader_evidence SET body=?').run(`${text} This later edit adds a material qualification.`);
      return answer(questions);
    }) as unknown as typeof callJev;
    const error = await processVerifiedQualityClaims(db, review, { evaluate }).catch(error => error);
    expect(error).toBeInstanceOf(JevReviewError); expect(error.usage).toEqual({ input_tokens: 120, output_tokens: 30 });
    expect(verificationRows()).toMatchObject([{ input_hash: original.inputHash }]);
    expect(loadVerifiedQualityClaims(db, review)).toBeNull();
    expect(planQualityClaimsVerification(db, qualityEvidenceFor(db, review.workId).reviews[0]).status).toBe('missing-claims');
  });

  it.each(['entity_type', 'entity_id', 'kind', 'input_hash', 'requested_model', 'rubric_version', 'actual_model'])
    ('parks a corrupted %s binding without rebuying', async column => {
      const review = put(), evaluate = evaluator(); holdClaims(review);
      const result = await processVerifiedQualityClaims(db, review, { evaluate });
      db.prepare(`UPDATE catalog_inferences SET ${column}='wrong' WHERE id=?`).run(result.receiptId);
      expect(() => loadVerifiedQualityClaims(db, review)).toThrow(JevReviewError);
      await expect(processVerifiedQualityClaims(db, review, { evaluate })).rejects.toBeInstanceOf(JevReviewError);
      expect(evaluate).toHaveBeenCalledTimes(1);
    });

  it('keeps a malformed paid wire and replays its failure free', async () => {
    const review = put(); holdClaims(review);
    const evaluate = vi.fn(async (_state, _questions, options) => {
      await options?.onResponse?.('{"model":"jev-actual","usage":{"input_tokens":120,"output_tokens":30}}');
      throw new Error('The paid response had no answers.');
    }) as unknown as typeof callJev;
    const first = await processVerifiedQualityClaims(db, review, { evaluate }).catch(error => error);
    expect(first).toBeInstanceOf(JevReviewError); expect(first.usage).toEqual({ input_tokens: 120, output_tokens: 30 });
    expect(verificationRows()[0].kind).toBe(`${QUALITY_CLAIM_VERIFICATION_KIND}-wire`);
    const replay = await processVerifiedQualityClaims(db, review, { evaluate }).catch(error => error);
    expect(replay).toBeInstanceOf(JevReviewError); expect(replay.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('retains a successful wire before parsing and records usage exactly once', async () => {
    const review = put(); holdClaims(review);
    const evaluate = vi.fn(async (_state, questions, options) => {
      const response = answer(questions);
      await options?.onResponse?.(JSON.stringify(response));
      const held = verificationRows();
      expect(held).toHaveLength(1); expect(held[0].kind).toBe(`${QUALITY_CLAIM_VERIFICATION_KIND}-wire`);
      return response;
    }) as unknown as typeof callJev;
    expect(await processVerifiedQualityClaims(db, review, { evaluate })).toMatchObject({ cached: false, input_tokens: 120, output_tokens: 30 });
    const rows = verificationRows();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows.find(row => row.kind.endsWith('-wire'))!.usage_json)).toEqual({ input_tokens: 120, output_tokens: 30 });
    expect(JSON.parse(rows.find(row => !row.kind.endsWith('-wire'))!.usage_json)).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(await processVerifiedQualityClaims(db, review, { evaluate })).toMatchObject({ cached: true, input_tokens: 0, output_tokens: 0 });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('loads a valid interrupted wire without writes or another purchase', async () => {
    const review = put(), evaluate = evaluator(); holdClaims(review);
    const extraction = loadQualityClaims(db, review)!, inputHash = qualityClaimVerificationHash(review, extraction);
    const response = answer(qualityClaimVerificationQuestions(extraction));
    const id = qualityClaimVerificationReceiptId(review.id, inputHash, true);
    db.prepare(`INSERT INTO catalog_inferences VALUES(?,'reader-evidence',?,?,?,?,?,?,?,?,?)`).run(id, review.id,
      `${QUALITY_CLAIM_VERIFICATION_KIND}-wire`, inputHash, model, response.model, QUALITY_CLAIM_VERIFICATION_VERSION,
      JSON.stringify({ text: JSON.stringify(response) }), JSON.stringify(response.usage), '2026-01-03');
    const count = verificationRows().length;
    expect(loadVerifiedQualityClaims(db, review)).toMatchObject({ receiptId: id, cached: true, input_tokens: 0 });
    expect(await processVerifiedQualityClaims(db, review, { evaluate })).toMatchObject({ receiptId: id, cached: true });
    expect(verificationRows()).toHaveLength(count); expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not poison the cache with transport failure and refuses spend under a caller transaction', async () => {
    const review = put(), evaluate = evaluator(); holdClaims(review);
    db.exec('BEGIN');
    await expect(processVerifiedQualityClaims(db, review, { evaluate })).rejects.toBeInstanceOf(JevTransactionError);
    expect(evaluate).not.toHaveBeenCalled(); db.exec('ROLLBACK');
    const rejected = vi.fn(async () => { throw new Error('Jev returned HTTP 401.'); }) as unknown as typeof callJev;
    await expect(processVerifiedQualityClaims(db, review, { evaluate: rejected })).rejects.toThrow(/401/);
    expect(verificationRows()).toEqual([]);
    expect((await processVerifiedQualityClaims(db, review, { evaluate })).claims[0].status).toBe('verified');
  });
});
