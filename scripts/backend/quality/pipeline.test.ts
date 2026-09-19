import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQualityIndex, planQualityJobs, processQualityJob } from './pipeline.js';
import { qualityEvidenceFor } from './evidence.js';
import { qualityQuestions, qualityReceiptId, qualityReviewHash, QUALITY_RUBRIC_VERSION } from './assessment.js';
import { persistQualityIndex, writeQualityReport } from './store.js';
import { benchmarkQuality, runSyntheticBenchmarks } from './benchmark.js';
import type { JevResponse } from '../jev/client.js';

let db: Database.Database;
const now = new Date('2026-09-19T12:00:00Z');
beforeEach(() => {
  db = new Database(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.prepare("INSERT INTO catalog_series(id,title,author,updated_at) VALUES('s','A series','A Writer',?)").run(now.toISOString());
  db.prepare(`INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES('w','s',1,'A book','A Writer','https://publisher.example/books/w',?)`).run(now.toISOString());
  for (let i = 1; i <= 6; i++) {
    db.prepare(`INSERT INTO catalog_reader_evidence(id,work_id,series_id,source_url,external_id,body,contains_spoilers,observed_at,source_name,author_key)
      VALUES(?, 'w','s','https://hardcover.app/books/w',?,?,0,?,'hardcover.app',?)`)
      .run(`r${i}`, `external${i}`, `PRIVATE_REVIEW_${i}: the careful prose is lucid and the plotting establishes consequences that it follows through on.`, now.toISOString(), `voice${i}`);
  }
});
afterEach(() => db.close());
function retain() {
  for (const review of qualityEvidenceFor(db, 'w').reviews) {
    const response: JevResponse = { model: 'test', usage: { input_tokens: 100, output_tokens: 20 }, answers: {} };
    for (const [key, q] of Object.entries(qualityQuestions)) {
      if (q.type !== 'choice') throw new Error('fixture expects choices');
      const relevant = ['prose', 'structure'].some(a => key.startsWith(a));
      const choice = relevant ? key.endsWith('_relevance') ? 'direct' : 'good' : 'unknown';
      response.answers[key] = { type: 'choice', choice, confidence: .99,
        probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) };
    }
    db.prepare(`INSERT INTO catalog_inferences(id,entity_type,entity_id,kind,input_hash,requested_model,actual_model,rubric_version,result_json,usage_json,evaluated_at)
      VALUES(?, 'reader-evidence',?,'quality-review',?,'test','test',?,?, '{}',?)`).run(qualityReceiptId(review, 'test'), review.id,
        qualityReviewHash(review, 'test'), QUALITY_RUBRIC_VERSION, JSON.stringify(response), now.toISOString());
  }
}
const build = () => buildQualityIndex(db, { now, model: 'test', catalogBooks: [], renownEvidence: [] });

