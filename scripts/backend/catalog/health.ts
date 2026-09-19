import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import type {
  CatalogHealth, HealthAudio, HealthBibliography, HealthCheck, HealthCover, HealthIssue,
  HealthReader, HealthScore, HealthSource, HealthStatus, HealthVolumeGap, SeriesHealth, WorkHealth
} from '../../../src/lib/catalog-health.js';
import { AUDIO_COVERAGE_FRESHNESS_DAYS } from '../../../src/lib/audio-coverage.js';
import { tasteLabels, validReleaseDate } from '../../../src/lib/catalog.js';
import { COVER_ASSET_DIR, readCoverAsset, type CoverImage } from '../covers/assets.js';
import { loadCoverImageSource } from '../covers/vision-cache.js';
import { coverCacheKey, validateObservation as validateCoverObservation } from '../covers/vision.js';
import { recordingNarrator, recordingRuntime } from '../fetchers/audible.js';
import { assessmentHash } from '../jev/assessment.js';
import { audioWorkIdentity, verifyCanonicalAudioProduct } from './audio.js';
import { audioManifests, catalogAudioCoverage, type AudioManifestSpec } from './coverage-store.js';
import { editorialReviews, reviewedMetadata, type EditorialReview } from './editorial.js';
import { extractionHash, extractionInput, profileInput, seriesExtractionContext, validateExtraction } from './inference.js';
import { hash } from './queue.js';
import {
  observationStatus, readerEvidenceFor, readerState, readerThresholds, readerTraitHash,
  readerTraits, READER_RUBRIC_VERSION, traitInput
} from './reader-evidence.js';
import type { Document, SeedSeries, WorkRow } from './types.js';

const configuredSeeds = JSON.parse(readFileSync(new URL('../config/catalog-seeds.json', import.meta.url), 'utf8')) as SeedSeries[];
const DAY = 86_400_000;
const SOURCE_DESCRIPTION_CHARS = 100;
const COVER_FRESHNESS_DAYS = 30;
const quantityChecks = ['source-description', 'original-summary', 'extracted-metadata', 'jev-assessment',
  'audio-edition', 'audio-date', 'narrator', 'runtime', 'cover-asset', 'reader-sample'];
const evidenceChecks = ['source-description', 'reviewed-metadata', 'audio-verified', 'audio-date',
  'cover-observation', 'reader-adequacy', 'reader-traits', 'reader-observation', 'source-freshness'];

interface SeriesRow { id: string; title: string; author: string; description: string; metadata_json: string | null; priority: number }
interface EditionRow {
  id: string; work_id: string; legacy_book_id: string | null; format: string; source_url: string;
  release_date: string | null; cover_url: string | null; narrator: string | null; runtime_minutes: number | null;
  identifiers_json: string;
}
interface UrlRow { url: string; document_id: string; checked_at: string; next_check_at: string }
interface InferenceRow { result_json: string; input_hash: string; evaluated_at: string }
interface VerifiedAudio {
  edition: EditionRow;
  product: ReturnType<typeof verifyCanonicalAudioProduct>;
  document: Document;
  observedAt: string;
}
export interface CatalogHealthOptions {
  registry?: readonly SeedSeries[];
  manifests?: readonly AudioManifestSpec[];
  reviews?: readonly EditorialReview[];
  assetDirectory?: string;
}

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const json = (value: string | null | undefined): Record<string, unknown> | null => {
  try { return object(JSON.parse(value ?? 'null')); } catch { return null; }
};
const instant = (value: string | null | undefined): string | null => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const oldest = (values: (string | null)[]) => values.filter((value): value is string => !!value).sort()[0] ?? null;
const newest = (values: (string | null)[]) => values.filter((value): value is string => !!value).sort().at(-1) ?? null;
const addDays = (at: string, days: number) => new Date(Date.parse(at) + days * DAY).toISOString();

/** Public links carry no credentials, query strings, fragments, local paths, or profile URLs. */
function publicUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[::1\])/.test(url.hostname)
      || /^172\.(?:1[6-9]|2\d|3[01])\./.test(url.hostname)
      || /\.(?:local|internal)$/.test(url.hostname)
      || /\/(?:users?|profile|profiles)\//i.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}
const links = (values: (string | null | undefined)[]) => [...new Set(values.map(publicUrl).filter((url): url is string => !!url))].sort();
function audioIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === 'https://api.audible.com' && !url.username && !url.password && !url.hash
      && /^\/1\.0\/catalog\/products\/[A-Z0-9]{10}$/.test(url.pathname)
      && [...url.searchParams.keys()].every(key => key === 'response_groups') ? `${url.origin}${url.pathname}` : null;
  } catch { return null; }
}
function check(id: string, label: string, status: HealthStatus, available: boolean, explanation: string,
  sourceUrl: string | null = null, observedAt: string | null = null, dueAt: string | null = null): HealthCheck {
  return { id, label, status, available, explanation, sourceUrl: publicUrl(sourceUrl), observedAt: instant(observedAt), dueAt: instant(dueAt) };
}
function score(checks: HealthCheck[], ids: string[], quality: boolean): HealthScore {
  const selected = checks.filter(item => ids.includes(item.id));
  const earned = selected.filter(item => quality ? item.status === 'present' : item.available).length;
  const possible = ids.length;
  return { percent: Math.round(100 * earned / possible), earned, possible,
    explanation: `${earned}/${possible} equally weighted ${quality ? 'current evidence and review' : 'usable retained data'} checks. ${quality ? 'Unknown, missing, and stale checks earn no evidence credit.' : 'Retained data can earn presence credit while still needing verification.'}` };
}
const issuesFor = (checks: HealthCheck[]): HealthIssue[] => checks.filter(item => item.status !== 'present')
  .map(item => ({ code: item.id, status: item.status as HealthIssue['status'], message: item.explanation }));

