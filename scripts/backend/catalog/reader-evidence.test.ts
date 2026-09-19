import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claim, fail, finish, hash } from './queue.js';
import { PaidResponseStorageError, ReviewError } from './types.js';
import { extractProductReviews, bodyKey, CONSISTENCY_CLAIM, observationInput, ReaderTransactionError, observationStatus, observationCost, normalizeUsage, ReaderPaidStorageError, fetchObservation, GENERIC_DIVISION_OPENER, observationHash, OBSERVATION_VERSION, PREVALENCE_QUANTIFIER, readerState, importReaderEvidence, ObservationReviewError, readerJobKind, readerJobKinds, linkIndex, planReaderTraitJobs, processReaderTraits, validateObservation, verbatimOverlap, readerCeiling, processReaderObservation, readerContext, readerEvidenceFor, readerQuestions, readerState, readerTraitHash, traitInput, readerThresholds, readerTraits, summarizeReaderEvidence, surveyReaderEvidence } from './reader-evidence.js';
import type { JevResponse } from '../jev/client.js';

const MIGRATIONS = ['001_initial.sql','002_cursor_results_found.sql','003_jev_assessments.sql','004_cover_assessments.sql','005_source_history.sql','006_catalog_pipeline.sql','007_author_profiles.sql','008_reader_evidence.sql','010_reader_trait_honesty.sql'];
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  for (const name of MIGRATIONS) db.exec(readFileSync(join(import.meta.dirname, '../migrations', name), 'utf8'));
});
afterEach(() => db.close());

const PRODUCT_URL = 'https://soundbooththeater.com/shop/audiobooks/a-series-book-1/';
const review = (author: string, body: string, rating = 5, date = '2026-03-01') => ({
  '@type': 'Review', reviewRating: { '@type': 'Rating', ratingValue: String(rating), bestRating: '5', worstRating: '1' },
  author: { '@type': 'Person', name: author }, reviewBody: body, datePublished: `${date}T00:00:00-04:00`
});
const page = (reviews: unknown[]) => `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org/', '@type': 'Product', name: 'A Series Book 1',
  aggregateRating: { '@type': 'AggregateRating', ratingValue: '5.00', reviewCount: reviews.length }, review: reviews
})}</script></head><body>Buy now</body></html>`;

function addDocument(url: string, body: string, id = `doc-${url}`) {
  db.prepare('INSERT OR REPLACE INTO catalog_documents(id,url,content_hash,body,fetched_at) VALUES(?,?,?,?,?)').run(id, url, `hash-${id}`, body, '2026-09-01T00:00:00.000Z');
}
function addWork(url: string, workId = 'work-1', seriesId = 'series-1') {
  db.prepare('INSERT OR IGNORE INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seriesId, 'A Series', 'An Author', '2026-09-01T00:00:00.000Z');
  db.prepare('INSERT OR IGNORE INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)').run(workId, seriesId, 1, 'A Series Book 1', 'An Author', url, '2026-09-01T00:00:00.000Z');
}

describe('reader evidence extraction', () => {
  it('reads the publisher structured markup and never retains the commenter name', () => {
    const found = extractProductReviews(page([review('Reviewer One', 'A long, genuinely substantive review about pacing and narration quality.')]), PRODUCT_URL);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rating: 5, ratingBest: 5, publishedAt: '2026-03-01', kind: 'review', sourceName: 'soundbooththeater.com' });
    // A storefront review carries no spoiler marker, so the unsafe case is assumed.
    expect(found[0].containsSpoilers).toBe(true);
    expect(JSON.stringify(found[0])).not.toContain('Reviewer One');
    // Two comments by the same person are one voice; two people are two.
    const same = extractProductReviews(page([review('Ann', 'One review body that is quite long indeed.'), review('Ann', 'Another review body, also fairly long.')]), PRODUCT_URL);
    expect(new Set(same.map(r => r.authorKey)).size).toBe(1);
    const different = extractProductReviews(page([review('Ann', 'One review body that is quite long indeed.'), review('Bo', 'Another review body, also fairly long.')]), PRODUCT_URL);
    expect(new Set(different.map(r => r.authorKey)).size).toBe(2);
  });

  it('imports from cached documents only, idempotently, with provenance', () => {
    addWork(PRODUCT_URL);
    addDocument(PRODUCT_URL, page([review('Ann', 'A substantive review about the narration and the pacing of this book.'), review('Bo', 'Another substantive review discussing worldbuilding at some length.')]));
    expect(importReaderEvidence(db)).toEqual({ documents: 1, found: 2, stored: 2 });
    // Re-importing the same cached page stores nothing new.
    expect(importReaderEvidence(db)).toMatchObject({ found: 2, stored: 0 });
    const rows = db.prepare('SELECT * FROM catalog_reader_evidence').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ work_id: 'work-1', series_id: 'series-1', document_id: `doc-${PRODUCT_URL}`, source_name: 'soundbooththeater.com', contains_spoilers: 1 });
    expect(rows.every(r => typeof r.author_key === 'string' && (r.author_key as string).length === 32)).toBe(true);
  });

  it('ignores a page with no structured reviews rather than inventing any', () => {
    addWork(PRODUCT_URL);
    addDocument(PRODUCT_URL, '<html><body>No structured data here at all.</body></html>');
    expect(importReaderEvidence(db)).toMatchObject({ found: 0, stored: 0 });
    expect(surveyReaderEvidence(db)).toEqual([]);
  });
});

describe('reader evidence refuses to become consensus', () => {
  it('will not aggregate a storefront testimonial widget', () => {
    // This is the real shape of the cached Soundbooth Theater corpus: a few five-star one-liners.
    addWork(PRODUCT_URL);
    addDocument(PRODUCT_URL, page([
      // Shaped like the real cached corpus — an in-joke and a one-line blurb — without
      // reproducing anyone's actual words or name in a committed file.
      review('Reviewer One', 'Five out of five shopping trolleys, no notes whatsoever'),
      review('Reviewer Two', 'Great story, great narrator!')
    ]));
    importReaderEvidence(db);
    const summary = summarizeReaderEvidence('work-1', readerEvidenceFor(db, 'work', 'work-1'));
    expect(summary).toMatchObject({ samples: 2, voices: 2, eligible: false });
    expect(summary.reason).toContain(`${readerThresholds.voices} needed`);
    // Uniformly positive ratings are reported, never read as agreement about anything.
    expect(summary.meanRating).toBe(5);
  });

  it('will not let one prolific commenter look like a consensus', () => {
    addWork(PRODUCT_URL);
    addDocument(PRODUCT_URL, page(Array.from({ length: 8 }, (_, i) => review('Ann', `Review number ${i} with plenty of substantive detail about the book.`, 5, `2026-03-0${i + 1}`))));
    importReaderEvidence(db);
    const summary = summarizeReaderEvidence('work-1', readerEvidenceFor(db, 'work', 'work-1'));
    expect(summary).toMatchObject({ samples: 8, voices: 1, substantiveVoices: 1, eligible: false });
    expect(summary.reason).toContain('1 distinct voice has');
  });

  it('becomes eligible only with enough independent, substantive voices', () => {
    addWork(PRODUCT_URL);
    addDocument(PRODUCT_URL, page(['Ann','Bo','Cy','Di','Ed'].map((name, i) =>
      review(name, `A substantive review from ${name} about pacing, narration and worldbuilding.`, 4 + (i % 2), `2026-03-0${i + 1}`))));
    importReaderEvidence(db);
    const summary = summarizeReaderEvidence('work-1', readerEvidenceFor(db, 'work', 'work-1'));
    expect(summary).toMatchObject({ voices: 5, substantive: 5, substantiveVoices: 5, eligible: true, span: ['2026-03-01', '2026-03-05'] });
  });

  it('counts short one-liners as voices but not as substantive evidence', () => {
    addWork(PRODUCT_URL);
    addDocument(PRODUCT_URL, page(['Ann','Bo','Cy','Di','Ed'].map(name => review(name, 'Loved it!'))));
    importReaderEvidence(db);
    const summary = summarizeReaderEvidence('work-1', readerEvidenceFor(db, 'work', 'work-1'));
    expect(summary).toMatchObject({ voices: 5, substantive: 0, substantiveVoices: 0, eligible: false });
    expect(summary.reason).toContain('substantive');
  });
});

