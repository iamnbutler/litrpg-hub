import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { validReleaseDate } from '../../../src/lib/catalog.js';
import { assessmentHash } from '../jev/assessment.js';
import { audioProductUrl, audioWorkIdentity, verifyCanonicalAudioProduct } from './audio.js';
import { extractionHash, extractionInput, profileInput, seriesExtractionInput } from './inference.js';
import type { Document, SeedSeries, WorkRow } from './types.js';

// Load the reviewed identities without importing the pipeline's mutation/dispatch graph.
const configuredSeeds=JSON.parse(readFileSync(new URL('../config/catalog-seeds.json',import.meta.url),'utf8')) as SeedSeries[];

type CacheState = 'current' | 'stale' | 'missing' | 'invalid';
type JobState = 'pending' | 'running' | 'retry' | 'review' | 'failed' | 'completed';
type JobCounts = Record<JobState, number>;
interface SeriesRow { id: string; title: string; author: string; description: string; metadata_json: string | null; status: string; priority: number }
interface EditionRow { id: string; work_id: string; legacy_book_id: string | null; format: string; source_url: string; release_date: string | null; identifiers_json: string }
interface JobRow { kind: string; entity_id: string; payload_json: string; status: JobState }
interface DocumentRow { id: string; url: string; fetched_at: string }
interface UrlRow { url: string; document_id: string; checked_at: string; next_check_at: string }
interface WorkReference { id: string; number: number; title: string }
export interface AuditGap { code: string; message: string; works?: WorkReference[]; numbers?: number[]; urls?: (string | null)[] }
export interface SourceAudit {
  url: string | null;
  lastFetchedAt: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  state: 'current' | 'due' | 'never-checked' | 'schedule-unknown';
}

const jobStates: JobState[] = ['pending', 'running', 'retry', 'review', 'failed', 'completed'];
const emptyJobs = (): JobCounts => ({ pending: 0, running: 0, retry: 0, review: 0, failed: 0, completed: 0 });
const parseObject = (value: string | null): Record<string, unknown> | null => {
  try { const parsed: unknown = JSON.parse(value ?? 'null'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; }
  catch { return null; }
};
const timestamp = (value: string | null | undefined): string | null => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
/** Operational links never carry authentication, query parameters, or fragments into a report. */
const reportUrl = (value: string): string | null => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? `${url.origin}${url.pathname}` : null; }
  catch { return null; }
};
/** Only response field selection is interchangeable. Storefronts, other marketplaces,
 * arbitrary query parameters, and publisher pagination remain distinct sources. */
const audioSourceIdentity = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://api.audible.com' || url.username || url.password
      || !/^\/1\.0\/catalog\/products\/[A-Z0-9]{10}$/.test(url.pathname)
      || [...url.searchParams.keys()].some(key => key !== 'response_groups')) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
};
const workReference = (work: WorkRow): WorkReference => ({ id: work.id, number: work.number, title: work.title });
const cacheState = (json: string | null, expected: string | null, hasValue = true): CacheState => {
  if (!json && !hasValue) return 'missing';
  if (!json) return hasValue ? 'invalid' : 'missing';
  const cached = parseObject(json);
  if (!cached || typeof cached.inputHash !== 'string') return 'invalid';
  if (!hasValue) return 'invalid';
  return expected && cached.inputHash === expected ? 'current' : 'stale';
};
const summarizeJobs = (jobs: JobRow[]) => {
  const counts = emptyJobs(), byKind = new Map<string, JobCounts>();
  for (const job of jobs) {
    if (!jobStates.includes(job.status)) continue;
    counts[job.status]++;
    const group = byKind.get(job.kind) ?? emptyJobs();
    group[job.status]++;
    byKind.set(job.kind, group);
  }
  return { ...counts, outstanding: counts.pending + counts.running + counts.retry,
    audioVerification: Object.fromEntries(jobStates.map(state => [state,
      (byKind.get('audio-edition')?.[state] ?? 0) + (byKind.get('identified-audio')?.[state] ?? 0)])) as JobCounts,
    byKind: [...byKind].sort(([a], [b]) => a.localeCompare(b)).map(([kind, states]) => ({ kind, ...states })) };
};

