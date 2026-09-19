import { describe, expect, it } from 'vitest';
import {
  assessAudioCoverage, isAudioCoverageCurrent,
  type AudioCoverageInput, type CoverageEdition, type CoverageEvidence, type ReviewedAudioManifest
} from './coverage.js';

const NOW = '2026-09-19T12:00:00Z';
const OBSERVED = '2026-09-19T10:00:00Z';
const source = (overrides: Partial<CoverageEvidence> = {}): CoverageEvidence => ({
  documentId: 'bibliography-document', url: 'https://publisher.example/series/cradle',
  sourceType: 'publisher', observedAt: OBSERVED, ...overrides
});

function manifest(numbers: number[], overrides: Partial<ReviewedAudioManifest> = {}): ReviewedAudioManifest {
  return {
    id: 'reviewed-cradle-audio-list', seriesId: 'cradle', scope: 'numbered-mainline',
    language: 'english', marketplaces: ['US', 'publisher-direct'], expectedNumbers: numbers,
    reviewedAt: '2026-09-19T11:00:00Z', audioCatalogState: 'ongoing', bibliography: [source()], ...overrides
  };
}

function audio(number: number, date: string | null = '2023-06-06'): CoverageEdition {
  const workId = `work-cradle-${number}`;
  return {
    id: `edition-cradle-${number}`, workId, format: 'audiobook', verification: {
      method: 'exact-retailer-product', evidence: source({
        documentId: `audio-document-${number}`, url: `https://retailer.example/audio/${number}`, sourceType: 'retailer'
      }), workId, seriesId: 'cradle', number, language: 'english', marketplace: 'US',
      format: 'unabridged', audioReleaseDate: date
    }
  };
}

/** Synthetic dates/documents test coverage policy, not the contents of a live catalog. */
function catalog(numbers = [1, 2, 3]): AudioCoverageInput {
  return {
    seriesId: 'cradle', now: NOW, manifest: manifest(numbers),
    works: numbers.map(number => ({ id: `work-cradle-${number}`, seriesId: 'cradle', number })),
    editions: numbers.map(number => audio(number))
  };
}

const codes = (input: AudioCoverageInput) => assessAudioCoverage(input).issues.map(issue => issue.code);