describe('the exported view carries no reader text', () => {
  it('reports counts and uncertainty without a single raw body or name', () => {
    addWork(PRODUCT_URL);
    const secret = 'A verbatim reader sentence that must never reach the public catalog export.';
    addDocument(PRODUCT_URL, page([review('Ann', secret), review('Bo', 'Another private review body of sufficient length to be stored.')]));
    importReaderEvidence(db);
    const context = readerContext(db, 'work', 'work-1')!;
    expect(context).toMatchObject({ entity: 'work-1', voices: 2, samples: 2, traits: [] });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Ann');
    // The raw text is retained privately, so evidence is auditable even though it is never exported.
    expect((db.prepare('SELECT body FROM catalog_reader_evidence WHERE body=?').get(secret) as { body: string }).body).toBe(secret);
  });

  it('returns nothing at all for an entity with no reader evidence', () => {
    addWork(PRODUCT_URL);
    expect(readerContext(db, 'work', 'work-1')).toBeNull();
  });
});


const answer = (choice: string, confidence: number, keys: string[]) => ({ type: 'choice' as const, choice, confidence,
  probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) });
const readerStub = (traits: Record<string, [string, number]>, consensus = 'consistent'): JevResponse => ({
  model: 'jev-test', usage: { input_tokens: 400, output_tokens: 60 },
  answers: { ...Object.fromEntries(Object.entries(traits).map(([k, [c, n]]) => [k, answer(c, n, ['present','absent','unknown'])])),
    consensus: answer(consensus, 0.8, ['consistent','mixed','insufficient']) }
});
const ALL_UNKNOWN = Object.fromEntries(readerTraits.map(t => [t, ['unknown', 0.3] as [string, number]]));
function addVoices(count: number, body = (n: string) => `A substantive comment from ${n} about pacing, narration and the world.`) {
  addWork(PRODUCT_URL);
  addDocument(PRODUCT_URL, page(Array.from({ length: count }, (_, i) => review(`Reader${i}`, body(`Reader${i}`), 5, `2026-03-0${i + 1}`))));
  importReaderEvidence(db);
}

