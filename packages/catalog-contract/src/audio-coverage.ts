/** Bibliography coverage is independent of story status and of a reader's progress. */
export const AUDIO_COVERAGE_FRESHNESS_DAYS = { ongoing: 7, complete: 180 } as const;

export interface CoverageEvidence {
  documentId: string;
  url: string;
  /** Successful observation of this retained document, in UTC; never a model/export time. */
  observedAt: string;
  sourceType: 'author' | 'publisher' | 'retailer';
}

export interface ReviewedAudioManifest {
  id: string;
  seriesId: string;
  scope: 'numbered-mainline';
  language: string;
  marketplaces: readonly string[];
  /** A reviewed enumeration, not a count or a range inferred from imported works. */
  expectedNumbers: readonly number[];
  reviewedAt: string;
  /** Describes the reviewed audio catalog, not catalog_series.status. */
  audioCatalogState: 'ongoing' | 'complete' | 'unknown';
  bibliography: readonly CoverageEvidence[];
  /** Reviewed proof of the final mainline list; all its audio must also be released. */
  finalListEvidence?: CoverageEvidence;
}

export interface CoverageWork {
  id: string;
  seriesId: string;
  number: number;
  /** Only an explicit reviewed side-story mapping may set this; do not guess from titles. */
  role?: 'mainline' | 'supplement';
}

/** Construct only by validating an actual retained product/page against its canonical work.
 * A buy link, a legacy title match, or a work's `verified` flag is not this verification. */
export interface AudioEditionVerification {
  method: 'exact-retailer-product' | 'primary-audio-product';
  evidence: CoverageEvidence;
  workId: string;
  seriesId: string;
  number: number;
  language: string;
  marketplace: string;
  format: 'unabridged' | 'abridged' | 'dramatized' | 'collection' | 'unknown';
  /** Audio-specific claim from the verified document; never a work/print/ebook date. */
  audioReleaseDate: string | null;
}

export interface CoverageEdition {
  id: string;
  workId: string;
  format: 'audiobook' | 'ebook' | 'print' | 'dramatized' | 'collection' | 'unknown';
  verification: AudioEditionVerification | null;
}

export interface AudioCoverageInput {
  seriesId: string;
  /** Explicit UTC timestamp keeps the assessor deterministic and safe for archived exports. */
  now: string;
  manifest: ReviewedAudioManifest | null | undefined;
  /** Supply every canonical work in the series, including newly discovered later works. */
  works: readonly CoverageWork[];
  editions: readonly CoverageEdition[];
}

export type AudioCoverageIssueCode =
  | 'missing-manifest' | 'invalid-manifest' | 'invalid-evidence' | 'missing-final-list-evidence'
  | 'expired-evidence' | 'unlisted-work' | 'missing-work' | 'ambiguous-work'
  | 'missing-verified-audio' | 'unknown-audio-date' | 'release-not-reconfirmed' | 'expired-audio-schedule';

export interface AudioCoverageIssue {
  code: AudioCoverageIssueCode;
  message: string;
  number?: number;
  workId?: string;
}

export interface CoveredAudioWork {
  workId: string;
  number: number;
  state: 'released' | 'scheduled';
  releaseDate: string;
  /** Only editions whose verification supports this work's release state. */
  editionIds: string[];
}

export interface AudioCoverage {
  status: 'verified' | 'incomplete' | 'unknown' | 'stale';
  /** Convenience at assessedAt only; clients must also check validUntil at runtime. */
  current: boolean;
  assessedAt: string;
  manifestId: string | null;
  scope: 'numbered-mainline';
  language: string | null;
  marketplaces: string[];
  /** Oldest required primary bibliography observation; a new export cannot refresh it. */
  verifiedAt: string | null;
  /** Exclusive upper bound, also capped at the next scheduled audio release. */
  validUntil: string | null;
  expectedNumbers: number[];
  releasedWorkIds: string[];
  scheduledWorkIds: string[];
  works: CoveredAudioWork[];
  sourceUrls: string[];
  issues: AudioCoverageIssue[];
}

const DAY = 86_400_000;
const key = (value: string) => value.trim().toLowerCase();
const numberIsValid = (value: number) => Number.isFinite(value) && value > 0;
const iso = (value: number) => new Date(value).toISOString();

function exactDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && iso(parsed).slice(0, 10) === value ? value : null;
}