describe('reviewed audio bibliography coverage', () => {
  it('accepts a fresh ongoing full list without requiring story completion', () => {
    const result = assessAudioCoverage(catalog());
    expect(result).toMatchObject({
      status: 'verified', current: true, verifiedAt: '2026-09-19T10:00:00.000Z',
      validUntil: '2026-09-26T10:00:00.000Z', expectedNumbers: [1, 2, 3],
      releasedWorkIds: ['work-cradle-1', 'work-cradle-2', 'work-cradle-3'], scheduledWorkIds: [], issues: []
    });
  });

  it('detects a missing final Cradle volume even when the imported list is contiguous', () => {
    const input = catalog(Array.from({ length: 12 }, (_, index) => index + 1));
    input.works = input.works.slice(0, 11);
    input.editions = input.editions.slice(0, 11);
    const result = assessAudioCoverage(input);
    expect(result.current).toBe(false);
    expect(result.status).toBe('incomplete');
    expect(result.issues).toContainEqual({ code: 'missing-work', number: 12, message: expect.any(String) });
    expect(result.expectedNumbers).toHaveLength(12);
    expect(result.releasedWorkIds).toHaveLength(11);
  });

  it('never promotes contiguity, number twelve, or a complete story flag into coverage', () => {
    const input = { ...catalog(Array.from({ length: 12 }, (_, index) => index + 1)), storyStatus: 'complete' };
    input.manifest = null;
    expect(assessAudioCoverage(input)).toMatchObject({ status: 'unknown', current: false, verifiedAt: null, validUntil: null });
    expect(codes(input)).toEqual(['missing-manifest']);
  });

  it('accepts the reviewed final twelve-work Cradle list only with all twelve released full audios', () => {
    const input = catalog(Array.from({ length: 12 }, (_, index) => index + 1));
    input.manifest = manifest([...input.manifest!.expectedNumbers], {
      audioCatalogState: 'complete', finalListEvidence: source({ sourceType: 'author', url: 'https://author.example/cradle' })
    });
    const result = assessAudioCoverage(input);
    expect(result).toMatchObject({ status: 'verified', current: true, validUntil: '2027-03-18T10:00:00.000Z' });
    expect(result.releasedWorkIds).toHaveLength(12);
    expect(result.releasedWorkIds.at(-1)).toBe('work-cradle-12');
  });

  it('requires final-list evidence before accepting a completed-audio manifest', () => {
    const input = catalog();
    input.manifest = { ...input.manifest!, audioCatalogState: 'complete' };
    expect(assessAudioCoverage(input)).toMatchObject({ status: 'unknown', current: false });
    expect(codes(input)).toContain('missing-final-list-evidence');
  });

  it.each([null, '2026-09', '2026-02-30', 'September 2026'])('leaves the audio date unresolved for %s', date => {
    const input = catalog();
    input.editions = [audio(1), audio(2), audio(3, date)];
    expect(assessAudioCoverage(input)).toMatchObject({ status: 'incomplete', current: false });
    expect(codes(input)).toContain('unknown-audio-date');
  });

  it('does not borrow a print-only final volume date even when the story is complete', () => {
    const input = catalog();
    input.manifest = { ...input.manifest!, audioCatalogState: 'complete', finalListEvidence: source() };
    input.editions = [audio(1), audio(2), { ...audio(3), format: 'print', verification: null }];
    expect(assessAudioCoverage(input)).toMatchObject({ status: 'incomplete', current: false });
    expect(codes(input)).toContain('missing-verified-audio');
  });

  it('does not promote a month-only final Portal audio to a completed catalog', () => {
    const input = catalog([1, 2, 3, 4, 5]);
    input.manifest = { ...input.manifest!, audioCatalogState: 'complete', finalListEvidence: source() };
    input.editions = [audio(1), audio(2), audio(3), audio(4), audio(5, '2026-09')];
    expect(assessAudioCoverage(input).issues).toContainEqual({
      code: 'unknown-audio-date', number: 5, workId: 'work-cradle-5', message: expect.any(String)
    });
  });

  it('expires an ongoing assertion from source time, not a fresh export or review timestamp', () => {
    const input = catalog();
    input.manifest = { ...input.manifest!, bibliography: [source({ observedAt: '2026-09-01T10:00:00Z' })] };
    expect(assessAudioCoverage(input)).toMatchObject({
      status: 'stale', current: false, verifiedAt: '2026-09-01T10:00:00.000Z', validUntil: '2026-09-08T10:00:00.000Z'
    });
    expect(codes(input)).toEqual(['expired-evidence']);
  });

  it('also bounds a completed audio catalog instead of making its assertion permanent', () => {
    const input = catalog();
    const oldSource = source({ observedAt: '2026-01-01T00:00:00Z' });
    input.manifest = { ...input.manifest!, audioCatalogState: 'complete', bibliography: [oldSource], finalListEvidence: oldSource };
    expect(assessAudioCoverage(input)).toMatchObject({ status: 'stale', current: false, validUntil: '2026-06-30T00:00:00.000Z' });
  });

  it('uses the oldest required bibliography source, so one newly checked page cannot refresh the full list', () => {
    const input = catalog();
    input.manifest = { ...input.manifest!, bibliography: [source(), source({ documentId: 'older-part', observedAt: '2026-09-10T10:00:00Z' })] };
    expect(assessAudioCoverage(input)).toMatchObject({ status: 'stale', verifiedAt: '2026-09-10T10:00:00.000Z' });
  });

  it('keeps scheduled audio out of required reads and ends the assertion at the next release', () => {
    const input = catalog();
    input.editions = [audio(1), audio(2), audio(3, '2026-09-22')];
    const result = assessAudioCoverage(input);
    expect(result).toMatchObject({
      status: 'verified', current: true, releasedWorkIds: ['work-cradle-1', 'work-cradle-2'],
      scheduledWorkIds: ['work-cradle-3'], validUntil: '2026-09-22T00:00:00.000Z'
    });
    expect(isAudioCoverageCurrent(result, '2026-09-21T23:59:59Z')).toBe(true);
    expect(isAudioCoverageCurrent(result, '2026-09-22T00:00:00Z')).toBe(false);
  });

  it('cannot renew an old preorder by checking only the bibliography', () => {
    const input = catalog();
    const preorder = audio(3, '2027-01-01');
    preorder.verification!.evidence.observedAt = '2026-01-01T00:00:00Z';
    input.editions = [audio(1), audio(2), preorder];

    const result = assessAudioCoverage(input);
    expect(result).toMatchObject({
      status: 'stale', current: false, verifiedAt: '2026-09-19T10:00:00.000Z',
      validUntil: '2026-01-08T00:00:00.000Z', releasedWorkIds: ['work-cradle-1', 'work-cradle-2']
    });
    expect(result.issues).toEqual([{
      code: 'expired-audio-schedule', number: 3, workId: 'work-cradle-3', message: expect.any(String)
    }]);

    // Reobserving the exact preorder, with the same date, resolves this specific gap.
    preorder.verification!.evidence.observedAt = OBSERVED;
    expect(assessAudioCoverage(input)).toMatchObject({
      status: 'verified', current: true, validUntil: '2026-09-26T10:00:00.000Z',
      scheduledWorkIds: ['work-cradle-3'], issues: []
    });
  });

  it('does not let a fresh alternate recording hide an obsolete preorder schedule', () => {
    const input = catalog([1]);
    const oldPreorder = audio(1, '2027-01-01');
    oldPreorder.verification!.evidence.observedAt = '2026-01-01T00:00:00Z';
    input.editions = [oldPreorder, { ...audio(1, '2026-10-01'), id: 'fresh-alternate-recording' }];
    expect(assessAudioCoverage(input)).toMatchObject({ status: 'stale', current: false, releasedWorkIds: [] });
    expect(codes(input)).toEqual(['expired-audio-schedule']);
  });

  it.each(['ongoing', 'complete'] as const)('keeps released recording history durable for a fresh %s bibliography', audioCatalogState => {
    const input = catalog([1]);
    input.manifest = manifest([1], {
      audioCatalogState, ...(audioCatalogState === 'complete' ? { finalListEvidence: source() } : {})
    });
    const released = audio(1, '2023-06-06');
    released.verification!.evidence.observedAt = '2023-06-07T00:00:00Z';
    const oldReissue = { ...audio(1, '2027-01-01'), id: 'old-reissue-preorder' };
    oldReissue.verification!.evidence.observedAt = '2026-01-01T00:00:00Z';
    input.editions = [released, oldReissue];

    expect(assessAudioCoverage(input)).toMatchObject({
      status: 'verified', current: true, releasedWorkIds: ['work-cradle-1'], scheduledWorkIds: [],
      validUntil: audioCatalogState === 'complete' ? '2027-03-18T10:00:00.000Z' : '2026-09-26T10:00:00.000Z',
      works: [{ workId: 'work-cradle-1', state: 'released', releaseDate: '2023-06-06', editionIds: ['edition-cradle-1'] }], issues: []
    });
  });

  it('does not turn an old preorder observation into a confirmed release when its date arrives', () => {
    const input = catalog();
    input.editions = [audio(1), audio(2), audio(3, '2026-09-20')];
    input.now = '2026-09-20T12:00:00Z';
    const result = assessAudioCoverage(input);
    expect(result).toMatchObject({ status: 'incomplete', current: false, releasedWorkIds: ['work-cradle-1', 'work-cradle-2'] });
    expect(codes(input)).toContain('release-not-reconfirmed');
    const confirmed = audio(3, '2026-09-20');
    confirmed.verification!.evidence.observedAt = input.now;
    input.editions = [audio(1), audio(2), confirmed];
    expect(assessAudioCoverage(input)).toMatchObject({ status: 'verified', current: true, scheduledWorkIds: [] });
  });

  it('does not grant final-catalog freshness while a reviewed final audio is still scheduled', () => {
    const input = catalog();
    input.manifest = { ...input.manifest!, audioCatalogState: 'complete', finalListEvidence: source() };
    input.editions = [audio(1), audio(2), audio(3, '2027-01-01')];
    expect(assessAudioCoverage(input)).toMatchObject({ current: true, validUntil: '2026-09-26T10:00:00.000Z', scheduledWorkIds: ['work-cradle-3'] });
  });

  it('requires review when another canonical mainline work is discovered beyond the manifest', () => {
    const input = catalog();
    input.works = [...input.works, { id: 'work-cradle-4', seriesId: 'cradle', number: 4 }];
    expect(assessAudioCoverage(input)).toMatchObject({ status: 'incomplete', current: false });
    expect(codes(input)).toContain('unlisted-work');
  });

  it('does not turn a reviewed supplemental collection into a thirteenth mainline Cradle book', () => {
    const input = catalog(Array.from({ length: 12 }, (_, index) => index + 1));
    input.works = [...input.works, { id: 'work-cradle-threshold', seriesId: 'cradle', number: 13, role: 'supplement' }];
    expect(assessAudioCoverage(input)).toMatchObject({ current: true, expectedNumbers: input.manifest!.expectedNumbers });
  });

  it('uses the reviewed number set directly without guessing a count or filling integer gaps', () => {
    const input = catalog([1, 2.5, 4]);
    expect(assessAudioCoverage(input)).toMatchObject({ current: true, expectedNumbers: [1, 2.5, 4] });
  });

  it('blocks ambiguous canonical work numbers instead of choosing one arbitrarily', () => {
    const input = catalog();
    input.works = [...input.works, { id: 'other-third-work', seriesId: 'cradle', number: 3 }];
    expect(codes(input)).toContain('ambiguous-work');
    expect(assessAudioCoverage(input).current).toBe(false);
  });

  it('accepts a verified direct publisher audiobook without any ASIN', () => {
    const input = catalog([1]);
    const edition = audio(1);
    edition.id = 'edition-source-audio';
    edition.verification = { ...edition.verification!, method: 'primary-audio-product', marketplace: 'publisher-direct', evidence: source() };
    input.editions = [edition];
    expect(assessAudioCoverage(input)).toMatchObject({ current: true, works: [{ editionIds: ['edition-source-audio'] }] });
  });

  it('ignores legacy matches, wrong identities, other languages, collections, and dramatizations as full audio proof', () => {
    const variants: CoverageEdition[] = [
      { ...audio(1), verification: null },
      { ...audio(1), verification: { ...audio(1).verification!, number: 2 } },
      { ...audio(1), verification: { ...audio(1).verification!, workId: 'wrong-work' } },
      { ...audio(1), verification: { ...audio(1).verification!, seriesId: 'another-series' } },
      { ...audio(1), verification: { ...audio(1).verification!, language: 'german' } },
      { ...audio(1), verification: { ...audio(1).verification!, marketplace: 'GB' } },
      { ...audio(1), verification: { ...audio(1).verification!, format: 'collection' } },
      { ...audio(1), format: 'dramatized' },
      { ...audio(1), verification: { ...audio(1).verification!, evidence: source({ sourceType: 'retailer', documentId: '' }) } }
    ];
    for (const edition of variants) {
      const input = { ...catalog([1]), editions: [edition] };
      expect(codes(input)).toContain('missing-verified-audio');
      expect(assessAudioCoverage(input).current).toBe(false);
    }
  });

  it('deduplicates required reads across alternate recordings and retains confirmed released work proof', () => {
    const input = catalog([1]);
    const alternate = { ...audio(1, null), id: 'alternate-undated-performance' };
    const reissue = { ...audio(1, '2026-10-01'), id: 'future-reissue' };
    input.editions = [audio(1), alternate, reissue];
    expect(assessAudioCoverage(input)).toMatchObject({
      current: true, releasedWorkIds: ['work-cradle-1'], scheduledWorkIds: [],
      works: [{ workId: 'work-cradle-1', state: 'released', editionIds: ['edition-cradle-1'] }]
    });
  });

  it('cannot call a work only upcoming if another verified recording has an unresolved date', () => {
    const input = catalog([1]);
    input.editions = [audio(1, '2026-10-01'), { ...audio(1, null), id: 'undated-performance' }];
    expect(codes(input)).toContain('unknown-audio-date');
    expect(assessAudioCoverage(input).scheduledWorkIds).toEqual([]);
  });

  it('rejects future, undated, insecure, or retailer-only bibliography evidence', () => {
    const invalidSources = [
      source({ observedAt: '2026-09-20T00:00:00Z' }), source({ observedAt: '' }),
      source({ url: 'http://publisher.example/books' }), source({ sourceType: 'retailer' })
    ];
    for (const bibliographySource of invalidSources) {
      const input = catalog();
      input.manifest = { ...input.manifest!, bibliography: [bibliographySource] };
      expect(assessAudioCoverage(input)).toMatchObject({ status: 'unknown', current: false });
      expect(codes(input)).toContain('invalid-evidence');
    }
  });

  it('does not accept duplicate expected numbers or a manifest for another series', () => {
    const input = catalog();
    input.manifest = { ...input.manifest!, expectedNumbers: [1, 2, 2, 3] };
    expect(codes(input)).toEqual(['invalid-manifest']);
    input.manifest = { ...manifest([1, 2, 3]), seriesId: 'other-series' };
    expect(codes(input)).toEqual(['invalid-manifest']);
  });

  it('checks the exclusive expiry at runtime rather than trusting the exported boolean forever', () => {
    const result = assessAudioCoverage(catalog());
    expect(isAudioCoverageCurrent(result, NOW)).toBe(true);
    expect(isAudioCoverageCurrent(result, '2026-09-26T10:00:00Z')).toBe(false);
    expect(isAudioCoverageCurrent(result, '2026-09-01T00:00:00Z')).toBe(false);
    expect(isAudioCoverageCurrent(result, 'not a timestamp')).toBe(false);
    expect(isAudioCoverageCurrent({ ...result, status: 'incomplete' }, NOW)).toBe(false);
    expect(isAudioCoverageCurrent(undefined, NOW)).toBe(false);
  });
});