describe('reader traits', () => {
  it('links a review even when the work\'s canonical source is a different publisher', () => {
    db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run('series-1', 'A Series', 'An Author', '2026-09-01T00:00:00.000Z');
    // The canonical record prefers the publisher page; the retailer page is only an edition.
    db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('work-1', 'series-1', 1, 'A Series Book 1', 'An Author', 'https://aethonbooks.com/book/a-series-book-1/', '2026-09-01T00:00:00.000Z');
    db.prepare('INSERT INTO catalog_editions(id,work_id,format,title,source_url,source_name,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('edition-1', 'work-1', 'audiobook', 'A Series Book 1', PRODUCT_URL, 'soundbooththeater.com', '2026-09-01T00:00:00.000Z');
    expect(linkIndex(db).get(PRODUCT_URL)).toEqual({ workId: 'work-1', seriesId: 'series-1' });

    addDocument(PRODUCT_URL, page([review('Ann', 'A substantive review about narration and pacing across this book.')]));
    importReaderEvidence(db);
    expect(db.prepare('SELECT work_id, series_id FROM catalog_reader_evidence').get()).toEqual({ work_id: 'work-1', series_id: 'series-1' });
  });

  it('refuses to spend a call on evidence below the threshold', async () => {
    addVoices(2);
    const evaluateStub = vi.fn();
    const result = await processReaderTraits(db, 'work', 'work-1', { evaluate: evaluateStub as never });
    expect(result).toMatchObject({ eligible: false, recorded: [] });
    expect(result.skipped).toContain('needed');
    expect(evaluateStub).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_reader_traits').get()).toEqual({ n: 0 });
  });

  it('records a trait with an original summary, never the readers\' words', async () => {
    const verbatim = 'The narrator does every voice perfectly and I could not stop listening to this one.';
    addWork(PRODUCT_URL);
    // Distinct comments that happen to share a phrase: five real voices, not one copied five times.
    addDocument(PRODUCT_URL, page(['Ann','Bo','Cy','Di','Ed'].map((n, i) => review(n, `${verbatim} ${n} added a little more about book ${i + 1}.`, 5, `2026-03-0${i + 1}`))));
    importReaderEvidence(db);
    const evaluateStub = vi.fn(async () => readerStub({ ...ALL_UNKNOWN, 'narration-praised': ['present', 0.95] }));
    const result = await processReaderTraits(db, 'work', 'work-1', { evaluate: evaluateStub as never });
    expect(result).toMatchObject({ eligible: true, consensus: 'consistent', cached: false, input_tokens: 400 });
    expect(result.recorded).toEqual([...readerTraits]);

    const row = db.prepare("SELECT * FROM catalog_reader_traits WHERE trait='narration-praised'").get() as Record<string, string | number>;
    expect(row).toMatchObject({ value: 'present', voices: 5, consensus: 'consistent' });
    // No column claims a reader agreement fraction, because nothing classifies commenters individually.
    expect(Object.keys(row)).not.toContain('agreement');
    expect(Object.keys(row)).not.toContain('dissent');
    // Reader opinion can never reach the confidence a source-grounded signal can.
    expect(row.confidence).toBe(readerCeiling(5));
    expect(row.summary).toContain('5 sampled readers');
    // The finding leads; sampling and provenance live in the structured context, not in every trait.
    expect(String(row.summary).split(' ').length).toBeLessThan(25);
    expect(String(row.summary)).not.toContain(verbatim);
    expect(String(row.evidence_json)).not.toContain(verbatim);

    // A second run reuses the cached answer rather than paying again.
    const again = await processReaderTraits(db, 'work', 'work-1', { evaluate: evaluateStub as never });
    expect(again).toMatchObject({ cached: true, input_tokens: 0 });
    expect(evaluateStub).toHaveBeenCalledTimes(1);
  });

  it('keeps disagreement visible instead of resolving it', async () => {
    addVoices(6);
    await processReaderTraits(db, 'work', 'work-1', {
      evaluate: (async () => readerStub({ ...ALL_UNKNOWN, 'pacing-slow': ['present', 0.7] }, 'mixed')) as never });
    const row = db.prepare("SELECT consensus, summary FROM catalog_reader_traits WHERE trait='pacing-slow'").get() as { consensus: string; summary: string };
    expect(row.consensus).toBe('mixed');
    expect(row.summary).toContain('Readers disagreed; treat as a split opinion.');
    const context = readerContext(db, 'work', 'work-1')!;
    // One judgement about the whole sample, not a per-trait field that could read as a tally.
    expect(context.consensus).toBe('mixed');
    const trait = context.traits.find(t => t.trait === 'pacing-slow')!;
    expect(Object.keys(trait)).toEqual(['trait','value','confidence','modelConfidence','summary','voices']);
    expect(trait).not.toHaveProperty('consensus');
  });

  it('surfaces traits through the export view without leaking evidence', async () => {
    addVoices(6);
    await processReaderTraits(db, 'work', 'work-1', {
      evaluate: (async () => readerStub({ ...ALL_UNKNOWN, 'tone-humorous': ['present', 0.8] })) as never });
    const context = readerContext(db, 'work', 'work-1')!;
    expect(context.voices).toBe(6);
    expect(context.traits.find(t => t.trait === 'tone-humorous')).toMatchObject({ value: 'present' });
    expect(JSON.stringify(context)).not.toContain('substantive comment from Reader');
  });

  it('never offers a trait about sexual content or AI authorship', () => {
    const tokens = readerTraits.flatMap(t => t.split('-'));
    for (const forbidden of ['sexual', 'sexualized', 'explicit', 'harem', 'ai', 'quality']) {
      expect(tokens, forbidden).not.toContain(forbidden);
    }
    // And the rubric tells the model so outright, rather than relying on the trait list alone.
    for (const question of Object.values(readerQuestions)) {
      expect(question.instructions).toContain('never treat a commenter as an authority');
      expect(question.instructions).toContain('Do not infer sexual content, explicitness, harem or AI authorship');
    }
  });
});


describe('reader aggregation cannot overstate what it knows', () => {
  it('needs five voices that each said something substantive', async () => {
    addWork(PRODUCT_URL);
    // Five people leave one-liners and a sixth writes five long comments: not five voices.
    addDocument(PRODUCT_URL, page([
      ...['Ann','Bo','Cy','Di','Ed'].map(n => review(n, 'Loved it!')),
      ...Array.from({ length: 5 }, (_, i) => review('Prolific', `A long substantive comment number ${i} about pacing and narration.`, 5, `2026-04-0${i + 1}`))
    ]));
    importReaderEvidence(db);
    const summary = summarizeReaderEvidence('work-1', readerEvidenceFor(db, 'work', 'work-1'));
    expect(summary).toMatchObject({ voices: 6, substantive: 5, substantiveVoices: 1, eligible: false });
    const evaluateStub = vi.fn();
    expect((await processReaderTraits(db, 'work', 'work-1', { evaluate: evaluateStub as never })).recorded).toEqual([]);
    expect(evaluateStub).not.toHaveBeenCalled();
  });

  it('counts the same words once, however many accounts carry them', () => {
    addWork(PRODUCT_URL);
    const shared = 'This was wild. Asian inspired fantasy with a little science fiction, and the pacing turned sharply in the last third.';
    // One review, cross-posted by a second account, differing only in markup and spacing.
    addDocument(PRODUCT_URL, page([
      review('Ann', `<p>${shared}</p>`, 5, '2026-03-01'),
      review('Bo', '<div>This was wild.<br>  Asian inspired fantasy with a little science fiction, and the pacing turned sharply in the last&nbsp;third.</div>', 5, '2026-03-02')
    ]));
    importReaderEvidence(db);
    const rows = readerEvidenceFor(db, 'work', 'work-1');
    expect(new Set(rows.map(r => r.author_key)).size).toBe(2);  // two distinct accounts...
    expect(traitInput(rows)).toHaveLength(1);                    // ...carrying one opinion
    // Deterministic: the earliest copy is retained, on every run.
    expect(traitInput(rows)[0].published_at).toContain('2026-03-01');
    expect(bodyKey('<p>a &amp;  b</p>')).toBe('a & b');
  });

  it('counts a prolific commenter once, so ten posts cannot outweigh ten people', () => {
    addWork(PRODUCT_URL);
    addDocument(PRODUCT_URL, page([
      review('Prolific', 'Short substantive comment about the narration here.', 5, '2026-04-01'),
      review('Prolific', 'A considerably longer substantive comment about pacing, narration and world.', 5, '2026-04-02'),
      review('Other', 'Another substantive comment from a different reader about tone.', 5, '2026-04-03')
    ]));
    importReaderEvidence(db);
    const selected = traitInput(readerEvidenceFor(db, 'work', 'work-1'));
    expect(selected).toHaveLength(2);
    // The retained contribution per voice is their longest, and the order is deterministic.
    expect(selected[0].body).toContain('considerably longer');
    expect(selected.map(r => r.published_at)).toEqual(['2026-04-02', '2026-04-03']);
  });

  it('never sends a comment a spoiler-aware source flagged, but keeps a source that only assumes', () => {
    addVoices(6);
    // Hardcover publishes a real flag, so a set flag is a fact and that comment is dropped.
    db.prepare("UPDATE catalog_reader_evidence SET source_name='hardcover.app', contains_spoilers=0").run();
    db.prepare("UPDATE catalog_reader_evidence SET contains_spoilers=1 WHERE id IN (SELECT id FROM catalog_reader_evidence ORDER BY id LIMIT 2)").run();
    let rows = readerEvidenceFor(db, 'work', 'work-1');
    expect(traitInput(rows)).toHaveLength(4);
    expect(JSON.stringify(readerState(rows))).not.toContain(rows.find(r => r.contains_spoilers)!.body);

    // A storefront publishes no flag at all, so every row defaults to 1 meaning "unknown".
    // Treating that assumption as a fact would delete the whole source from every aggregate.
    db.prepare("UPDATE catalog_reader_evidence SET source_name='soundbooththeater.com', contains_spoilers=1").run();
    rows = readerEvidenceFor(db, 'work', 'work-1');
    expect(traitInput(rows)).toHaveLength(6);
  });

  it('does not state a verdict more firmly than its confidence allows', async () => {
    addVoices(6);
    await processReaderTraits(db, 'work', 'work-1', {
      evaluate: (async () => readerStub({ ...ALL_UNKNOWN, 'pacing-slow': ['absent', 0.31], 'tone-humorous': ['present', 0.85] })) as never });
    const rows = Object.fromEntries((db.prepare('SELECT trait, summary, confidence FROM catalog_reader_traits').all() as { trait: string; summary: string; confidence: number }[]).map(r => [r.trait, r]));
    // Weakly held: named as a leaning, never as a statement about what readers think.
    expect(rows['pacing-slow'].summary).toContain('did not clearly establish');
    expect(rows['pacing-slow'].summary).toContain('leaned against');
    expect(rows['pacing-slow'].summary).not.toContain('Readers do not find');
    // Firmly held stays a plain statement.
    expect(rows['tone-humorous'].summary).toContain('Readers describe the book as funny.');
  });

  it('plans and runs on the same bounded input, so the queued hash matches the processed one', () => {
    addVoices(6);
    planReaderTraitJobs(db, 'work');
    const queued = db.prepare("SELECT input_hash FROM catalog_jobs WHERE kind='reader-traits:work'").get() as { input_hash: string };
    expect(queued.input_hash).toBe(readerTraitHash(readerState(readerEvidenceFor(db, 'work', 'work-1'))));
  });

  it('stops emitting a trait once the evidence behind it has changed', async () => {
    addVoices(6);
    await processReaderTraits(db, 'work', 'work-1', {
      evaluate: (async () => readerStub({ ...ALL_UNKNOWN, 'tone-humorous': ['present', 0.8] })) as never });
    expect(readerContext(db, 'work', 'work-1')!.traits.length).toBe(readerTraits.length);
    // One more substantive voice means the aggregate no longer describes the corpus it read.
    db.prepare(`INSERT INTO catalog_reader_evidence(id,series_id,work_id,source_url,external_id,body,contains_spoilers,observed_at,source_name,author_key,kind)
      VALUES('late','series-1','work-1',?, 'late-1','A substantive later comment about the pacing and the narration.',1,'2026-09-02T00:00:00.000Z','soundbooththeater.com','voice-late','review')`).run(PRODUCT_URL);
    expect(readerContext(db, 'work', 'work-1')!.traits).toEqual([]);
    expect(readerContext(db, 'work', 'work-1', { verify: false })!.traits.length).toBe(readerTraits.length);
  });
});


describe('written observations stay original and in scope', () => {
  const openaiStub = (payload: object) => (async () => new Response(JSON.stringify({
    status: 'completed', model: 'gpt-4.1-mini-test', usage: { input_tokens: 500, output_tokens: 40 },
    output: [{ content: [{ type: 'output_text', text: JSON.stringify(payload) }] }]
  }), { status: 200 })) as typeof fetch;

  it('rejects an observation that reuses a reviewer\'s wording', () => {
    const source = 'The narrator does every single voice perfectly and I honestly could not stop listening to it';
    expect(verbatimOverlap('Readers say the narrator does every single voice perfectly and I honestly could not stop listening.', [source])).toBe(true);
    expect(verbatimOverlap('Readers consistently praise the audio performance and the range of character voices.', [source])).toBe(false);
    expect(() => validateObservation({ observation: `Readers report that ${source}, which many enjoyed.`, grounded: true }, [source]))
      .toThrow(/reuses a reviewer/);
  });

  it('rejects an observation straying into claims this evidence cannot support', () => {
    for (const bad of ['Readers repeatedly mention explicit content throughout the book and found it distracting overall here.',
      'Several readers suspect the book was AI-generated because the prose felt flat and repetitive to them.']) {
      expect(() => validateObservation({ observation: bad, grounded: true }, [])).toThrow(/strayed into claims|reuses/);
    }
    expect(() => validateObservation({ observation: 'Too short entirely.', grounded: true }, [])).toThrow(/required length/);
  });

  it('caches a grounded observation and surfaces it on the context', async () => {
    addVoices(6);
    const text = 'Brisk chapters and wry humour drew comment, though opinions split on whether the characters had enough depth.';
    const request = openaiStub({ observation: text, grounded: true });
    const first = await processReaderObservation(db, 'work', 'work-1', { request });
    expect(first).toMatchObject({ observation: text, grounded: true, cached: false, input_tokens: 500 });
    expect((await processReaderObservation(db, 'work', 'work-1', { request })).cached).toBe(true);
    expect(readerContext(db, 'work', 'work-1')!.observation).toBe(text);
  });

  it('publishes nothing when the model reports the comments did not agree', async () => {
    addVoices(6);
    await processReaderObservation(db, 'work', 'work-1', {
      request: openaiStub({ observation: 'Readers did not agree on much beyond broadly enjoying the premise of the book.', grounded: false }) });
    expect(readerContext(db, 'work', 'work-1')!.observation).toBeNull();
  });

  it('spends nothing below the evidence threshold', async () => {
    addVoices(2);
    const request = vi.fn();
    const result = await processReaderObservation(db, 'work', 'work-1', { request: request as never });
    expect(result).toMatchObject({ observation: null, input_tokens: 0 });
    expect(request).not.toHaveBeenCalled();
  });
});


describe('counts describe the exact input, and prose cannot outrun it', () => {
  it('counts voices after spoiler exclusion, not before', () => {
    addWork(PRODUCT_URL);
    addDocument(PRODUCT_URL, page(['Ann','Bo','Cy','Di','Ed'].map((n, i) =>
      review(n, `A substantive comment from ${n} about pacing, narration and the world.`, 5, `2026-05-0${i + 1}`))));
    importReaderEvidence(db);
    db.prepare("UPDATE catalog_reader_evidence SET source_name='hardcover.app', contains_spoilers=0").run();
    let summary = summarizeReaderEvidence('work-1', readerEvidenceFor(db, 'work', 'work-1'));
    expect(summary).toMatchObject({ voices: 5, substantiveVoices: 5, eligible: true });

    // One of the five is flagged by a spoiler-aware source, so the real input is four.
    db.prepare("UPDATE catalog_reader_evidence SET contains_spoilers=1 WHERE id IN (SELECT id FROM catalog_reader_evidence ORDER BY id LIMIT 1)").run();
    summary = summarizeReaderEvidence('work-1', readerEvidenceFor(db, 'work', 'work-1'));
    expect(summary).toMatchObject({ voices: 5, substantiveVoices: 4, eligible: false });
    expect(traitInput(readerEvidenceFor(db, 'work', 'work-1'))).toHaveLength(4);
  });

  it('exports a voice count equal to the comments actually sent', async () => {
    addVoices(7);
    db.prepare("UPDATE catalog_reader_evidence SET source_name='hardcover.app', contains_spoilers=0").run();
    db.prepare("UPDATE catalog_reader_evidence SET contains_spoilers=1 WHERE id IN (SELECT id FROM catalog_reader_evidence ORDER BY id LIMIT 2)").run();
    const rows = readerEvidenceFor(db, 'work', 'work-1');
    const result = await processReaderTraits(db, 'work', 'work-1', {
      evaluate: (async () => readerStub({ ...ALL_UNKNOWN, 'tone-humorous': ['present', 0.8] })) as never });
    const context = readerContext(db, 'work', 'work-1')!;
    expect(traitInput(rows)).toHaveLength(5);
    expect(context.substantiveVoices).toBe(5);
    expect(context.traits[0].voices).toBe(5);
    // The job result reports the judged input too, not every voice on file.
    expect(result).toMatchObject({ voices: 5, samples: 5 });
    expect(context.voices).toBe(7);
  });

  it('refuses an observation claiming agreement the sample did not have', () => {
    expect(CONSISTENCY_CLAIM.test('Readers consistently praise the pacing')).toBe(true);
    for (const consensus of ['mixed', 'insufficient']) {
      expect(() => validateObservation({ observation: 'Readers consistently praise the brisk pacing and the memorable supporting cast throughout.', grounded: true }, [], { consensus, prevalenceSupported: true }))
        .toThrow(/claims "consistently" of a .* sample without qualifying it/);
    }
    // The same sentence is fine when the commenters actually agreed.
    expect(validateObservation({ observation: 'Readers consistently praise the brisk pacing and the memorable supporting cast throughout.', grounded: true }, [], { consensus: 'consistent', prevalenceSupported: true }).grounded).toBe(true);
    // And describing the split is always allowed.
    expect(validateObservation({ observation: 'Some readers enjoyed the brisk pacing while others found the middle chapters repetitive and slow.', grounded: true }, [], { consensus: 'mixed' }).grounded).toBe(true);
    // A consistency word is fine for the CONSENSUS rule when the sentence qualifies itself...
    expect(validateObservation({ observation: 'Readers commonly find the magic system engaging, though many note uneven pacing that hampers momentum.', grounded: true }, [], { consensus: 'mixed', prevalenceSupported: true }).grounded).toBe(true);
    // ...but without measured prevalence the same sentence is refused on the stricter rule.
    expect(() => validateObservation({ observation: 'Readers commonly find the magic system engaging, though many note uneven pacing that hampers momentum.', grounded: true }, [], { consensus: 'mixed' }))
      .toThrow(/without measured per-aspect prevalence/);
    // A mixed sample is not licence to open on the disagreement and say nothing about the book.
    expect(GENERIC_DIVISION_OPENER.test('Readers are divided on the pacing and the characters.')).toBe(true);
    expect(GENERIC_DIVISION_OPENER.test('Readers have mixed feelings about the pacing of this long book.')).toBe(true);
    expect(GENERIC_DIVISION_OPENER.test('Reader opinions on this book vary considerably across the sample.')).toBe(true);
    expect(GENERIC_DIVISION_OPENER.test('Short chapters and steady progression drew praise, while the middle act divided opinion.')).toBe(false);
    for (const opener of ['Readers are divided on the pacing, tone and the characters throughout this long book.',
      'Readers have mixed feelings about the pacing and the protagonist across this lengthy first volume.']) {
      expect(() => validateObservation({ observation: opener, grounded: true }, [], { consensus: 'mixed', prevalenceSupported: true }))
        .toThrow(/opens on the disagreement/);
    }
  });

  it('does not mistake "narrative" for narration', () => {
    // This exact false positive rejected two accurate observations that never mentioned audio.
    const narrative = 'The book features a fast-paced plot and a multifaceted narrative that some found engaging, though opinions varied.';
    expect(validateObservation({ observation: narrative, grounded: true }, [], { narrationEvidenced: false }).grounded).toBe(true);
    expect(() => validateObservation({ observation: 'The narrator gives every character a distinct voice across this long book, which some enjoyed.', grounded: true }, [], { narrationEvidenced: false }))
      .toThrow(/audio that the comments did not evidence/);
  });

  it('refuses an observation discussing audio the comments never evidenced', () => {
    expect(() => validateObservation({ observation: 'Readers praise the narrator and the audiobook performance across the whole of this book.', grounded: true }, [], { narrationEvidenced: false }))
      .toThrow(/audio that the comments did not evidence/);
    expect(validateObservation({ observation: 'Readers praise the narrator and the audiobook performance across the whole of this book.', grounded: true }, [], { narrationEvidenced: true }).grounded).toBe(true);
  });
});


describe('a paid observation is never bought twice', () => {
  const reply = (payload: object) => new Response(JSON.stringify({
    status: 'completed', model: 'gpt-4.1-mini-test', usage: { input_tokens: 500, output_tokens: 40 },
    output: [{ content: [{ type: 'output_text', text: JSON.stringify(payload) }] }] }), { status: 200 });

  it('archives the answer before judging it, and re-judges an invalid one for free', async () => {
    addVoices(6);
    let calls = 0;
    // The model overreaches: it claims agreement the sample did not have.
    const request = (async () => { calls++; return reply({ observation: 'Readers consistently praise the brisk pacing and the memorable supporting cast in this book.', grounded: true }); }) as typeof fetch;
    const rejection = await processReaderObservation(db, 'work', 'work-1', { request }).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(ObservationReviewError);
    // The rejected answer was still paid for, and the cost travels with the error.
    expect((rejection as ObservationReviewError).usage).toEqual({ input_tokens: 500, output_tokens: 40 });
    expect(calls).toBe(1);
    // The raw HTTP body is retained, so the retry costs nothing and reaches the same verdict.
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_inferences WHERE kind='reader-observation-wire'").get()).toEqual({ n: 1 });
    await expect(processReaderObservation(db, 'work', 'work-1', { request })).rejects.toThrow(/will not cost anything/);
    expect(calls).toBe(1);
    // Nothing invalid was published.
    expect(readerContext(db, 'work', 'work-1')!.observation).toBeNull();
  });

  it('keeps a refused or malformed body, which was paid for and used to be lost', async () => {
    addVoices(6);
    for (const [label, response] of [
      ['refusal', () => reply({}) && new Response(JSON.stringify({ status: 'completed', model: 'gpt-4.1-mini-test', usage: { input_tokens: 300, output_tokens: 5 }, output: [{ content: [{ type: 'refusal' }] }] }), { status: 200 })],
      ['truncation', () => new Response(JSON.stringify({ status: 'incomplete', model: 'gpt-4.1-mini-test', usage: { input_tokens: 300, output_tokens: 600 }, output: [] }), { status: 200 })],
      ['malformed body', () => new Response('not json at all', { status: 200 })]
    ] as [string, () => Response][]) {
      db.prepare("DELETE FROM catalog_inferences WHERE kind LIKE 'reader-observation%'").run();
      let calls = 0;
      const request = (async () => { calls++; return response(); }) as typeof fetch;
      await expect(processReaderObservation(db, 'work', 'work-1', { request }), label).rejects.toThrow();
      // The body is durable even though it never parsed, so the retry re-reads it for free.
      const wire = db.prepare("SELECT usage_json FROM catalog_inferences WHERE kind='reader-observation-wire'").get() as { usage_json: string } | undefined;
      expect(wire, label).toBeDefined();
      await expect(processReaderObservation(db, 'work', 'work-1', { request }), label).rejects.toThrow();
      expect(calls, label).toBe(1);
    }
  });

  it('records a cost once, on the receipt that owns it', async () => {
    addVoices(6);
    const text = 'Short chapters and steady progression drew comment, while the middle act divided opinion on pacing.';
    const request = (async () => reply({ observation: text, grounded: true })) as typeof fetch;
    await processReaderObservation(db, 'work', 'work-1', { request });
    const rows = db.prepare("SELECT kind, usage_json FROM catalog_inferences WHERE kind LIKE 'reader-observation%'").all() as { kind: string; usage_json: string }[];
    const paying = rows.filter(r => (JSON.parse(r.usage_json) as { input_tokens: number }).input_tokens > 0);
    // Exactly one row carries the tokens; the judged answer is a copy, not a second charge.
    expect(paying.map(r => r.kind)).toEqual(['reader-observation-wire']);
    const rowsInput = rows.reduce((n, r) => n + (JSON.parse(r.usage_json) as { input_tokens: number }).input_tokens, 0);
    const { input_hash: inputHash } = db.prepare("SELECT input_hash FROM catalog_inferences WHERE kind='reader-observation-wire'").get() as { input_hash: string };
    expect(rowsInput).toBe(500);
    expect(observationCost(db, 'work', 'work-1', inputHash).input_tokens).toBe(500);
  });

  it('never archives an error body, so a fixed key is not poisoned by the failure', async () => {
    addVoices(6);
    const text = 'Short chapters and steady progression drew comment, while the middle act divided opinion on pacing.';
    let calls = 0;
    const request = (async () => {
      calls++;
      return calls === 1 ? new Response('{"error":{"message":"invalid api key"}}', { status: 401 }) : reply({ observation: text, grounded: true });
    }) as typeof fetch;
    await expect(processReaderObservation(db, 'work', 'work-1', { request })).rejects.toThrow(/HTTP 401/);
    // Nothing was paid for, so nothing is archived; otherwise the retry would replay the 401.
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_inferences WHERE kind LIKE 'reader-observation%'").get()).toEqual({ n: 0 });
    expect(await processReaderObservation(db, 'work', 'work-1', { request })).toMatchObject({ grounded: true });
    expect(calls).toBe(2);
    expect(readerContext(db, 'work', 'work-1')!.observation).toBe(text);
  });

  it('records unknown cost as unknown rather than as free', async () => {
    addVoices(6);
    const body = (usage: unknown) => new Response(JSON.stringify({ status: 'completed', model: 'gpt-4.1-mini-test', usage,
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ observation: 'Short chapters drew comment, while the middle act divided opinion on whether it dragged on.', grounded: true }) }] }] }), { status: 200 });
    // A body with no usage block at all: the receipt says unknown, never {input:0,output:0}.
    await processReaderObservation(db, 'work', 'work-1', { request: (async () => body(undefined)) as typeof fetch });
    const wire = db.prepare("SELECT usage_json FROM catalog_inferences WHERE kind='reader-observation-wire'").get() as { usage_json: string };
    expect(JSON.parse(wire.usage_json)).toEqual({});
    // Counts that are not whole non-negative numbers are not counts.
    expect(normalizeUsage({ input_tokens: 12.5, output_tokens: 3 })).toBeUndefined();
    expect(normalizeUsage({ input_tokens: -1, output_tokens: 3 })).toBeUndefined();
    expect(normalizeUsage({ input_tokens: 12, output_tokens: 3 })).toEqual({ input_tokens: 12, output_tokens: 3 });
    db.prepare("DELETE FROM catalog_inferences WHERE kind LIKE 'reader-observation%'").run();
    await expect(processReaderObservation(db, 'work', 'work-1', { request: (async () => body({ input_tokens: -4, output_tokens: 2 })) as typeof fetch }))
      .rejects.toThrow(/unusable token usage/);
  });

  it('stops rather than retries when a paid answer cannot be stored', async () => {
    addVoices(6);
    const text = 'Short chapters and steady progression drew comment, while the middle act divided opinion on pacing.';
    const good = (async () => reply({ observation: text, grounded: true })) as typeof fetch;

    // A caller that opens a transaction while we await would swallow the receipt on rollback.
    const racing = (async () => { db.exec('BEGIN'); return reply({ observation: text, grounded: true }); }) as typeof fetch;
    const raced = await processReaderObservation(db, 'work', 'work-1', { request: racing }).catch((e: unknown) => e);
    expect(raced).toBeInstanceOf(PaidResponseStorageError);
    expect((raced as ReaderPaidStorageError).usage).toEqual({ input_tokens: 500, output_tokens: 40 });
    expect((raced as Error).message).toMatch(/could not be saved.*transaction while the request was in flight/s);
    db.exec('ROLLBACK');

    // A failing insert is a review item, not a retryable database error the queue would rebuy.
    db.exec("CREATE TRIGGER no_wire BEFORE INSERT ON catalog_inferences WHEN NEW.kind='reader-observation-wire' BEGIN SELECT RAISE(ABORT,'disk is full'); END");
    const failed = await processReaderObservation(db, 'work', 'work-1', { request: good }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(PaidResponseStorageError);
    expect(failed).toBeInstanceOf(ReviewError);   // the worker parks it instead of retrying
    expect((failed as Error).message).toMatch(/disk is full/);
    db.exec('DROP TRIGGER no_wire');
    expect(await processReaderObservation(db, 'work', 'work-1', { request: good })).toMatchObject({ grounded: true });
  });

  it('refuses to buy anything while a caller transaction is already open', async () => {
    addVoices(6);
    let calls = 0;
    const request = (async () => { calls++; return reply({ observation: 'x', grounded: true }); }) as typeof fetch;
    db.exec('BEGIN');
    const refused = await processReaderObservation(db, 'work', 'work-1', { request }).catch((e: unknown) => e);
    db.exec('ROLLBACK');
    // Refused before the spend, not discovered after it.
    expect(refused).toBeInstanceOf(ReaderTransactionError);
    expect(refused).toBeInstanceOf(ReviewError);
    expect(calls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_inferences WHERE kind LIKE 'reader-observation%'").get()).toEqual({ n: 0 });
  });

  it('parks an archived body that cannot be parsed, and keeps transport errors transient', async () => {
    addVoices(6);
    // A refusal: the body was paid for and archived, so it is a review item, not a retry.
    const refusing = (async () => new Response(JSON.stringify({ status: 'completed', model: 'gpt-4.1-mini-test',
      usage: { input_tokens: 300, output_tokens: 5 }, output: [{ content: [{ type: 'refusal' }] }] }), { status: 200 })) as typeof fetch;
    const first = await processReaderObservation(db, 'work', 'work-1', { request: refusing }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ObservationReviewError);
    expect((first as ObservationReviewError).usage).toEqual({ input_tokens: 300, output_tokens: 5 });
    // Replaying the saved wire reaches the same verdict, still as a review item, still free.
    const replayed = await processReaderObservation(db, 'work', 'work-1', { request: refusing }).catch((e: unknown) => e);
    expect(replayed).toBeInstanceOf(ObservationReviewError);
    expect((replayed as ObservationReviewError).usage).toEqual({ input_tokens: 0, output_tokens: 0 });

    // A transport failure archived nothing, so it keeps its own semantics and stays retryable.
    db.prepare("DELETE FROM catalog_inferences WHERE kind LIKE 'reader-observation%'").run();
    const rateLimited = await processReaderObservation(db, 'work', 'work-1',
      { request: (async () => new Response('{}', { status: 429 })) as typeof fetch }).catch((e: unknown) => e);
    expect(rateLimited).toBeInstanceOf(Error);
    expect(rateLimited).not.toBeInstanceOf(ReviewError);
    expect((rateLimited as Error).message).toMatch(/HTTP 429/);
  });

  it('claims the trait job first even when both are created in the same instant', async () => {
    addVoices(6);
    // Both jobs stamped the same instant, so created_at cannot decide and the old tie fell to
    // job id, which is a hash.
    planReaderTraitJobs(db, 'work', new Date('2026-01-01T00:00:00.000Z'));
    expect(db.prepare("SELECT DISTINCT created_at FROM catalog_jobs WHERE kind LIKE 'reader-%'").all()).toHaveLength(1);
    const kinds = readerJobKinds('work');
    const first = claim(db, kinds);
    expect(first!.kind).toBe(readerJobKind('traits', 'work'));
    finish(db, first!, {});
    expect(claim(db, kinds)!.kind).toBe(readerJobKind('observation', 'work'));
  });

  it('queues the observation under the hash the runner will actually use', async () => {
    addVoices(6);
    await processReaderTraits(db, 'work', 'work-1', { evaluate: (async () => readerStub(ALL_UNKNOWN)) as never });
    planReaderTraitJobs(db, 'work');
    const rows = readerEvidenceFor(db, 'work', 'work-1');
    const queued = db.prepare("SELECT input_hash FROM catalog_jobs WHERE kind=?").get(readerJobKind('observation', 'work')) as { input_hash: string };
    expect(queued.input_hash).toBe(observationInput(db, 'work', 'work-1', rows).inputHash);
    // A later trait run that changes the consensus changes the observation input, so a fresh job
    // is queued. Under the old planner hash the change was invisible and nothing was requeued.
    db.prepare("UPDATE catalog_reader_traits SET consensus='mixed' WHERE entity_id='work-1'").run();
    expect(observationInput(db, 'work', 'work-1', rows).inputHash).not.toBe(queued.input_hash);
    expect(planReaderTraitJobs(db, 'work')).toBeGreaterThan(0);
  });

  it('parks a job rather than cycling it through the queue', async () => {
    addVoices(6);
    await processReaderTraits(db, 'work', 'work-1', { evaluate: (async () => readerStub(ALL_UNKNOWN)) as never });
    planReaderTraitJobs(db, 'work');
    const refusing = (async () => new Response(JSON.stringify({ status: 'completed', model: 'gpt-4.1-mini-test',
      usage: { input_tokens: 300, output_tokens: 5 }, output: [{ content: [{ type: 'refusal' }] }] }), { status: 200 })) as typeof fetch;
    // The same dispatch the runner uses: a ReviewError parks, anything else is retried.
    const work = async () => {
      const job = claim(db, readerJobKinds('work').filter(k => k.startsWith('reader-observation')));
      if (!job) return null;
      try {
        const payload = JSON.parse(job.payload_json) as { entityType: 'work'; entityId: string };
        finish(db, job, await processReaderObservation(db, payload.entityType, payload.entityId, { request: refusing }));
      } catch (error) {
        fail(db, job, error instanceof Error ? error.message : 'failed', error instanceof ReviewError);
      }
      return db.prepare('SELECT status, attempts FROM catalog_jobs WHERE id=?').get(job.id) as { status: string; attempts: number };
    };
    expect(await work()).toMatchObject({ status: 'review' });
    // Parked, so the runner never claims it again and never re-reads the same dead answer.
    expect(await work()).toBeNull();
  });

  it('promotes a valid answer and then serves it from cache', async () => {
    addVoices(6);
    let calls = 0;
    const text = 'Short chapters and steady progression drew praise, while the middle act divided opinion on whether it dragged.';
    const request = (async () => { calls++; return reply({ observation: text, grounded: true }); }) as typeof fetch;
    expect(await processReaderObservation(db, 'work', 'work-1', { request })).toMatchObject({ grounded: true, input_tokens: 500 });
    expect(await processReaderObservation(db, 'work', 'work-1', { request })).toMatchObject({ cached: true, input_tokens: 0 });
    expect(calls).toBe(1);
    expect(readerContext(db, 'work', 'work-1')!.observation).toBe(text);
  });

  it('survives an interruption between paying and publishing', async () => {
    addVoices(6);
    const text = 'The humour drew comment, read as sharp by some and repetitive by others over a long book.';
    let calls = 0;
    // First attempt pays and archives, then the process dies before the result is promoted.
    const dying = (async () => { calls++; await Promise.resolve(); throw new Error('interrupted after the response was archived'); }) as typeof fetch;
    const archiving = (async () => { calls++; return reply({ observation: text, grounded: true }); }) as typeof fetch;
    await processReaderObservation(db, 'work', 'work-1', { request: archiving });
    db.prepare("DELETE FROM catalog_inferences WHERE kind='reader-observation'").run();  // promotion lost
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_inferences WHERE kind='reader-observation-wire'").get()).toEqual({ n: 1 });
    // Resuming republishes from the archived answer without paying, and never calls out again.
    const resumed = await processReaderObservation(db, 'work', 'work-1', { request: dying });
    expect(resumed).toMatchObject({ grounded: true, input_tokens: 0 });
    expect(calls).toBe(1);
    expect(readerContext(db, 'work', 'work-1')!.observation).toBe(text);
  });

  it('queues traits and observations together on the same threshold', () => {
    addVoices(6);
    expect(planReaderTraitJobs(db, 'work')).toBe(2);
    expect(db.prepare("SELECT kind FROM catalog_jobs WHERE kind LIKE 'reader-%' ORDER BY kind").all())
      .toEqual([{ kind: 'reader-observation:work' }, { kind: 'reader-traits:work' }]);
    // Re-planning the same evidence adds nothing.
    expect(planReaderTraitJobs(db, 'work')).toBe(0);
  });

  it('does not reach the network at all below the threshold', async () => {
    addVoices(2);
    const request = vi.fn();
    expect(await processReaderObservation(db, 'work', 'work-1', { request: request as never })).toMatchObject({ observation: null });
    expect(request).not.toHaveBeenCalled();
    expect(planReaderTraitJobs(db, 'work')).toBe(0);
    expect(typeof fetchObservation).toBe('function');
  });
});