function instant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)
    || !exactDate(value.slice(0, 10))) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validEvidence(evidence: CoverageEvidence, now: number, primary = false): boolean {
  if (!evidence.documentId?.trim() || !['author', 'publisher', 'retailer'].includes(evidence.sourceType)
    || primary && evidence.sourceType === 'retailer') return false;
  const observed = instant(evidence.observedAt);
  if (observed === null || observed > now) return false;
  try {
    const url = new URL(evidence.url);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

function verifiedEdition(edition: CoverageEdition, work: CoverageWork, manifest: ReviewedAudioManifest, now: number): boolean {
  const proof = edition.verification;
  if (!edition.id.trim() || edition.format !== 'audiobook' || edition.workId !== work.id || !proof
    || proof.workId !== work.id || proof.seriesId !== work.seriesId || proof.number !== work.number
    || proof.format !== 'unabridged' || key(proof.language) !== key(manifest.language)
    || !manifest.marketplaces.some(marketplace => key(marketplace) === key(proof.marketplace))
    || !validEvidence(proof.evidence, now)) return false;
  return proof.method === 'exact-retailer-product' && proof.evidence.sourceType === 'retailer'
    || proof.method === 'primary-audio-product' && proof.evidence.sourceType !== 'retailer';
}

/** Check this again in the browser: a shipped `current: true` is not timeless. */
export function isAudioCoverageCurrent(coverage: AudioCoverage | null | undefined, now: string): boolean {
  const at = instant(now), until = coverage?.validUntil ? instant(coverage.validUntil) : null;
  const assessed = coverage ? instant(coverage.assessedAt) : null;
  return coverage?.status === 'verified' && coverage.current && at !== null && until !== null
    && assessed !== null && assessed <= at && at < until;
}

/** Pure, conservative assessment. No network requests, database reads, or inferred tails. */
export function assessAudioCoverage(input: AudioCoverageInput): AudioCoverage {
  const at = instant(input.now);
  if (at === null) throw new RangeError('Audio coverage requires an exact UTC assessment timestamp.');
  const today = iso(at).slice(0, 10), manifest = input.manifest;
  const result: AudioCoverage = {
    status: 'unknown', current: false, assessedAt: iso(at), manifestId: manifest?.id ?? null,
    scope: 'numbered-mainline', language: manifest?.language ?? null, marketplaces: [...(manifest?.marketplaces ?? [])],
    verifiedAt: null, validUntil: null, expectedNumbers: [], releasedWorkIds: [], scheduledWorkIds: [],
    works: [], sourceUrls: [], issues: []
  };
  const issue = (code: AudioCoverageIssueCode, message: string, work?: Pick<CoverageWork, 'number' | 'id'>) => {
    result.issues.push({ code, message, ...(work ? { number: work.number, workId: work.id } : {}) });
  };
  if (!manifest) {
    issue('missing-manifest', 'No reviewed audio bibliography establishes the expected work list.');
    return result;
  }
  const reviewed = instant(manifest.reviewedAt);
  if (!manifest.id.trim() || manifest.seriesId !== input.seriesId || manifest.scope !== 'numbered-mainline'
    || !manifest.language.trim() || !manifest.marketplaces.length || manifest.marketplaces.some(marketplace => !marketplace.trim())
    || !['ongoing', 'complete', 'unknown'].includes(manifest.audioCatalogState)
    || reviewed === null || reviewed > at || !manifest.expectedNumbers.length
    || manifest.expectedNumbers.some(number => !numberIsValid(number))
    || new Set(manifest.expectedNumbers).size !== manifest.expectedNumbers.length) {
    issue('invalid-manifest', 'The reviewed bibliography has invalid identity, scope, dates, or expected numbers.');
    return result;
  }
  result.expectedNumbers = [...manifest.expectedNumbers].sort((left, right) => left - right);
  const bibliography = [...manifest.bibliography];
  if (manifest.audioCatalogState === 'complete') {
    if (!manifest.finalListEvidence) {
      issue('missing-final-list-evidence', 'A completed audio catalog needs reviewed evidence of the final mainline list.');
      return result;
    }
    bibliography.push(manifest.finalListEvidence);
  }
  if (!manifest.bibliography.length || bibliography.some(evidence => !validEvidence(evidence, at, true))) {
    issue('invalid-evidence', 'The full bibliography needs dated, retained author or publisher evidence.');
    return result;
  }
  const observed = Math.min(...bibliography.map(evidence => instant(evidence.observedAt)!));
  result.verifiedAt = iso(observed);
  result.sourceUrls = [...new Set(bibliography.map(evidence => evidence.url))].sort();

  const works = input.works.filter(work => work.seriesId === input.seriesId && work.role !== 'supplement');
  const expected = new Set(result.expectedNumbers);
  for (const work of works) {
    if (!expected.has(work.number)) issue('unlisted-work', 'A canonical mainline work falls outside the reviewed list; review its scope and audio availability.', work);
  }
  const editionIdCounts = new Map<string, number>();
  const scheduleExpiries: number[] = [];
  for (const edition of input.editions) editionIdCounts.set(edition.id, (editionIdCounts.get(edition.id) ?? 0) + 1);
  for (const number of result.expectedNumbers) {
    const matches = works.filter(work => work.number === number);
    if (!matches.length) {
      result.issues.push({ code: 'missing-work', number, message: 'An expected work is missing from the canonical catalog.' });
      continue;
    }
    const work = matches[0];
    if (matches.length !== 1 || !work.id.trim() || works.filter(other => other.id === work.id).length !== 1) {
      issue('ambiguous-work', 'This expected number does not resolve to one canonical work identity.', work);
      continue;
    }
    const audio = input.editions.filter(edition => editionIdCounts.get(edition.id) === 1 && verifiedEdition(edition, work, manifest, at));
    if (!audio.length) {
      issue('missing-verified-audio', 'No strictly verified full audiobook establishes this work in the selected language and marketplace.', work);
      continue;
    }
    const dated = audio.map(edition => ({ edition, date: exactDate(edition.verification!.audioReleaseDate) }));
    const released = dated.filter((row): row is { edition: CoverageEdition; date: string } => row.date !== null
      && row.date <= today && row.date <= row.edition.verification!.evidence.observedAt.slice(0, 10));
    // One observed released recording is sufficient for work-level progress. An undated
    // alternate performance cannot undo that proof or create another required read.
    if (released.length) {
      const releaseDate = released.map(row => row.date).sort()[0];
      result.works.push({ workId: work.id, number, state: 'released', releaseDate, editionIds: released.map(row => row.edition.id).sort() });
      result.releasedWorkIds.push(work.id);
      continue;
    }
    if (dated.some(row => row.date === null)) {
      issue('unknown-audio-date', 'The work has verified audio but no resolved exact audio release date.', work);
      continue;
    }
    if (dated.some(row => row.date! <= today)) {
      issue('release-not-reconfirmed', 'A scheduled audio date has arrived without a confirming observation on or after that date.', work);
      continue;
    }
    const releaseDate = dated.map(row => row.date!).sort()[0];
    // A fresh bibliography does not refresh a months-old preorder. Any unreleased
    // recording might have moved earlier, so renew its own schedule evidence too.
    const scheduleExpiry = Math.min(...audio.map(edition => instant(edition.verification!.evidence.observedAt)!))
      + AUDIO_COVERAGE_FRESHNESS_DAYS.ongoing * DAY;
    scheduleExpiries.push(scheduleExpiry);
    if(at>=scheduleExpiry)issue('expired-audio-schedule','The exact audiobook schedule needs a fresh source check; checking only the bibliography cannot renew it.',work);
    result.works.push({ workId: work.id, number, state: 'scheduled', releaseDate, editionIds: audio.map(edition => edition.id).sort() });
    result.scheduledWorkIds.push(work.id);
  }

  // A final story list alone earns no longer freshness window. Every expected full audio
  // must be verified as released, and the final list itself must have primary evidence.
  const completedAudio = manifest.audioCatalogState === 'complete' && result.issues.length === 0
    && result.releasedWorkIds.length === result.expectedNumbers.length;
  const days = completedAudio ? AUDIO_COVERAGE_FRESHNESS_DAYS.complete : AUDIO_COVERAGE_FRESHNESS_DAYS.ongoing;
  const nextRelease = result.works.filter(work => work.state === 'scheduled').map(work => Date.parse(`${work.releaseDate}T00:00:00Z`));
  const expires = Math.min(observed + days * DAY, ...nextRelease, ...scheduleExpiries);
  result.validUntil = iso(expires);
  const expired = at >= expires;
  if (at >= observed + days * DAY) issue('expired-evidence', 'The bibliography evidence is due for another permitted source check and review.');
  result.status = result.issues.some(problem => !['expired-evidence','expired-audio-schedule'].includes(problem.code)) ? 'incomplete'
    : expired ? 'stale' : 'verified';
  result.current = result.status === 'verified';
  return result;
}
