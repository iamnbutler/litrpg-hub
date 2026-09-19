import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hash } from './queue.js';
import { OBSERVATION_VERSION, PREVALENCE_QUANTIFIER, importReaderEvidence, linkIndex, observationHash, readerContext, readerEvidenceFor, readerState, traitInput, validateObservation } from './reader-evidence.js';
import { observationTextHash, SPLIT_AUDIO_TERM, SPLIT_LIMITS, SPLIT_PREVALENCE_QUANTIFIER, SPLIT_VALIDATOR_VERSION, isApprovedSplit, loadSplits, resolveSplit, validateSplit, type ReaderSplit } from './reader-split.js';

const MIGRATIONS = ['001_initial.sql','002_cursor_results_found.sql','003_jev_assessments.sql','004_cover_assessments.sql','005_source_history.sql','006_catalog_pipeline.sql','007_author_profiles.sql','008_reader_evidence.sql','010_reader_trait_honesty.sql'];
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  for (const name of MIGRATIONS) db.exec(readFileSync(join(import.meta.dirname, '../migrations', name), 'utf8'));
  vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-real-credential');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const OBSERVATION = "Jason's personality is a point of disagreement: comments describe him as witty and enjoyable, or chatty and arrogant. Praise for the worldbuilding sits alongside complaints about the length.";
const PAST = '2026-09-19T00:00:00.000Z';
const split = (over: Partial<ReaderSplit> = {}): ReaderSplit => ({
  entityType: 'work', entityId: 'work-1', inputHash: 'abc123', textHash: observationTextHash(OBSERVATION),
  impressions: ['Jason read as witty and enjoyable', 'The worldbuilding'],
  critiques: ['Jason also read as chatty and arrogant', 'Length and repetition'],
  reviewedAt: PAST, reviewedBy: 'root', validatorVersion: SPLIT_VALIDATOR_VERSION, ...over });
const resolve = (splits: ReaderSplit[], over: Partial<{ inputHash: string; observation: string }> = {}) =>
  resolveSplit(splits, { entityType: 'work', entityId: 'work-1', inputHash: 'abc123', observation: OBSERVATION, ...over });

describe('reader split policy', () => {
  it('keeps its quantifier policy identical to the observation validator', () => {
    // reader-evidence imports this module, so the policy cannot be imported back without a
    // cycle. Declared twice, asserted equal here, so a drift is a failing test not a silent gap.
    expect(SPLIT_PREVALENCE_QUANTIFIER.source).toBe(PREVALENCE_QUANTIFIER.source);
    expect(SPLIT_PREVALENCE_QUANTIFIER.flags).toBe(PREVALENCE_QUANTIFIER.flags);
  });

  it('agrees with the observation validator about what counts as an audio claim', () => {
    const sample = { voices: 6, consensus: 'mixed' as const, narrationEvidenced: false };
    for (const term of ['narration', 'narrator', 'audiobook', 'voice acting', 'listening']) {
      expect(SPLIT_AUDIO_TERM.test(`The ${term} was a highlight for this sample of readers`)).toBe(true);
      // The same word is refused upstream when the evidence does not support it.
      expect(() => validateObservation({ observation: `The ${term} was a highlight for the sample of readers here`, grounded: true }, ['a comment'], sample)).toThrow();
    }
    expect(SPLIT_AUDIO_TERM.test('A narrative that rewards patience')).toBe(false);
  });

  it('allows a bullet to reuse the approved observation wording', () => {
    // These present our own reviewed prose. Forcing a paraphrase would add drift, not safety.
    expect(() => validateSplit(split({ impressions: ['Praise for the worldbuilding'], critiques: ['complaints about the length'] }), OBSERVATION)).not.toThrow();
  });
});