describe('scope is enforced by the queue, not after claiming', () => {
  it('claims only the requested scope, even when the other scope sorts first', () => {
    addVoices(6);
    // Both scopes have eligible evidence; the work jobs are created first and sort first.
    expect(planReaderTraitJobs(db, 'work')).toBe(2);
    expect(planReaderTraitJobs(db, 'series')).toBe(2);

    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const job = claim(db, readerJobKinds('series'));
      if (!job) break;
      seen.push(job.kind);
      finish(db, job, {});
    }
    // Filtering after claiming used to stall here: the first work job came back, was deferred,
    // was immediately re-claimed and the run ended without touching anything in scope.
    expect(seen.sort()).toEqual([readerJobKind('observation', 'series'), readerJobKind('traits', 'series')]);
    expect(seen.every(k => k.endsWith(':series'))).toBe(true);

    // The work jobs are untouched and still claimable under their own scope.
    const work = claim(db, readerJobKinds('work'));
    expect(work?.kind).toMatch(/:work$/);
  });

  it('keeps the two scopes as separate jobs for the same entity id', () => {
    addVoices(6);
    planReaderTraitJobs(db, 'work');
    planReaderTraitJobs(db, 'series');
    const kinds = (db.prepare("SELECT DISTINCT kind FROM catalog_jobs WHERE kind LIKE 'reader-%' ORDER BY kind").all() as { kind: string }[]).map(k => k.kind);
    expect(kinds).toEqual(['reader-observation:series', 'reader-observation:work', 'reader-traits:series', 'reader-traits:work']);
  });
});