/** Read-only, offline coverage of retained evidence. A contiguous list is never proof of completeness. */
export function auditCatalog(db: Database.Database, now = new Date(), registry:readonly SeedSeries[]=configuredSeeds) {
  const generatedAt = now.toISOString(), today = generatedAt.slice(0, 10);
  return db.transaction(() => {
    const series = db.prepare('SELECT id,title,author,description,metadata_json,status,priority FROM catalog_series ORDER BY priority DESC,id').all() as SeriesRow[];
    const works = db.prepare('SELECT * FROM catalog_works ORDER BY series_id,number,id').all() as WorkRow[];
    const editions = db.prepare('SELECT id,work_id,legacy_book_id,format,source_url,release_date,identifiers_json FROM catalog_editions').all() as EditionRow[];
    const documents = db.prepare('SELECT id,url,fetched_at FROM catalog_documents').all() as DocumentRow[];
    const checkRows = db.prepare('SELECT url,document_id,checked_at,next_check_at FROM catalog_urls ORDER BY url').all() as UrlRow[];
    const checks = new Map(checkRows.map(row => [row.url, row]));
    const jobs = db.prepare('SELECT kind,entity_id,payload_json,status FROM catalog_jobs').all() as JobRow[];
    const seriesIds = new Set(series.map(row => row.id)), workById = new Map(works.map(work => [work.id, work]));
    const documentById = new Map(documents.map(doc => [doc.id, doc]));
    const audioChecks = new Map<string, { check: UrlRow; document: DocumentRow; checkedAt: string; nextCheckAt: string | null }>();
    for (const check of checkRows) {
      const identity = audioSourceIdentity(check.url), document = documentById.get(check.document_id);
      const checkedAt = timestamp(check.checked_at), nextCheckAt = timestamp(check.next_check_at);
      // A retained research note alone is not a network check. A URL head must point
      // to a retained document for this same exact US product, not another ASIN.
      if (!identity || !document || audioSourceIdentity(document.url) !== identity || !checkedAt) continue;
      const previous = audioChecks.get(identity);
      // Use the newest observation's schedule, never the most distant expiry from
      // any historical request. Equal-time requests keep the more cautious schedule.
      if (!previous || Date.parse(checkedAt) > Date.parse(previous.checkedAt)
        || Date.parse(checkedAt) === Date.parse(previous.checkedAt)
          && (nextCheckAt ? Date.parse(nextCheckAt) : -Infinity) < (previous.nextCheckAt ? Date.parse(previous.nextCheckAt) : -Infinity)) {
        audioChecks.set(identity, { check, document, checkedAt, nextCheckAt });
      }
    }
    const fetched = new Map<string, string>();
    for (const doc of documents) {
      const date = timestamp(doc.fetched_at);
      if (date && date > (fetched.get(doc.url) ?? '')) fetched.set(doc.url, date);
    }
    const editionsByWork = new Map<string, EditionRow[]>();
    for (const edition of editions) (editionsByWork.get(edition.work_id) ?? editionsByWork.set(edition.work_id, []).get(edition.work_id)!).push(edition);
    const jobsBySeries = new Map<string, JobRow[]>(), sourceUrls = new Map<string, Set<string>>();
    const addSource = (seriesId: string, url: unknown) => {
      if (typeof url !== 'string' || !url || !seriesIds.has(seriesId)) return;
      (sourceUrls.get(seriesId) ?? sourceUrls.set(seriesId, new Set()).get(seriesId)!).add(url);
    };
    const unscoped: JobRow[] = [];
    for (const job of jobs) {
      const payload = parseObject(job.payload_json);
      const seriesId = typeof payload?.seriesId === 'string' && seriesIds.has(payload.seriesId) ? payload.seriesId
        : typeof payload?.workId === 'string' ? workById.get(payload.workId)?.series_id
        : workById.get(job.entity_id)?.series_id ?? (seriesIds.has(job.entity_id) ? job.entity_id : undefined);
      if (!seriesId) { unscoped.push(job); continue; }
      (jobsBySeries.get(seriesId) ?? jobsBySeries.set(seriesId, []).get(seriesId)!).push(job);
      if (job.kind === 'source') addSource(seriesId, payload?.url ?? job.entity_id);
      addSource(seriesId, payload?.sourceUrl);
      if (['audio-edition', 'identified-audio'].includes(job.kind) && typeof payload?.asin === 'string' && /^[A-Z0-9]{10}$/.test(payload.asin)) addSource(seriesId, audioProductUrl(payload.asin));
    }
    // Claims retain bibliography URLs even when their latest adapter run has not promoted a work.
    const claims = db.prepare(`SELECT DISTINCT c.entity_type,c.entity_id,d.url FROM catalog_claims c JOIN catalog_documents d ON d.id=c.document_id WHERE c.entity_type IN ('series','work')`).all() as { entity_type: string; entity_id: string; url: string }[];
    for (const claim of claims) {
      const id = claim.entity_type === 'series' ? claim.entity_id : workById.get(claim.entity_id)?.series_id;
      if (id) addSource(id, claim.url);
    }
    const confirmedAudio = (edition: EditionRow, work:WorkRow, seed:SeedSeries|undefined): boolean => {
      // A source-only edition, including a real fetched page, needs an explicit
      // publisher-proof rule before it can establish confirmation. Research notes
      // and document presence cannot stand in for verified recording identity.
      if (!seed || edition.format!=='audiobook' || !edition.legacy_book_id) return false;
      const identifiers=parseObject(edition.identifiers_json);
      if(identifiers?.asin!==edition.legacy_book_id||identifiers.marketplace!=='US'
        ||typeof identifiers.verifiedDocument!=='string'||identifiers.workIdentityHash!==audioWorkIdentity(work))return false;
      try{
        const base=`https://api.audible.com/1.0/catalog/products/${edition.legacy_book_id}`;
        const recorded=db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(identifiers.verifiedDocument) as Document|undefined;
        if(!recorded||audioSourceIdentity(recorded.url)!==base)return false;
        // Historical proof does not override a newer retained response at another
        // response_groups URL. The common verifier also checks the exact raw body.
        const current=db.prepare(`SELECT d.* FROM catalog_urls u JOIN catalog_documents d ON d.id=u.document_id
          WHERE u.url=? OR u.url LIKE ? ORDER BY u.checked_at DESC,d.fetched_at DESC,d.id LIMIT 1`).get(base,`${base}?%`) as Document|undefined;
        const doc=current??recorded;
        if(audioSourceIdentity(doc.url)!==base)return false;
        verifyCanonicalAudioProduct(db,JSON.parse(doc.body),edition.legacy_book_id,seed,work,doc);
        return true;
      }catch{return false;}
    };
    for (const work of works) addSource(work.series_id, work.source_url);
    for (const edition of editions) {
      const work = workById.get(edition.work_id); if (!work) continue;
      if (!edition.legacy_book_id) addSource(work.series_id, edition.source_url);
      const verified = parseObject(edition.identifiers_json)?.verifiedDocument;
      if (typeof verified === 'string') addSource(work.series_id, documentById.get(verified)?.url);
    }

    const reports = series.map(row => {
      const selected = works.filter(work => work.series_id === row.id);
      const configured=registry.filter(seed=>seed.id===row.id);
      // A DB-row fallback suffices for inference hashes, never for granting identity
      // aliases or confirming audio without a selected, unambiguous registry entry.
      const verificationSeed=configured.length===1?configured[0]:undefined;
      const seed: SeedSeries = { id: row.id, title: row.title, author: row.author, authorAliases: [], aliases: [], genres: [], sources: [], priority: row.priority };
      const details = selected.map(work => {
        const all = editionsByWork.get(work.id) ?? [], audio = all.filter(edition => ['audiobook', 'dramatized'].includes(edition.format));
        const dates = audio.map(edition => validReleaseDate(edition.release_date, now)).filter((date): date is string => !!date).sort();
        return { work, audio, confirmed: audio.some(edition=>confirmedAudio(edition,work,verificationSeed)), formats: new Set(all.map(edition => edition.format)),
          audioState: !audio.length ? 'none' : !dates.length ? 'undated' : dates[0] <= today ? 'released' : 'upcoming',
          sourceState: !work.source_description.trim() ? 'missing' : work.source_description.trim().length < 100 ? 'thin' : 'sufficient',
          summary: cacheState(work.metadata_json, extractionHash(extractionInput(work)), !!work.description.trim()),
          jev: cacheState(work.assessment_json, assessmentHash(profileInput(work, seed)), !!work.assessment_json) };
      });
      const count = (predicate: (detail: typeof details[number]) => boolean) => details.filter(predicate).length;
      const summaryCounts = (key: 'summary' | 'jev') => Object.fromEntries((['current', 'stale', 'missing', 'invalid'] as const).map(state => [state, count(detail => detail[key] === state)])) as Record<CacheState, number>;
      const counts = {
        canonicalWorks: selected.length, audiobookWorks: count(detail => !!detail.audio.length),
        confirmedAudiobookWorks: count(detail => detail.confirmed), unverifiedAudioWorks: count(detail => !!detail.audio.length && !detail.confirmed),
        unverifiedLegacyAudioWorks: count(detail => !detail.confirmed && detail.audio.some(edition => !!edition.legacy_book_id)),
        withoutAudioWorks: count(detail => !detail.audio.length),
        ebookOnlyWorks: count(detail => !detail.audio.length && detail.formats.has('ebook')),
        printOnlyWorks: count(detail => !detail.audio.length && !detail.formats.has('ebook') && detail.formats.has('print')),
        releasedAudioWorks: count(detail => detail.audioState === 'released'), upcomingAudioWorks: count(detail => detail.audioState === 'upcoming'), undatedAudioWorks: count(detail => detail.audioState === 'undated'),
        sourceDescriptions: { sufficient: count(detail => detail.sourceState === 'sufficient'), thin: count(detail => detail.sourceState === 'thin'), missing: count(detail => detail.sourceState === 'missing') },
        originalSummaries: summaryCounts('summary'), jev: summaryCounts('jev'),
        fullCurrentCacheWorks: count(detail => detail.sourceState === 'sufficient' && detail.summary === 'current' && detail.jev === 'current')
      };
      const numbers = selected.map(work => work.number).filter(number => Number.isFinite(number) && number > 0 && number <= 200);
      const highestObservedVolume = numbers.length ? Math.max(...numbers) : null;
      const knownNumbers = new Set(numbers);
      const missingIntegerVolumes = Array.from({ length: Math.floor(highestObservedVolume ?? 0) }, (_, i) => i + 1).filter(number => !knownNumbers.has(number));
      const identities = new Set([...(sourceUrls.get(row.id) ?? [])].map(url => audioSourceIdentity(url) ?? url));
      const sources: SourceAudit[] = [...identities].sort().map(url => {
        const identity = audioSourceIdentity(url), audioCheck = identity ? audioChecks.get(identity) : undefined;
        const check = identity ? audioCheck?.check : checks.get(url);
        const lastCheckedAt = timestamp(check?.checked_at), nextCheckAt = timestamp(check?.next_check_at);
        return { url: reportUrl(url), lastFetchedAt: audioCheck ? timestamp(audioCheck.document.fetched_at) : fetched.get(url) ?? null, lastCheckedAt, nextCheckAt,
          state: !lastCheckedAt ? 'never-checked' : !nextCheckAt ? 'schedule-unknown' : nextCheckAt <= generatedAt ? 'due' : 'current' };
      });
      const gaps: AuditGap[] = [];
      if (!selected.length) gaps.push({ code: 'no-canonical-works', message: 'Import an identified bibliography and individual works for this selected series.' });
      if (missingIntegerVolumes.length) gaps.push({ code: 'missing-volume-numbers', message: 'Establish the missing volume identities and their audio availability; never manufacture records from numbering alone.', numbers: missingIntegerVolumes });
      const addWorkGap = (code: string, message: string, predicate: (detail: typeof details[number]) => boolean) => {
        const matches = details.filter(predicate).map(detail => workReference(detail.work));
        if (matches.length) gaps.push({ code, message, works: matches });
      };
      addWorkGap('audio-not-confirmed', 'Verify an observed exact audiobook product against its current work and selected series identity. Source-only records remain unverified; lack of evidence here does not establish that no audiobook exists.', detail => !detail.confirmed);
      addWorkGap('audio-date-missing', 'Confirm an audio-specific release date; print and ebook dates cannot fill this gap.', detail => detail.audioState === 'undated');
      addWorkGap('source-description-missing', 'Find attributable descriptive evidence for these individual works.', detail => detail.sourceState === 'missing');
      addWorkGap('source-description-thin', 'Find a fuller individual-book description before further extraction.', detail => detail.sourceState === 'thin');
      for (const [key, label] of [['summary', 'original summary'], ['jev', 'Jev assessment']] as const) {
        for (const state of ['missing', 'stale', 'invalid'] as const) addWorkGap(`${key}-${state}`, `The ${label} is ${state}; inspect retained evidence and cached responses before planning another model call.`, detail => detail[key] === state);
      }
      for (const state of ['never-checked', 'due', 'schedule-unknown'] as const) {
        const matches = sources.filter(source => source.state === state);
        if (matches.length) gaps.push({ code: `source-${state}`, message: state === 'never-checked' ? 'These source URLs have no recorded network check; retained research notes do not count as a completed crawler check.' : state === 'due' ? 'These source checks are due for refresh.' : 'These source checks have no valid refresh schedule.', urls: matches.map(source => source.url) });
      }
      const seriesInput = seriesExtractionInput(db, row.id);
      const scopedJobs = summarizeJobs(jobsBySeries.get(row.id) ?? []);
      if (scopedJobs.review || scopedJobs.failed) gaps.push({ code: 'jobs-need-review', message: `${scopedJobs.review} job(s) require review and ${scopedJobs.failed} failed; inspect the durable queue before retrying.` });
      const checkedDates = sources.flatMap(source => source.lastCheckedAt ? [source.lastCheckedAt] : []).sort();
      const nextDates = sources.flatMap(source => source.nextCheckAt ? [source.nextCheckAt] : []).sort();
      return { id: row.id, title: row.title, author: row.author, publicationStatus: row.status,
        catalogCompleteness: 'unknown' as const,
        uncertainty: 'The retained sources establish discovered works, not a complete bibliography. A contiguous list does not rule out missing later volumes.',
        highestObservedVolume, missingIntegerVolumes, counts,
        seriesSummary: cacheState(row.metadata_json, seriesInput ? extractionHash(seriesInput) : null, !!row.description.trim()),
        sourceChecks: { total: sources.length, current: sources.filter(source => source.state === 'current').length,
          due: sources.filter(source => source.state === 'due').length, neverChecked: sources.filter(source => source.state === 'never-checked').length,
          scheduleUnknown: sources.filter(source => source.state === 'schedule-unknown').length,
          oldestCheckedAt: checkedDates[0] ?? null, lastCheckedAt: checkedDates.at(-1) ?? null, nextCheckAt: nextDates[0] ?? null },
        sources, jobs: scopedJobs, gaps };
    });
    const sum = (value: (series: typeof reports[number]) => number) => reports.reduce((total, series) => total + value(series), 0);
    return {
      generatedAt,
      definitions: {
        confirmedAudio: 'An exact retained US full-audiobook product passes the current canonical title, author, series, volume, document, and work-binding checks using a reviewed registry identity. Source-only records and matched legacy rows without that proof remain unverified.',
        audioDates: 'Released, upcoming, and undated are operational counts of dates on all retained audio editions, including unverified records. They are not reverified release-state totals; ebook and print dates are never borrowed.',
        ebookOnly: 'An ebook is retained and no audio edition is retained. This is a catalog gap, not a claim that an audiobook does not exist.',
        currentCache: 'Promoted summaries and Jev assessments must match the current source, model, and rubric input hash. No inference is performed by this audit.'
      },
      totals: { series: reports.length, canonicalWorks: sum(series => series.counts.canonicalWorks), audiobookWorks: sum(series => series.counts.audiobookWorks),
        confirmedAudiobookWorks: sum(series => series.counts.confirmedAudiobookWorks), withoutAudioWorks: sum(series => series.counts.withoutAudioWorks),
        releasedAudioWorks: sum(series => series.counts.releasedAudioWorks), upcomingAudioWorks: sum(series => series.counts.upcomingAudioWorks), undatedAudioWorks: sum(series => series.counts.undatedAudioWorks),
        sufficientSourceDescriptions: sum(series => series.counts.sourceDescriptions.sufficient), currentOriginalSummaries: sum(series => series.counts.originalSummaries.current),
        currentJevAssessments: sum(series => series.counts.jev.current), fullCurrentCacheWorks: sum(series => series.counts.fullCurrentCacheWorks) },
      jobs: summarizeJobs(jobs), unscopedJobs: summarizeJobs(unscoped), series: reports
    };
  })();
}