describe('reader split validation', () => {
  it('publishes a reviewed split that reads the observation faithfully', () => {
    const outcome = resolve([split()]);
    expect(outcome.status).toBe('applied');
    expect(outcome.status === 'applied' && outcome.split.impressions).toHaveLength(2);
  });

  it('keeps a disagreement on both sides rather than choosing one', () => {
    const outcome = resolve([split()]);
    expect(outcome.status).toBe('applied');
    if (outcome.status !== 'applied') return;
    expect(outcome.split.impressions.join(' ')).toContain('witty');
    expect(outcome.split.critiques.join(' ')).toContain('arrogant');
  });

  it('accepts an empty side rather than inventing balance', () => {
    expect(() => validateSplit(split({ impressions: [], critiques: ['Repetitive stat passages'] }), OBSERVATION)).not.toThrow();
    expect(() => validateSplit(split({ impressions: [], critiques: [] }), OBSERVATION)).toThrow(/no bullets on either side/);
  });

  it('refuses a bullet claiming how many readers held a view', () => {
    const outcome = resolve([split({ impressions: ['Most readers praised the worldbuilding'] })]);
    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toMatch(/claims "Most"/i);
  });

  it('refuses a narration claim the observation does not make', () => {
    const outcome = resolve([split({ impressions: ['The narration was a highlight'] })]);
    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toMatch(/mentions narration/);
    // ...and allows it once the observation itself carries one.
    const withAudio = `${OBSERVATION} The narration drew praise.`;
    expect(resolve([split({ impressions: ['The narration was a highlight'], textHash: observationTextHash(withAudio) })], { observation: withAudio }).status).toBe('applied');
  });

  it('refuses more bullets than a side may carry, and bullets that are not compact', () => {
    expect(resolve([split({ critiques: ['One', 'Two things', 'Three things here', 'Four things listed here'] })]).status).toBe('refused');
    expect(() => validateSplit(split({ impressions: ['Worldbuilding'] }), OBSERVATION)).toThrow(/outside 2-12 words/);
    expect(() => validateSplit(split({ impressions: ['a '.repeat(SPLIT_LIMITS.maxWords + 1).trim()] }), OBSERVATION)).toThrow(/outside 2-12 words/);
  });

  it('refuses a repeated bullet across sides', () => {
    expect(() => validateSplit(split({ impressions: ['The worldbuilding'], critiques: ['The worldbuilding'] }), OBSERVATION)).toThrow(/repeats the bullet/);
  });
});