/** A header and checksum are deterministic file checks, not a visual judgement of the artwork. */
function imageBytes(image: CoverImage): boolean {
  const bytes = image.data;
  if (image.mime === 'image/png') return bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
    && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND';
  if (image.mime === 'image/jpeg') return bytes.length > 20 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  return image.mime === 'image/webp' && bytes.length > 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length
    && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16));
}

/** No network, model calls, migrations, or database writes. Every result is an explicit safe projection. */
export function buildCatalogHealth(db: Database.Database, now = new Date(), options: CatalogHealthOptions = {}): CatalogHealth {
  const generatedAt = now.toISOString(), today = generatedAt.slice(0, 10);
  const registry = options.registry ?? configuredSeeds, manifests = options.manifests ?? audioManifests;
  const reviews = options.reviews ?? editorialReviews, assetDirectory = options.assetDirectory ?? COVER_ASSET_DIR;
  return db.transaction((): CatalogHealth => {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    const seriesRows = db.prepare('SELECT id,title,author,description,metadata_json,priority FROM catalog_series ORDER BY title,id').all() as SeriesRow[];
    const workRows = db.prepare('SELECT * FROM catalog_works ORDER BY series_id,number,id').all() as WorkRow[];
    const editionRows = db.prepare('SELECT * FROM catalog_editions ORDER BY work_id,id').all() as EditionRow[];
    const urlRows = db.prepare('SELECT url,document_id,checked_at,next_check_at FROM catalog_urls ORDER BY checked_at DESC,url').all() as UrlRow[];
    const heads = new Map<string, UrlRow>();
    for (const row of urlRows) {
      const key = audioIdentity(row.url) ?? row.url, previous = heads.get(key);
      const date = instant(row.checked_at), oldDate = instant(previous?.checked_at);
      if (!previous || date && (!oldDate || date > oldDate)
        || date === oldDate && (instant(row.next_check_at) ?? '') < (instant(previous.next_check_at) ?? '')) heads.set(key, row);
    }
    const documentCache = new Map<string, Document | null>();
    const document = (id: string) => {
      if (!documentCache.has(id)) documentCache.set(id, db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(id) as Document | undefined ?? null);
      return documentCache.get(id)!;
    };
    const sourceCache = new Map<string, HealthSource | null>();
    const source = (rawUrl: string): HealthSource | null => {
      const key = audioIdentity(rawUrl) ?? rawUrl;
      if (sourceCache.has(key)) return sourceCache.get(key)!;
      const url = publicUrl(rawUrl);
      if (!url) { sourceCache.set(key, null); return null; }
      const head = heads.get(key), doc = head ? document(head.document_id) : null;
      const checkedAt = instant(head?.checked_at), fetchedAt = instant(doc?.fetched_at), nextCheckAt = instant(head?.next_check_at);
      const valid = !!doc && (audioIdentity(doc.url) ?? doc.url) === key && hash(doc.body) === doc.content_hash
        && !!checkedAt && checkedAt <= generatedAt && !!fetchedAt && fetchedAt <= checkedAt;
      const result: HealthSource = { url, status: !valid || !nextCheckAt ? 'unknown' : nextCheckAt <= generatedAt ? 'stale' : 'present',
        checkedAt: valid ? checkedAt : null, fetchedAt, nextCheckAt: valid ? nextCheckAt : null };
      sourceCache.set(key, result);
      return result;
    };
    const mergeSources = (rows: (HealthSource | null)[]): HealthSource[] => {
      const groups = new Map<string, HealthSource[]>();
      for (const row of rows) if (row) groups.set(row.url, [...(groups.get(row.url) ?? []), row]);
      // Redaction can make distinct query-bearing source URLs look alike. Keep the
      // most cautious state; never use a good page to hide an unchecked different page.
      return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([url, group]) => ({ url,
        status: group.some(row => row.status === 'unknown') ? 'unknown' : group.some(row => row.status === 'stale') ? 'stale' : 'present',
        checkedAt: group.every(row => row.checkedAt) ? oldest(group.map(row => row.checkedAt)) : null,
        fetchedAt: oldest(group.map(row => row.fetchedAt)), nextCheckAt: group.every(row => row.nextCheckAt) ? oldest(group.map(row => row.nextCheckAt)) : null }));
    };
    const sourceCheck = (sources: HealthSource[]) => {
      const current = sources.filter(row => row.status === 'present').length, stale = sources.filter(row => row.status === 'stale').length;
      const unknown = sources.length - current - stale;
      const status: HealthStatus = !sources.length || unknown ? 'unknown' : stale ? 'stale' : 'present';
      const relevant = sources.find(row => row.status === status) ?? sources[0];
      return check('source-freshness', 'Source checks', status, sources.some(row => !!row.checkedAt),
        `${current}/${sources.length} associated source checks are current; ${stale} are due and ${unknown} lack a valid recorded check or refresh schedule. Retained notes and buy links alone do not establish a crawl.`,
        relevant?.url ?? null, relevant?.checkedAt ?? null, relevant?.nextCheckAt ?? null);
    };
    const bySeries = new Map<string, WorkRow[]>(), byWork = new Map<string, EditionRow[]>();
    for (const work of workRows) bySeries.set(work.series_id, [...(bySeries.get(work.series_id) ?? []), work]);
    for (const edition of editionRows) byWork.set(edition.work_id, [...(byWork.get(edition.work_id) ?? []), edition]);
    const seedFor = (id: string) => { const selected = registry.filter(seed => seed.id === id); return selected.length === 1 ? selected[0] : undefined; };

    const metadata = (entityType: 'work' | 'series', id: string, input: { kind: 'work' | 'series'; title: string; author: string; description: string } | null,
      urls: string[], description: string, projection: string | null): HealthCheck[] => {
      const latest = db.prepare("SELECT result_json,input_hash,evaluated_at FROM catalog_inferences WHERE entity_type=? AND entity_id=? AND kind='extract' ORDER BY evaluated_at DESC,id DESC LIMIT 1")
        .get(entityType, id) as InferenceRow | undefined;
      const receipt = input ? db.prepare("SELECT result_json,input_hash,evaluated_at FROM catalog_inferences WHERE entity_type=? AND entity_id=? AND kind='extract' AND input_hash=?")
        .get(entityType, id, extractionHash(input)) as InferenceRow | undefined : undefined;
      let current = false, retained = false, invalid = false, reviewed: ReturnType<typeof reviewedMetadata> = null;
      for (const row of [receipt, latest]) if (row) {
        try { validateExtraction(JSON.parse(row.result_json), input?.description ?? ''); retained = true; if (row === receipt) current = !!instant(row.evaluated_at) && row.evaluated_at <= generatedAt; }
        catch { invalid = true; }
      }
      try { if (input && urls[0]) reviewed = reviewedMetadata(db, entityType, id, input, urls[0], reviews, urls.slice(1)); }
      catch { invalid = true; }
      if (reviewed && reviewed.evidence.reviewedAt > generatedAt) reviewed = null;
      const oldReview = reviews.some(review => review.entityType === entityType && review.entityId === id);
      const retainedSummary = retained || !!reviewed || !!description.trim();
      const reviewStatus = reviewed ? 'present' : oldReview ? 'stale' : 'missing';
      const extractionStatus: HealthStatus = current || reviewed ? 'present' : invalid ? 'unknown' : retained || projection ? 'stale' : 'missing';
      return [
        check('original-summary', 'Original summary', current || reviewed ? 'present' : retainedSummary ? 'stale' : 'missing', retainedSummary,
          reviewed ? 'An original synopsis is retained in a source-bound editorial review.' : current ? 'A validated original synopsis is retained for the current source and extraction settings; factual editorial review is separate.'
            : retainedSummary ? 'A summary is retained but no current extraction or source-bound review establishes it for this evidence.' : 'No original catalog synopsis is retained.', urls[0], reviewed?.evidence.reviewedAt ?? receipt?.evaluated_at ?? latest?.evaluated_at ?? null),
        check('extracted-metadata', 'Extracted metadata', extractionStatus, retained || !!reviewed,
          reviewed ? 'An immutable extraction supports the current editorial review. A model-only change does not require another purchase.'
            : current ? 'The current source has a validated extraction receipt. Extracted features remain candidates until editorial review.'
              : extractionStatus === 'stale' ? 'Retained extraction settings or source inputs no longer match. Inspect cached evidence before planning another model call.'
                : extractionStatus === 'unknown' ? 'A retained extraction could not be validated; review its private receipt.' : 'No validated extraction receipt is retained.', urls[0], receipt?.evaluated_at ?? latest?.evaluated_at ?? null),
        check('reviewed-metadata', 'Reviewed metadata', reviewStatus, !!reviewed || oldReview,
          reviewed ? 'An editorial review binds the exact evidence, contributing URLs, taxonomy, and immutable extraction receipt. An empty approved feature list is valid.'
            : oldReview ? 'A previous review no longer resolves against the current evidence, source URLs, taxonomy, or retained receipt.' : 'No source-bound editorial review is retained; automatic tags are not reviewed facts.', urls[0], reviewed?.evidence.reviewedAt ?? null)
      ];
    };

    const verifyAudio = (work: WorkRow, editions: EditionRow[], seed: SeedSeries | undefined): VerifiedAudio[] => {
      if (!seed) return [];
      return editions.flatMap(edition => {
        const identifiers = json(edition.identifiers_json), asin = edition.legacy_book_id;
        if (edition.format !== 'audiobook' || !asin || !/^[A-Z0-9]{10}$/.test(asin) || identifiers?.asin !== asin
          || identifiers.marketplace !== 'US' || typeof identifiers.verifiedDocument !== 'string'
          || identifiers.workIdentityHash !== audioWorkIdentity(work)) return [];
        const base = `https://api.audible.com/1.0/catalog/products/${asin}`;
        const recorded = document(identifiers.verifiedDocument);
        if (!recorded || audioIdentity(recorded.url) !== base) return [];
        // Use the authoritative verifier's exact latest-head ordering, including all
        // query variants. A newer conflict must never fall back to old good evidence.
        const current = db.prepare(`SELECT d.id FROM catalog_urls u JOIN catalog_documents d ON d.id=u.document_id
          WHERE u.url=? OR u.url LIKE ? ORDER BY u.checked_at DESC,d.fetched_at DESC,d.id LIMIT 1`).get(base, `${base}?%`) as { id: string } | undefined;
        const doc = current ? document(current.id) : recorded;
        if (!doc || audioIdentity(doc.url) !== base) return [];
        const head = urlRows.find(row => row.url === doc.url);
        const fetchedAt = instant(doc.fetched_at), checkedAt = instant(head?.checked_at);
        const observedAt = checkedAt && fetchedAt && checkedAt > fetchedAt ? checkedAt : fetchedAt;
        if (!observedAt || observedAt > generatedAt || head && head.document_id !== doc.id) return [];
        try { return [{ edition, product: verifyCanonicalAudioProduct(db, JSON.parse(doc.body), asin, seed, work, doc), document: doc, observedAt }]; }
        catch { return []; }
      });
    };

    const coverCache = new Map<string, { cover: HealthCover; checks: HealthCheck[] }>();
    const coverFor = (rawUrl: string | null) => {
      if (coverCache.has(rawUrl ?? '')) return coverCache.get(rawUrl ?? '')!;
      const url = publicUrl(rawUrl);
      const image = rawUrl && tables.has('cover_sources') ? loadCoverImageSource(db, rawUrl) : null;
      let asset: CoverImage | null = null, invalid = false, observed = false, hadObservation = false;
      if (image) {
        try { const candidate = readCoverAsset(image.image_hash, assetDirectory); if (candidate && imageBytes(candidate)) asset = candidate; else if (candidate) invalid = true; }
        catch { invalid = true; }
        const row = db.prepare(`SELECT o.cache_key,o.image_hash,o.observation_json,o.evaluated_at FROM cover_sources s
          JOIN cover_observations o ON o.cache_key=s.cache_key WHERE s.cover_url=?`).get(rawUrl) as {
            cache_key: string; image_hash: string; observation_json: string; evaluated_at: string
          } | undefined;
        hadObservation = !!row;
        if (row && row.image_hash === image.image_hash && row.cache_key === coverCacheKey(image.image_hash)) {
          try { validateCoverObservation(JSON.parse(row.observation_json)); const evaluatedAt = instant(row.evaluated_at); observed = !!evaluatedAt && evaluatedAt <= generatedAt; }
          catch { invalid = true; }
        }
      }
      const checkedAt = instant(image?.checked_at), dueAt = checkedAt ? addDays(checkedAt, COVER_FRESHNESS_DAYS) : null;
      const current = !!asset && observed && !!checkedAt && checkedAt <= generatedAt && !!dueAt && dueAt > generatedAt;
      const cover: HealthCover = { url, cached: !!asset, hashVerified: !!asset, bytes: asset?.data.length ?? null,
        observationCurrent: current, checkedAt };
      const checks = [
        check('cover-url', 'Cover link', url ? 'present' : 'missing', !!url, url ? 'A public image URL is retained; this alone is not a downloaded cover asset.' : 'No public cover URL is retained.', url),
        check('cover-asset', 'Cached cover asset', asset ? 'present' : invalid ? 'unknown' : 'missing', !!asset,
          asset ? 'The currently associated cover has local JPEG, PNG, or WebP bytes with a matching SHA-256 checksum and image header. This is file evidence, not a visual book-identity judgement.'
            : invalid ? 'Retained cover bytes failed the checksum or image-format check; inspect the private asset.' : 'No checksum-verified image file is cached for the currently associated cover. A URL or an old different image does not fill this gap.', url, checkedAt),
        check('cover-observation', 'Cover observation', current ? 'present' : observed || hadObservation ? 'stale' : invalid ? 'unknown' : 'missing', observed || hadObservation,
          current ? 'A validated current-rubric observation is bound to these exact cached image bytes.'
            : observed && dueAt && dueAt <= generatedAt ? `The cover URL has not been checked within ${COVER_FRESHNESS_DAYS} days; cached bytes and the earlier observation remain retained.`
              : hadObservation ? 'A cover observation exists but its image, settings, asset, or freshness no longer establishes the current cover.' : 'No validated observation is bound to the current cached cover bytes.', url, checkedAt, dueAt)
      ];
      const result = { cover, checks }; coverCache.set(rawUrl ?? '', result); return result;
    };

    const readerFor = (work: WorkRow): { reader: HealthReader; checks: HealthCheck[] } => {
      const rows = tables.has('catalog_reader_traits') ? readerEvidenceFor(db, 'work', work.id) : [];
      const selected = traitInput(rows), eligible = selected.length >= readerThresholds.voices;
      const sourceUrls = links(selected.map(row => row.source_url));
      const currentHash = readerTraitHash(readerState(rows));
      const traits = tables.has('catalog_reader_traits') ? db.prepare(`SELECT trait,value,confidence,model_confidence,consensus,summary,voices,samples,evidence_json,requested_model,model,input_hash,rubric_version,evaluated_at FROM catalog_reader_traits
        WHERE entity_type='work' AND entity_id=? ORDER BY trait,evaluated_at DESC,rowid DESC`).all(work.id) as {
          trait: string; value: string; confidence: number; model_confidence: number; consensus: string; summary: string;
          voices: number; samples: number; evidence_json: string; requested_model: string; model: string;
          input_hash: string; rubric_version: string; evaluated_at: string
        }[] : [];
      const latest = new Map<string, typeof traits[number]>();
      for (const row of traits) if (!latest.has(row.trait)) latest.set(row.trait, row);
      const selectedIds = selected.map(row => row.id).sort();
      const unit = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
      const validTrait = (row: typeof traits[number] | undefined): boolean => {
        if (!row || !['present', 'absent', 'unknown'].includes(row.value) || !['consistent', 'mixed', 'insufficient'].includes(row.consensus)
          || !unit(row.confidence) || !unit(row.model_confidence) || !row.summary?.trim() || !row.model?.trim()
          || !Number.isSafeInteger(row.voices) || row.voices < 0 || row.voices !== row.samples) return false;
        const proof = json(row.evidence_json), ids = proof?.evidenceIds;
        return Array.isArray(ids) && ids.every(id => typeof id === 'string' && !!id) && proof?.consensus === row.consensus
          && ids.length === row.samples && new Set(ids).size === ids.length;
      };
      const currentEvidence = (row: typeof traits[number]) => row.voices === selected.length
        && JSON.stringify([...(json(row.evidence_json)!.evidenceIds as string[])].sort()) === JSON.stringify(selectedIds);
      const malformedTraits = readerTraits.some(trait => {
        const row = latest.get(trait); return row && (!validTrait(row) || row.input_hash === currentHash && !currentEvidence(row));
      });
      const currentTraits = eligible && readerTraits.every(trait => {
        const row = latest.get(trait), date = instant(row?.evaluated_at);
        return validTrait(row) && currentEvidence(row!) && row!.input_hash === currentHash && row!.rubric_version === READER_RUBRIC_VERSION
          && row!.requested_model === (process.env.JEV_MODEL ?? 'jev-latest') && !!date && date <= generatedAt;
      }) && new Set(readerTraits.map(trait => latest.get(trait)!.consensus)).size === 1;
      let observation: HealthReader['observation'] = 'missing';
      if (tables.has('catalog_reader_traits') && rows.length) {
        try { observation = observationStatus(db, 'work', work.id, rows).status; } catch { observation = 'withheld'; }
      }
      const retainedObservation = !!db.prepare("SELECT 1 FROM catalog_inferences WHERE entity_type='reader' AND entity_id=? AND kind IN ('reader-observation','reader-observation-wire','reader-observation-raw') LIMIT 1").get(`work:${work.id}`);
      const publishable = eligible && ['published', 'corrected'].includes(observation);
      if (!eligible && observation !== 'missing') observation = 'withheld';
      const observedAt = tables.has('catalog_reader_traits') ? instant((db.prepare("SELECT MAX(observed_at) observed_at FROM catalog_reader_evidence WHERE work_id=? AND removed_at IS NULL").get(work.id) as { observed_at: string | null }).observed_at) : null;
      const reader: HealthReader = { retainedCount: rows.length, selectedCount: selected.length, eligible,
        minimum: readerThresholds.voices, currentTraits, observation, sourceUrls };
      return { reader, checks: [
        check('reader-sample', 'Usable reader comments', selected.length ? 'present' : 'missing', selected.length > 0,
          `${selected.length} usable comments are selected from ${rows.length} retained, nonremoved comments after deduplication, minimum length, spoiler exclusion, and the ${readerThresholds.maxComments}-comment cap. This does not establish that contributors listened to the audiobook.`, sourceUrls[0], observedAt),
        check('reader-adequacy', 'Reader sample adequacy', eligible ? 'present' : selected.length ? 'unknown' : 'missing', eligible,
          `${selected.length}/${readerThresholds.voices} required selected voices. This is the existing aggregation gate, not measured agreement, representativeness, or a judgement of comment quality.`, sourceUrls[0], observedAt),
        check('reader-traits', 'Current reader traits', currentTraits ? 'present' : malformedTraits ? 'unknown' : traits.length ? 'stale' : 'missing', traits.length > 0,
          currentTraits ? 'All four reader-trait receipts match the exact selected sample and current rubric; an unknown trait value is a valid result.'
            : malformedTraits ? 'A retained reader-trait row has invalid result fields, counts, or selected-evidence bindings; review its private receipt.'
              : traits.length ? 'Retained reader traits are incomplete or no longer match the eligible selected sample and current rubric.' : 'No current set of reader-trait receipts is retained.', sourceUrls[0], newest(traits.map(row => instant(row.evaluated_at)))),
        check('reader-observation', 'Publishable reader context', publishable ? 'present' : observation === 'withheld' ? 'unknown' : retainedObservation ? 'stale' : 'missing', retainedObservation,
          publishable ? 'A retained, original observation or reviewed correction passes the current evidence and prose gates.'
            : observation === 'withheld' ? 'Retained reader context needs review or the selected sample is not adequate; no prose is exposed here.'
              : retainedObservation ? 'An earlier observation exists, but none resolves for the current selected evidence.' : 'No retained reader observation is available.', sourceUrls[0], observedAt)
      ] };
    };

    const works: WorkHealth[] = workRows.map(work => {
      const all = byWork.get(work.id) ?? [], audioEditions = all.filter(edition => ['audiobook', 'dramatized'].includes(edition.format));
      const seed = seedFor(work.series_id), confirmed = verifyAudio(work, all, seed);
      const dated = confirmed.map(audio => ({ audio, date: validReleaseDate(audio.product.release_date, now) }));
      const released = dated.filter(row => row.date && row.date <= today && row.date <= row.audio.observedAt.slice(0, 10));
      // Match coverage's conservative work-level schedule rule: one observed
      // released performance suffices, but an undated/stale alternate cannot be
      // hidden behind a different performance's fresh future preorder.
      const unresolvedDate = dated.some(row => !row.date);
      const staleSchedule = !released.length && dated.some(row => row.date
        && (row.date <= today || addDays(row.audio.observedAt, AUDIO_COVERAGE_FRESHNESS_DAYS.ongoing) <= generatedAt));
      const scheduled = !released.length && !unresolvedDate && !staleSchedule ? dated.filter(row => row.date && row.date > today) : [];
      const relevant = [...(released.length ? released : scheduled)].sort((a, b) => a.date!.localeCompare(b.date!))[0];
      const date = relevant?.date ?? null;
      const audio: HealthAudio = { retainedEditionCount: audioEditions.length, confirmedEditionCount: confirmed.length,
        state: released.length ? 'released' : scheduled.length ? 'scheduled' : confirmed.length ? 'undated' : audioEditions.length ? 'unverified' : 'none', releaseDate: date };
      const audioLink = relevant?.audio.document.url ?? confirmed[0]?.document.url ?? null;
      const audioTime = relevant?.audio.observedAt ?? confirmed[0]?.observedAt ?? null;
      const hasClaimedDate = audioEditions.some(edition => !!validReleaseDate(edition.release_date, now)) || dated.some(row => !!row.date);
      const datedStatus: HealthStatus = date ? 'present' : staleSchedule ? 'stale' : hasClaimedDate && !confirmed.length ? 'unknown' : 'missing';
      const dueAt = audio.state === 'scheduled' && relevant ? new Date(Math.min(Date.parse(`${date}T00:00:00Z`),
        ...confirmed.map(row => Date.parse(addDays(row.observedAt, AUDIO_COVERAGE_FRESHNESS_DAYS.ongoing))))).toISOString() : null;
      const retainedNarrator = audioEditions.some(edition => !!recordingNarrator(edition.narrator));
      const narrator = confirmed.some(row => !!recordingNarrator(row.product.narrators?.map(n => n.name).join(', ')));
      const retainedRuntime = audioEditions.some(edition => !!recordingRuntime(edition.runtime_minutes));
      const runtime = confirmed.some(row => !!recordingRuntime(row.product.runtime_length_min));
      // An alternate verified audio cover may be cached even when the publisher's
      // canonical image is not. Never borrow a cover from an unverified recording.
      const coverUrls = [...new Set([work.cover_url, ...confirmed.flatMap(row => Object.values(row.product.product_images ?? {}))].filter((url): url is string => typeof url === 'string' && !!url && !!publicUrl(url)))];
      const candidates = coverUrls.map(coverFor);
      const coverData = candidates.find(row => row.cover.observationCurrent) ?? candidates.find(row => row.cover.cached) ?? candidates[0] ?? coverFor(null);
      const readerData = readerFor(work), metadataChecks = metadata('work', work.id, extractionInput(work), [work.source_url], work.description, work.metadata_json);
      const sourceUrls = [work.source_url, ...confirmed.map(row => row.document.url), ...all.filter(row => !row.legacy_book_id).map(row => row.source_url)];
      for (const edition of all) { const id = json(edition.identifiers_json)?.verifiedDocument; if (typeof id === 'string') { const doc = document(id); if (doc) sourceUrls.push(doc.url); } }
      const sources = mergeSources([...new Set(sourceUrls)].map(source));
      const sourceDescription = work.source_description.trim(), hasDescription = !!sourceDescription;
      const sufficientDescription = sourceDescription.length >= SOURCE_DESCRIPTION_CHARS && !!publicUrl(work.source_url);
      const assessment = json(work.assessment_json);
      const validAssessment = !!assessment && typeof assessment.inputHash === 'string' && typeof assessment.model === 'string'
        && ['explicit', 'harem', 'quality'].every(key => {
          const field = object(assessment[key]); return field && ['present', 'absent', 'unknown'].includes(String(field.verdict))
            && typeof field.confidence === 'number' && field.confidence >= 0 && field.confidence <= 1;
        }) && !!object(assessment.genre) && ['litrpg', 'progression', 'adjacent', 'unrelated', 'unknown'].includes(String(object(assessment.genre)?.value))
        && typeof object(assessment.genre)?.confidence === 'number' && (object(assessment.genre)!.confidence as number) >= 0 && (object(assessment.genre)!.confidence as number) <= 1
        && Object.keys(tasteLabels).every(key => {
          const field = object(object(assessment.taste)?.[key]); return field && typeof field.value === 'number' && field.value >= 0 && field.value <= 1
            && typeof field.confidence === 'number' && field.confidence >= 0 && field.confidence <= 1;
        });
      const series = seriesRows.find(row => row.id === work.series_id)!;
      const hashSeed = seed ?? { id: series.id, title: series.title, author: series.author, aliases: [], authorAliases: [], genres: [], sources: [], priority: series.priority };
      const currentAssessment = validAssessment && assessment!.inputHash === assessmentHash(profileInput(work, hashSeed))
        && typeof assessment!.evaluatedAt === 'string' && !!instant(assessment!.evaluatedAt) && assessment!.evaluatedAt <= generatedAt;
      const checks = [
        check('source-description', 'Source description', sufficientDescription ? 'present' : hasDescription ? 'unknown' : 'missing', hasDescription,
          sufficientDescription ? `At least ${SOURCE_DESCRIPTION_CHARS} characters of attributable description are retained privately. Length alone does not establish factual or literary quality.`
            : hasDescription ? `The description is below ${SOURCE_DESCRIPTION_CHARS} characters or lacks a public source citation; gather stronger evidence before enrichment.` : 'No source description is retained for this work.', work.source_url, source(work.source_url)?.checkedAt ?? null),
        ...metadataChecks,
        check('jev-assessment', 'Jev metadata assessment', currentAssessment ? 'present' : validAssessment ? 'stale' : work.assessment_json ? 'unknown' : 'missing', validAssessment,
          currentAssessment ? 'A structured assessment matches the current metadata, model, and rubric. This is a retained inference, not an editorial review or a rating of the book.'
            : validAssessment ? 'The retained Jev assessment no longer matches current metadata or settings.' : work.assessment_json ? 'The retained Jev assessment could not be validated.' : 'No structured Jev metadata assessment is retained.', work.source_url, typeof assessment?.evaluatedAt === 'string' ? assessment.evaluatedAt : null),
        check('audio-edition', 'Audio edition record', audioEditions.length ? 'present' : 'missing', audioEditions.length > 0,
          `${audioEditions.length} audio edition records are retained. This records discovery, not confirmed availability; no row does not prove that audio is unavailable.`),
        check('audio-verified', 'Verified full audiobook', confirmed.length ? 'present' : 'unknown', confirmed.length > 0,
          confirmed.length ? `${confirmed.length} current exact US product documents pass the canonical title, complete author credits, selected series/volume, English, full-audio, and retained work-binding checks.`
            : 'No current exact product proof establishes a full audiobook for this work. Buy links, prior copied metadata, generic publisher pages, and dramatizations do not pass this gate.', audioLink, audioTime),
        check('audio-date', 'Confirmed audio date', datedStatus, !!date || hasClaimedDate,
          date ? `A verified audio-specific date establishes ${audio.state === 'released' ? 'an observed released recording' : 'a current preorder schedule'}. Print and ebook dates are excluded.`
            : staleSchedule ? 'A retained preorder has aged past its recheck window or reached release day without confirmation. Refresh the exact audio product; the clock alone cannot prove release.'
              : hasClaimedDate && !confirmed.length ? 'A date is copied on a retained audio row, but its current recording identity is not verified.' : 'No resolved audio-specific date is established. Print and ebook dates cannot fill this gap.', audioLink, audioTime, dueAt),
        check('narrator', 'Recording narrator', narrator ? 'present' : retainedNarrator ? 'unknown' : 'missing', narrator || retainedNarrator,
          narrator ? 'A named narrator is present in a verified recording product.' : retainedNarrator ? 'Narrator credits are retained, but not confirmed by the current exact recording evidence.' : 'No named recording narrator is established; placeholders are excluded.', audioLink, audioTime),
        check('runtime', 'Recording duration', runtime ? 'present' : retainedRuntime ? 'unknown' : 'missing', runtime || retainedRuntime,
          runtime ? 'A positive whole-minute duration is present in a verified recording product.' : retainedRuntime ? 'A duration is retained, but not confirmed by the current exact recording evidence.' : 'No valid recording duration is established.', audioLink, audioTime),
        ...coverData.checks, ...readerData.checks, sourceCheck(sources)
      ];
      const present = (id: string) => checks.find(item => item.id === id)?.status === 'present';
      return { id: work.id, seriesId: work.series_id, number: Number.isFinite(work.number) ? work.number : null,
        title: work.title, author: work.author, formats: [...new Set(all.map(row => row.format))].sort(), publicationStatus: work.publication_status,
        completeness: score(checks, quantityChecks, false), evidenceQuality: score(checks, evidenceChecks, true), checks, issues: issuesFor(checks),
        flags: { sourceDescription: present('source-description'), summary: present('original-summary'), metadataExtracted: present('extracted-metadata'),
          metadataReviewed: present('reviewed-metadata'), audiobook: audioEditions.length > 0, audioVerified: confirmed.length > 0, audioDateVerified: !!date,
          coverAsset: coverData.cover.cached, coverReviewed: coverData.cover.observationCurrent, readerSample: readerData.reader.selectedCount > 0, readerAdequate: readerData.reader.eligible },
        audio, reader: readerData.reader, cover: coverData.cover, sources };
    });

    const series: SeriesHealth[] = seriesRows.map(row => {
      const selected = works.filter(work => work.seriesId === row.id), canonical = bySeries.get(row.id) ?? [], seed = seedFor(row.id);
      const specs = manifests.filter(spec => spec.seriesId === row.id);
      const coverage = seed ? catalogAudioCoverage(db, seed, generatedAt, specs.length === 1 ? specs : []) : null;
      const observedBibliography = !!coverage?.verifiedAt;
      const bibliographyStale = !!coverage?.issues.some(issue => ['expired-evidence', 'unlisted-work'].includes(issue.code));
      const bibliography: HealthBibliography = {
        status: !observedBibliography ? 'unknown' : bibliographyStale ? 'stale' : 'present',
        audioCoverageStatus: coverage?.status ?? 'unknown',
        expectedNumbers: observedBibliography ? coverage!.expectedNumbers : [],
        missingWorkNumbers: observedBibliography ? coverage!.expectedNumbers.filter(number => !canonical.some(work => work.number === number)) : [],
        reviewedAt: observedBibliography ? instant(specs[0]?.reviewedAt) : null,
        validUntil: observedBibliography ? coverage!.validUntil : null,
        sourceUrls: links(coverage?.sourceUrls ?? []),
        explanation: !observedBibliography ? 'No current retained, reviewed primary bibliography establishes the expected list. A contiguous discovered list cannot rule out an unseen later volume.'
          : bibliographyStale ? 'The retained reviewed bibliography is due for refresh or omits a now-known work. Its historical enumeration does not establish current coverage.'
            : `A reviewed primary bibliography enumerates ${coverage!.expectedNumbers.length} mainline works in the selected audio scope. Audio coverage is ${coverage!.status}; this is not a claim that an ongoing story is complete.`
      };
      const numbers = canonical.map(work => work.number), observedGaps: number[] = [];
      const highest = Math.min(200, Math.floor(Math.max(0, ...numbers)));
      for (let number = 1; number <= highest; number++) if (!numbers.includes(number)) observedGaps.push(number);
      const missingVolumes: HealthVolumeGap[] = [...new Set([...bibliography.missingWorkNumbers, ...observedGaps])].sort((a, b) => a - b).map(number => {
        const proven = bibliography.missingWorkNumbers.includes(number);
        return { number, evidence: proven ? 'reviewed-bibliography' : 'observed-numbering',
          status: proven ? bibliography.status === 'present' ? 'missing' : 'stale' : 'unknown',
          explanation: proven ? `The retained reviewed bibliography identifies volume ${number}, but no canonical work occupies that slot.`
            : `Volume ${number} is absent between observed numbers. Confirm the source's numbering before treating it as a missing book.`,
          sourceUrls: proven ? bibliography.sourceUrls : [] };
      });
      const claimUrls = db.prepare(`SELECT DISTINCT d.url FROM catalog_claims c JOIN catalog_documents d ON d.id=c.document_id
        WHERE c.entity_type='series' AND c.entity_id=?`).all(row.id) as { url: string }[];
      const sources = mergeSources([...selected.flatMap(work => work.sources), ...(seed?.sources ?? []).map(item => source(item.url)),
        ...claimUrls.map(item => source(item.url)), ...bibliography.sourceUrls.map(source)]);
      const aggregateIssues: HealthIssue[] = [];
      const ids = [...new Set(works.flatMap(work => work.checks.map(item => item.id)))];
      const aggregate = ids.map(id => {
        const children = selected.flatMap(work => work.checks.filter(item => item.id === id));
        const counts = { present: 0, missing: 0, unknown: 0, stale: 0 };
        for (const child of children) counts[child.status]++;
        const status: HealthStatus = !children.length ? 'missing' : counts.missing ? 'missing' : counts.unknown ? 'unknown' : counts.stale ? 'stale' : 'present';
        const label = children[0]?.label ?? works.flatMap(work => work.checks).find(item => item.id === id)?.label ?? id;
        for (const problem of ['missing', 'unknown', 'stale'] as const) if (counts[problem]) aggregateIssues.push({ code: `${id}:${problem}`, status: problem, message: `${label}: ${counts[problem]}/${selected.length} works are ${problem}.` });
        return check(id, label, status, children.some(item => item.available),
          `${counts.present}/${selected.length} works are present/current; ${counts.missing} missing, ${counts.unknown} unknown, ${counts.stale} stale. Every canonical work is included, regardless of audio status.`);
      });
      const context = seriesExtractionContext(db, row.id);
      const seriesMetadata = metadata('series', row.id, context?.input ?? null, context?.sourceUrls ?? [], row.description, row.metadata_json)
        .map(item => ({ ...item, id: item.id === 'original-summary' ? 'series-summary' : `series-${item.id}`, label: `Series ${item.label.toLowerCase()}` }));
      const bibliographyCheck = check('bibliography', 'Reviewed bibliography', bibliography.status, observedBibliography, bibliography.explanation,
        bibliography.sourceUrls[0], coverage?.verifiedAt ?? null, bibliography.validUntil);
      const sourceSummary = sourceCheck(sources);
      const checks = [...aggregate.filter(item => item.id !== 'source-freshness'), sourceSummary, ...seriesMetadata, bibliographyCheck];
      const rollup = (quality: boolean): HealthScore => {
        const extra = score([...seriesMetadata, bibliographyCheck], quality ? ['series-reviewed-metadata', 'bibliography'] : ['series-summary', 'series-extracted-metadata', 'bibliography'], quality);
        const earned = selected.reduce((sum, work) => sum + (quality ? work.evidenceQuality.earned : work.completeness.earned), extra.earned);
        const possible = selected.reduce((sum, work) => sum + (quality ? work.evidenceQuality.possible : work.completeness.possible), extra.possible);
        return { percent: Math.round(100 * earned / possible), earned, possible,
          explanation: `${earned}/${possible} equally weighted checks across all ${selected.length} canonical works plus series metadata and bibliography. This measures retained catalog ${quality ? 'evidence and review' : 'data'}, not the quality of the story or completeness of its unknown tail.` };
      };
      const issues = [...aggregateIssues, ...issuesFor([sourceSummary, ...seriesMetadata, bibliographyCheck]),
        ...missingVolumes.map(gap => ({ code: `volume-${gap.number}`, status: gap.status, message: gap.explanation })),
        ...(coverage?.issues ?? []).filter(issue => !['expired-evidence', 'missing-manifest', 'missing-work'].includes(issue.code)).map(issue => ({
          code: `audio-coverage:${issue.code}${issue.number === undefined ? '' : `:${issue.number}`}`,
          status: (['expired-audio-schedule', 'release-not-reconfirmed'].includes(issue.code) ? 'stale' : 'unknown') as HealthIssue['status'], message: issue.message }))];
      return { id: row.id, title: row.title, author: row.author, workIds: selected.map(work => work.id), knownWorks: selected.length,
        confirmedAudioWorks: selected.filter(work => work.flags.audioVerified).length, completeness: rollup(false), evidenceQuality: rollup(true),
        checks, issues, missingVolumes, bibliography, sources };
    });
    const average = (field: 'completeness' | 'evidenceQuality') => works.length ? Math.round(works.reduce((sum, work) => sum + work[field].percent, 0) / works.length) : 0;
    return { schemaVersion: 1, generatedAt,
      definitions: {
        completeness: `Data presence, not bibliography completeness: equal weight for ${quantityChecks.join(', ')}. Stale or unverified retained values can earn presence credit; corrupt unusable values cannot.`,
        evidenceQuality: `Current evidence/review checks, never a rating of a book: equal weight for ${evidenceChecks.join(', ')}. Only present/current checks earn credit. No model confidence is converted into a quality score.`,
        readerAdequacy: 'The existing selected-sample threshold is a gate for aggregation, not consensus or representativeness. Comments do not establish listening format. Counts exclude removed entries, short bodies, duplicate voices/text, flagged spoilers, and explicit spoiler markup, then apply the existing cap.',
        audio: 'Confirmed audio uses the common canonical exact-product verifier for a selected English US full audiobook. Dates come only from current verified product bodies. Observed released history is durable; preorders require rechecks within seven days and at release. Missing proof does not mean no audiobook exists.',
        cover: 'A cover asset requires actual hash-checked JPEG/PNG/WebP bytes and an image header for a current canonical or verified recording URL. A URL, an observation without its asset, or an old different image cannot establish an asset. Cover freshness is checked after 30 days.',
        bibliography: 'Only a reviewed enumeration backed by current retained primary documents establishes expected mainline numbers. Gaps between observed numbers are investigation leads. A contiguous list or a 100% data score cannot prove that the final volume is known.'
      },
      thresholds: { sourceDescriptionChars: SOURCE_DESCRIPTION_CHARS, readerVoices: readerThresholds.voices,
        readerBodyChars: readerThresholds.bodyChars, readerCap: readerThresholds.maxComments, coverFreshnessDays: COVER_FRESHNESS_DAYS },
      totals: { series: series.length, works: works.length, confirmedAudioWorks: works.filter(work => work.flags.audioVerified).length,
        verifiedAudioDates: works.filter(work => work.flags.audioDateVerified).length, coverAssets: works.filter(work => work.flags.coverAsset).length,
        reviewedMetadata: works.filter(work => work.flags.metadataReviewed).length, adequateReaderSamples: works.filter(work => work.flags.readerAdequate).length,
        meanCompleteness: average('completeness'), meanEvidenceQuality: average('evidenceQuality') }, series, works };
  })();
}