describe('quality catalog integration', () => {
  it('scores all three surfaces but never exports comments, ratings or private voice keys', () => {
    retain();
    const r = build();
    expect(r.totals).toMatchObject({ scoredBooks: 1, scoredSeries: 1, scoredAuthors: 1 });
    expect(r.books[0].craft.score).toBe(75);
    expect(r.series[0].coverage.catalogComplete).toBe(false);
    expect(r.authors[0].craft.score).toBe(75);
    const json = JSON.stringify(r);
    for (const privateText of ['PRIVATE_REVIEW', 'external1', 'voice1', 'ratingCount', 'meanRating']) expect(json).not.toContain(privateText);
  });
  it('changing every star value cannot change scores, inputs, aggregation or queued work', () => {
    retain();
    const before = build();
    db.exec('UPDATE catalog_reader_evidence SET rating=5,rating_best=5');
    expect(build()).toEqual(before);
    expect(planQualityJobs(db, { model: 'test' })).toEqual({ queued: 0, selected: 6, cached: 6, unusable: 0 });
  });
  it('does not reuse judgments when review evidence changes or is removed', () => {
    retain();
    db.exec("UPDATE catalog_reader_evidence SET body='An entirely different sufficiently long review of the plot and prose.' WHERE id='r1'");
    db.exec("UPDATE catalog_reader_evidence SET removed_at='2026-09-19' WHERE id='r2'");
    const result = build().books[0];
    expect(result.evidence).toMatchObject({ sampledVoices: 5, judgedVoices: 4, pendingReviews: 1 });
    expect(result.craft.score).toBeNull();
  });
  it('idempotently queues per-review jobs and skips obsolete payloads before spending', async () => {
    expect(planQualityJobs(db, { model: 'test' }).queued).toBe(6);
    expect(planQualityJobs(db, { model: 'test' }).queued).toBe(0);
    const row = db.prepare('SELECT payload_json FROM catalog_jobs ORDER BY id LIMIT 1').get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json);
    db.prepare('UPDATE catalog_reader_evidence SET removed_at=? WHERE id=?').run(now.toISOString(), payload.reviewId);
    expect(await processQualityJob(db, payload)).toMatchObject({ input_tokens: 0, output_tokens: 0, unknownUsageResponses: 0, skipped: expect.any(String) });
  });
  it('never converts frequent audio releases into a production penalty', () => {
    for (let n = 1; n <= 4; n++) {
      db.prepare(`INSERT INTO catalog_editions(id,work_id,format,title,source_url,source_name,release_date,updated_at) VALUES(?,'w','audiobook','A book','https://publisher.example/audio','publisher',?,?)`)
        .run(`audio${n}`, `2026-0${n}-01`, now.toISOString());
    }
    retain();
    const series = build().series[0];
    expect(series.audioCadence.releasedWorks).toBe(1);
    expect(series.production.status).toBe('unknown');
    expect(series.index.adjustments).toEqual([]);
  });
  it('does not spend queued work when the current sample shrinks below five voices', async () => {
    planQualityJobs(db, { model: 'test' });
    const row = db.prepare("SELECT payload_json FROM catalog_jobs WHERE entity_id='r1'").get() as { payload_json: string };
    db.exec("UPDATE catalog_reader_evidence SET removed_at='2026-09-19' WHERE id IN ('r5','r6')");
    expect(await processQualityJob(db, JSON.parse(row.payload_json))).toMatchObject({ input_tokens: 0, skipped: expect.stringContaining('five-voice') });
  });
  it('a corrupt receipt is isolated rather than halting planning or being bought again', () => {
    retain();
    db.exec("UPDATE catalog_inferences SET result_json='{}' WHERE entity_id='r1'");
    expect(planQualityJobs(db, { model: 'test' })).toEqual({ queued: 0, selected: 6, cached: 5, unusable: 1 });
    expect(build().books[0].craft.score).toBeNull();
  });
  it('holds unassessed books as unknown and reports missing dimensions', () => {
    const r = build();
    expect(r.books[0].craft.score).toBeNull();
    expect(r.books[0].craft.missingDimensions).toHaveLength(6);
    expect(r.authors[0].craft.score).toBeNull();
  });
  it('stores append-only snapshots once per content, excluding generated time', () => {
    retain(); const report = build();
    const one = persistQualityIndex(db, report);
    expect(persistQualityIndex(db, { ...report, generatedAt: '2026-09-20T00:00:00Z' })).toBe(one);
    expect(db.prepare('SELECT COUNT(*) AS n FROM quality_index_scores').get()).toEqual({ n: 3 });
    db.exec("UPDATE catalog_reader_evidence SET removed_at='2026-09-19' WHERE id IN ('r1','r2')");
    expect(persistQualityIndex(db, build())).not.toBe(one);
    expect(db.prepare('SELECT COUNT(*) AS n FROM quality_index_runs').get()).toEqual({ n: 2 });
  });
  it('benchmarks never treat an unscored anchor as a pass', () => {
    const r = benchmarkQuality(build());
    expect(r.summary.anchorsWithinBand).toBe(0);
    expect(r.summary.anchorsWithAdequateEvidence).toBe(0);
    expect(r.anchors.every(a => a.comparison === 'unscored')).toBe(true);
    expect(runSyntheticBenchmarks().every(c => c.passed)).toBe(true);
  });
  it('advances the current head on A -> B -> A without rewriting snapshots or accepting stale imports', () => {
    retain(); const a = build();
    const aId = persistQualityIndex(db, a);
    const b = { ...a, generatedAt: '2026-09-19T13:00:00Z', books: a.books.map(book => ({ ...book, title: 'Changed title' })) };
    const bId = persistQualityIndex(db, b);
    expect(bId).not.toBe(aId);
    expect(db.prepare('SELECT run_id FROM quality_index_head').get()).toEqual({ run_id: bId });
    const reverted = { ...a, generatedAt: '2026-09-19T14:00:00Z' };
    expect(persistQualityIndex(db, reverted)).toBe(aId);
    const head = { run_id: aId, generated_at: '2026-09-19T14:00:00.000Z' };
    expect(db.prepare('SELECT run_id,generated_at FROM quality_index_head').get()).toEqual(head);
    persistQualityIndex(db, b);
    persistQualityIndex(db, reverted);
    expect(db.prepare('SELECT run_id,generated_at FROM quality_index_head').get()).toEqual(head);
    expect(db.prepare('SELECT generated_at FROM quality_index_runs WHERE id=?').get(aId)).toEqual({ generated_at: a.generatedAt });
    expect(db.prepare('SELECT COUNT(*) AS n FROM quality_index_runs').get()).toEqual({ n: 2 });
  });
  it('writes a complete file atomically and refuses database output paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quality-report-'));
    try {
      const file = join(dir, 'quality.json'); writeQualityReport(file, { complete: true });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ complete: true });
      expect(() => writeQualityReport(join(dir, 'books.db'), {})).toThrow('database');
      expect(() => writeQualityReport(join(dir, 'books.db-wal'), {})).toThrow('database');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