describe('prevalence claims are unsayable without measured support', () => {
  const stash = (entityId: string, observation: string) => {
    const rows = readerEvidenceFor(db, 'work', entityId);
    const stored = db.prepare(`SELECT consensus, value FROM catalog_reader_traits WHERE entity_type='work' AND entity_id=? AND trait='narration-praised' ORDER BY evaluated_at DESC LIMIT 1`).get(entityId) as { consensus: string; value: string } | undefined;
    const sample = { voices: traitInput(rows).length, consensus: stored?.consensus ?? 'insufficient', narrationEvidenced: stored?.value === 'present' };
    const inputHash = observationHash({ ...readerState(rows), sample });
    db.prepare(`INSERT OR REPLACE INTO catalog_inferences VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      hash(['reader', `work:${entityId}`, 'reader-observation', inputHash]), 'reader', `work:${entityId}`, 'reader-observation',
      inputHash, 'gpt-4.1-mini', 'gpt-4.1-mini-test', OBSERVATION_VERSION, JSON.stringify({ observation, grounded: true }), '{}', '2026-09-19T00:00:00.000Z');
    return { inputHash, inferenceId: hash(['reader', `work:${entityId}`, 'reader-observation', inputHash]) };
  };

  it('rejects a quantifier the sample size cannot support', () => {
    expect(PREVALENCE_QUANTIFIER.test('Readers consistently praise the magic system')).toBe(true);
    for (const bad of ['Readers consistently praise the detailed magic system and the world it is set in.',
      'Many readers struggle with the slow pacing and the extensive exposition in the opening act.',
      'Most comments describe the humour as the strongest part of this particular first volume.']) {
      expect(() => validateObservation({ observation: bad, grounded: true }, [], {})).toThrow(/without measured per-aspect prevalence/);
    }
    // Existential phrasing is fine: it says what was reported, not how many reported it.
    expect(validateObservation({ observation: 'Some readers describe the pacing as slow, and some single out the magic system as the draw.', grounded: true }, [], {}).grounded).toBe(true);
    // And a measured prevalence pass could license it later.
    expect(validateObservation({ observation: 'Readers consistently praise the detailed magic system and the world it is set in.', grounded: true }, [], { prevalenceSupported: true }).grounded).toBe(true);
  });

  it('withholds prose that a later rule invalidates, without rewriting it', async () => {
    addVoices(6);
    await processReaderTraits(db, 'work', 'work-1', { evaluate: (async () => readerStub(ALL_UNKNOWN)) as never });
    const overclaiming = 'Readers consistently describe brisk chapters and a wry sense of humour across this first book.';
    stash('work-1', overclaiming);
    // The stored answer is untouched; it is simply not published.
    expect(readerContext(db, 'work', 'work-1')!.observation).toBeNull();
    const held = db.prepare("SELECT result_json FROM catalog_inferences WHERE kind='reader-observation'").get() as { result_json: string };
    expect(JSON.parse(held.result_json).observation).toBe(overclaiming);
  });

  it('publishes a reviewed correction, and only a reviewed one', async () => {
    addVoices(6);
    await processReaderTraits(db, 'work', 'work-1', { evaluate: (async () => readerStub(ALL_UNKNOWN)) as never });
    const { inputHash, inferenceId } = stash('work-1', 'Readers consistently describe brisk chapters and a wry sense of humour across this first book.');
    const replacement = 'Comments describe brisk chapters and a wry sense of humour; some readers found the characters thin.';
    const base = { entityType: 'work' as const, entityId: 'work-1', inputHash, inferenceId, model: 'gpt-4.1-mini-test',
      rubricVersion: OBSERVATION_VERSION, sourceUrls: [PRODUCT_URL], observation: replacement };

    // Proposed but unreviewed: the context stays evidence-only.
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...base, reviewedAt: null, reviewedBy: null }] })!.observation).toBeNull();
    // Reviewed: published.
    const approved = { ...base, reviewedAt: '2026-09-19', reviewedBy: 'a reviewer' };
    expect(readerContext(db, 'work', 'work-1', { corrections: [approved] })!.observation).toBe(replacement);
    // Bound to the exact input: a correction written against other evidence never promotes.
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...approved, inputHash: 'stale-hash' }] })!.observation).toBeNull();
    // A hand-written sentence earns no exemption from the rules the model's prose obeys.
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...approved, observation: 'Readers consistently loved every part of this book without any reservation at all.' }] })!.observation).toBeNull();
    // The receipt must agree, not merely exist: a different model, rubric or source set is refused.
    for (const wrong of [{ model: 'some-other-model' }, { rubricVersion: 'reader-observation-v1' }, { sourceUrls: ['https://elsewhere.example/x'] }, { inferenceId: 'not-a-receipt' }]) {
      expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...approved, ...wrong }] })!.observation, JSON.stringify(wrong)).toBeNull();
    }
    // A review dated in the future is not a review.
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...approved, reviewedAt: '2099-01-01' }] })!.observation).toBeNull();
    // Two reviewed corrections for one input is an unresolved disagreement: fail closed.
    expect(readerContext(db, 'work', 'work-1', { corrections: [approved, { ...approved, observation: 'Comments describe something else entirely about this particular book and its pacing.' }] })!.observation).toBeNull();
    // A proposal that exists but is unreviewed must not fall back to the prose it replaces.
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...base, reviewedAt: null, reviewedBy: null }] })!.observation).toBeNull();
  });

  it('refuses a receipt belonging to another entity, or to the wrong kind', async () => {
    addVoices(6);
    await processReaderTraits(db, 'work', 'work-1', { evaluate: (async () => readerStub(ALL_UNKNOWN)) as never });
    const { inputHash, inferenceId } = stash('work-1', 'Readers consistently describe brisk chapters and a wry sense of humour across this first book.');
    const replacement = 'Comments describe brisk chapters and a wry sense of humour; some readers found the characters thin.';
    const approved = { entityType: 'work' as const, entityId: 'work-1', inputHash, inferenceId, model: 'gpt-4.1-mini-test',
      rubricVersion: OBSERVATION_VERSION, sourceUrls: [PRODUCT_URL], reviewedAt: '2026-09-19', reviewedBy: 'a reviewer', observation: replacement };
    expect(readerContext(db, 'work', 'work-1', { corrections: [approved] })!.observation).toBe(replacement);

    // Evidence linked to both a series and its work can hash identically, so a receipt for the
    // series must not satisfy a correction written for the work.
    const sibling = hash(['reader', 'series:series-1', 'reader-observation', inputHash]);
    expect(sibling).not.toBe(inferenceId);
    db.prepare(`INSERT INTO catalog_inferences(id,entity_type,entity_id,kind,input_hash,requested_model,actual_model,rubric_version,result_json,usage_json,evaluated_at)
      VALUES(?,'reader','series:series-1','reader-observation',?,?,?,?,?,'{}',?)`)
      .run(sibling, inputHash, 'gpt-4.1-mini-test', 'gpt-4.1-mini-test', OBSERVATION_VERSION, JSON.stringify({ observation: 'x', grounded: true }), '2026-09-19T00:00:00.000Z');
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...approved, inferenceId: sibling }] })!.observation).toBeNull();

    // Nor may it name the archived wire instead of the judged answer.
    for (const kind of ['reader-observation-wire', 'reader-observation-raw']) {
      const wrongKind = hash(['reader', 'work:work-1', kind, inputHash]);
      expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...approved, inferenceId: wrongKind }] })!.observation).toBeNull();
    }

    // Belt and braces: even a row sitting at the right id is checked against its own columns.
    db.prepare("UPDATE catalog_inferences SET entity_id='work:somewhere-else' WHERE id=?").run(inferenceId);
    expect(readerContext(db, 'work', 'work-1', { corrections: [approved] })!.observation).toBeNull();
  });

  it('lets a reviewed replacement answer a parked wire receipt, but only when declared', async () => {
    addVoices(6);
    await processReaderTraits(db, 'work', 'work-1', { evaluate: (async () => readerStub(ALL_UNKNOWN)) as never });
    // A fresh answer that overclaims: parked, with the paid wire retained and no judged answer.
    const refusing = (async () => new Response(JSON.stringify({ status: 'completed', model: 'gpt-4.1-mini-test',
      usage: { input_tokens: 300, output_tokens: 5 },
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ observation: 'Readers many of them describe brisk chapters and a wry sense of humour in this book.', grounded: true }) }] }] }), { status: 200 })) as typeof fetch;
    await expect(processReaderObservation(db, 'work', 'work-1', { request: refusing })).rejects.toThrow();
    const rows = readerEvidenceFor(db, 'work', 'work-1');
    const inputHash = observationInput(db, 'work', 'work-1', rows).inputHash;
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_inferences WHERE kind='reader-observation'").get()).toEqual({ n: 0 });

    const replacement = 'Comments describe brisk chapters and a wry sense of humour; some readers found the characters thin.';
    const base = { entityType: 'work' as const, entityId: 'work-1', inputHash, model: 'gpt-4.1-mini-test',
      rubricVersion: OBSERVATION_VERSION, sourceUrls: [PRODUCT_URL], reviewedAt: '2026-09-19', reviewedBy: 'a reviewer', observation: replacement };
    const wireId = hash(['reader', 'work:work-1', 'reader-observation-wire', inputHash]);

    // Undeclared, it is still read as naming the judged answer, so the old refusal stands.
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...base, inferenceId: wireId }] })!.observation).toBeNull();
    // Declared, it binds to the wire that was actually paid for.
    const declared = { ...base, inferenceId: wireId, receiptKind: 'reader-observation-wire' as const };
    expect(readerContext(db, 'work', 'work-1', { corrections: [declared] })!.observation).toBe(replacement);
    expect(observationStatus(db, 'work', 'work-1', rows, { corrections: [declared] }).status).toBe('corrected');

    // Declaring a kind does not loosen anything else.
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...declared, inferenceId: hash(['reader', 'series:series-1', 'reader-observation-wire', inputHash]) }] })!.observation).toBeNull();
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...declared, receiptKind: 'reader-observation-raw' as const }] })!.observation).toBeNull();
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...declared, model: 'another-model' }] })!.observation).toBeNull();
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...declared, observation: 'Readers consistently loved every single part of this book without any reservation at all.' }] })!.observation).toBeNull();
    // An unrecognised kind fails closed rather than falling back to the default.
    expect(readerContext(db, 'work', 'work-1', { corrections: [{ ...declared, receiptKind: 'reader-observation-guess' as never }] })!.observation).toBeNull();
  });

  it('explains every outcome, so a review report cannot drift from what ships', async () => {
    addVoices(6);
    await processReaderTraits(db, 'work', 'work-1', { evaluate: (async () => readerStub(ALL_UNKNOWN)) as never });
    const rows = () => readerEvidenceFor(db, 'work', 'work-1');
    // Nothing retained yet.
    expect(observationStatus(db, 'work', 'work-1', rows())).toMatchObject({ status: 'missing' });
    const { inputHash, inferenceId } = stash('work-1', 'Readers consistently describe brisk chapters and a wry sense of humour across this first book.');
    // Withheld, and the reason names the word that did it rather than saying only "invalid".
    const withheld = observationStatus(db, 'work', 'work-1', rows());
    expect(withheld.status).toBe('withheld');
    expect(withheld.reason).toContain('consistently');
    expect(withheld.observation).toBeNull();
    const approved = { entityType: 'work' as const, entityId: 'work-1', inputHash, inferenceId, model: 'gpt-4.1-mini-test',
      rubricVersion: OBSERVATION_VERSION, sourceUrls: [PRODUCT_URL], reviewedAt: '2026-09-19', reviewedBy: 'a reviewer',
      observation: 'Comments describe brisk chapters and a wry sense of humour; some readers found the characters thin.' };
    expect(observationStatus(db, 'work', 'work-1', rows(), { corrections: [approved] })).toMatchObject({ status: 'corrected' });
    // A refused correction reports why, and still publishes nothing.
    const refused = observationStatus(db, 'work', 'work-1', rows(), { corrections: [{ ...approved, model: 'some-other-model' }] });
    expect(refused).toMatchObject({ status: 'withheld', observation: null });
    expect(refused.reason.length).toBeGreaterThan(0);
    // The diagnostic and the exported context always agree.
    for (const corrections of [[], [approved], [{ ...approved, reviewedAt: null, reviewedBy: null }]]) {
      expect(observationStatus(db, 'work', 'work-1', rows(), { corrections }).observation)
        .toBe(readerContext(db, 'work', 'work-1', { corrections })!.observation);
    }
  });
});