describe('reader split bindings', () => {
  it('returns nothing when the evidence behind the observation has moved on', () => {
    expect(resolve([split({ inputHash: 'written-against-older-evidence' })]).status).toBe('none');
  });

  it('returns nothing when a correction rewrote the prose without changing the input', () => {
    // A reviewed correction replaces the sentence but leaves the evidence and sample untouched,
    // so the input hash is identical. Only the text hash catches it, and it must.
    const corrected = 'A reviewed correction replaced this sentence entirely while the evidence stayed the same.';
    const outcome = resolve([split()], { observation: corrected });
    expect(outcome.status).toBe('none');
    expect(observationTextHash(corrected)).not.toBe(observationTextHash(OBSERVATION));
  });

  it('returns nothing until an editorial review has actually happened', () => {
    expect(resolve([split({ reviewedAt: null })]).status).toBe('none');
    expect(resolve([split({ reviewedBy: null })]).status).toBe('none');
    expect(isApprovedSplit(split({ reviewedAt: '2099-01-01T00:00:00.000Z' }))).toBe(false);
    expect(resolve([split({ reviewedAt: '2099-01-01T00:00:00.000Z' })]).status).toBe('none');
  });

  it('fails closed when two reviewed splits claim the same observation', () => {
    const outcome = resolve([split(), split({ impressions: ['A different reading entirely'] })]);
    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toMatch(/2 reviewed splits/);
  });

  it('refuses a split reviewed under a superseded policy', () => {
    expect(resolve([split({ validatorVersion: 'reader-split-v0' })]).status).toBe('refused');
  });

  it('reads both the array and wrapper config shapes, and survives a missing file', () => {
    // Deliberately fixture-backed rather than pointed at the committed config: that file is
    // about to hold approved splits, and a test asserting it stays empty would fail the moment
    // review lands, which is a test coupled to production data rather than to behaviour.
    const dir = mkdtempSync(join(tmpdir(), 'reader-splits-'));
    try {
      const bare = join(dir, 'array.json'), wrapped = join(dir, 'wrapper.json'), broken = join(dir, 'broken.json');
      writeFileSync(bare, JSON.stringify([split()]));
      writeFileSync(wrapped, JSON.stringify({ version: SPLIT_VALIDATOR_VERSION, splits: [split(), split({ entityId: 'work-2' })] }));
      writeFileSync(broken, '{ not json');
      expect(loadSplits(bare)).toHaveLength(1);
      expect(loadSplits(wrapped)).toHaveLength(2);
      expect(loadSplits(broken)).toEqual([]);
      expect(loadSplits(join(dir, 'absent.json'))).toEqual([]);
      // An entry missing either binding is not a split, whichever shape it arrived in.
      writeFileSync(bare, JSON.stringify([split(), { ...split(), textHash: undefined }, { ...split(), inputHash: undefined }]));
      expect(loadSplits(bare)).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('reader context assembly', () => {
  const publish = (observation: string) => {
    const rows = readerEvidenceFor(db, 'work', 'work-1');
    const sample = { voices: traitInput(rows).length, consensus: 'insufficient', narrationEvidenced: false };
    const inputHash = observationHash({ ...readerState(rows), sample });
    db.prepare(`INSERT OR REPLACE INTO catalog_inferences VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      hash(['reader', 'work:work-1', 'reader-observation', inputHash]), 'reader', 'work:work-1', 'reader-observation',
      inputHash, 'gpt-4.1-mini', 'gpt-4.1-mini-test', OBSERVATION_VERSION, JSON.stringify({ observation, grounded: true }), '{}', PAST);
    return inputHash;
  };
  const seed = () => {
    const url = 'https://soundbooththeater.com/shop/audiobooks/a-series-book-1/';
    db.prepare('INSERT OR IGNORE INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run('series-1', 'A Series', 'An Author', PAST);
    db.prepare('INSERT OR IGNORE INTO catalog_works(id,series_id,number,title,author,source_url,updated_at) VALUES(?,?,?,?,?,?,?)').run('work-1', 'series-1', 1, 'A Series Book 1', 'An Author', url, PAST);
    const reviews = Array.from({ length: 6 }, (_, i) => ({ '@type': 'Review',
      reviewRating: { '@type': 'Rating', ratingValue: '5', bestRating: '5' }, author: { '@type': 'Person', name: `Reader${i}` },
      reviewBody: `A substantive comment from Reader${i} about the world, the length and the pacing of this book.`, datePublished: '2026-03-01T00:00:00-04:00' }));
    db.prepare('INSERT OR REPLACE INTO catalog_documents(id,url,content_hash,body,fetched_at) VALUES(?,?,?,?,?)').run('doc-1', url, 'h', `<html><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', review: reviews })}</script></html>`, PAST);
    importReaderEvidence(db, { index: linkIndex(db) });
  };

  it('publishes both sides together, and neither when no split is reviewed', () => {
    seed();
    const observationHashValue = publish(OBSERVATION);
    const without = readerContext(db, 'work', 'work-1', { splits: [] });
    expect(without?.observation).toBe(OBSERVATION);
    expect(without && 'impressions' in without).toBe(false);
    expect(without && 'critiques' in without).toBe(false);

    const with_ = readerContext(db, 'work', 'work-1', { splits: [split({ inputHash: observationHashValue })] });
    expect(with_?.impressions).toEqual(['Jason read as witty and enjoyable', 'The worldbuilding']);
    expect(with_?.critiques).toEqual(['Jason also read as chatty and arrogant', 'Length and repetition']);
  });

  it('drops both sides when the split was written against different prose', () => {
    seed();
    publish(OBSERVATION);
    const context = readerContext(db, 'work', 'work-1', { splits: [split({ inputHash: 'stale-hash' })] });
    expect(context?.observation).toBe(OBSERVATION);
    expect(context && 'impressions' in context).toBe(false);
    expect(context && 'critiques' in context).toBe(false);
  });
});
