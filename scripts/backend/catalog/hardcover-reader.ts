/**
 * Hardcover reader-review acquisition, over the official GraphQL API.
 *
 * Bounded and identity-first by construction:
 *   - a book is resolved by EXACT title plus a verified author credit, never by site search,
 *     because Hardcover carries duplicate records for the same title under split author names;
 *   - only reviews the API marks public are requested, and the filter is sent explicitly even
 *     though this token sees nothing else, so a wider token later cannot widen the import;
 *   - sponsored reviews are excluded: a paid post is not an independent reader voice;
 *   - the reviewer is reduced to a one-way digest on the way in. No username, display name or
 *     profile is ever stored.
 *
 * The API token is read from the environment and never logged, echoed, or included in an error.
 */
import type Database from 'better-sqlite3';
import { normalizeIdentity } from '../../../src/lib/catalog.js';
import { loadSnapshot, saveSnapshot, storeReaderEvidence, voiceDigest, type AcquisitionSnapshot, type ReaderEvidence, type StoredEvidence } from './reader-evidence.js';
import { hash } from './queue.js';

export const HARDCOVER_API = 'https://api.hardcover.app/v1/graphql';
export const HARDCOVER_SOURCE = 'hardcover.app';
/** One bounded page per book per run. A pilot is not a crawl. */
export const MAX_REVIEWS = 50;
/**
 * Hardcover documents 60 requests a minute. One request a second is exactly that budget, which
 * leaves no headroom for a retry or a concurrent job, so the floor is two seconds.
 */
export const MIN_REQUEST_GAP_MS = 2000;
/** Beyond this the caller should defer the work, not sit in a sleep holding a lease. */
export const MAX_INLINE_RETRY_MS = 30_000;
/** A failure the source told us to come back from later, rather than a permanent one. */
export class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs: number) { super(message); }
}
export const QUERY_VERSION = 'hardcover-reader-v1';

export type GraphQL = (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface HardcoverTarget {
  /** The EXACT source title to look up. Never a fuzzy or partial match. */
  title: string;
  author: string;
  /** The catalog work's title when it differs from the source title, e.g. a volume suffix. */
  catalogTitle?: string;
  /** Set only once a person has verified that `title` names `catalogTitle`/`workId`. */
  aliasReviewed?: boolean;
  workId?: string | null;
  seriesId?: string | null;
}
export interface HardcoverBook { id: number; title: string; slug: string; authors: string[]; reviewsCount: number; ratingsCount: number }
export interface HardcoverReview {
  id: number; review: string | null; rating: number | null; reviewed_at: string | null;
  review_has_spoilers: boolean | null; sponsored_review: boolean | null; privacy_setting_id: number | null;
  user: { id: number | null } | null;
}

/**
 * A deliberately slow client: one request a second, and a bounded retry that honours
 * `Retry-After` on a 429 rather than hammering a service that just asked us to stop.
 */
export function hardcoverClient(request: typeof fetch = fetch, options: {
  sleep?: (ms: number) => Promise<void>; gapMs?: number;
} = {}): GraphQL {
  const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const gap = options.gapMs ?? MIN_REQUEST_GAP_MS;
  let previous = 0;
  return async (query, variables = {}) => {
    const token = process.env.HARDCOVER_API_TOKEN;
    if (!token) throw new Error('Set HARDCOVER_API_TOKEN in the ignored .env file.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const since = Date.now() - previous;
      if (since < gap) await sleep(gap - since);
      previous = Date.now();
      let response: Response;
      try {
        response = await request(HARDCOVER_API, { method: 'POST', signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }) });
      } catch {
        if (attempt === 2) throw new Error('Hardcover could not be reached; nothing was imported.');
        await sleep(gap * 2 ** attempt);
        continue;
      }
      if ([429, 500, 502, 503, 504].includes(response.status)) {
        const header = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(header) && header > 0 ? header * 1000 : gap * 2 * 2 ** attempt;
        // Honour a long Retry-After by handing the work back, rather than sleeping through it
        // or — worse — retrying before the source said we could.
        if (wait > MAX_INLINE_RETRY_MS) throw new RetryableError(`Hardcover asked for ${Math.round(wait / 1000)}s before the next request.`, wait);
        if (attempt === 2) throw new RetryableError(`Hardcover returned HTTP ${response.status} after ${attempt + 1} attempts.`, wait);
        await sleep(wait);
        continue;
      }
      // A body can echo the request, including the Authorization header on some gateways.
      if (!response.ok) throw new Error(`Hardcover returned HTTP ${response.status}.`);
      const payload = await response.json() as { data?: Record<string, unknown>; errors?: { message: string }[] };
      if (payload.errors?.length) throw new Error(`Hardcover rejected the query: ${payload.errors[0].message.slice(0, 120)}`);
      if (!payload.data) throw new Error('Hardcover returned no data.');
      return payload.data;
    }
    throw new Error('Hardcover retries exhausted; nothing was imported.');
  };
}

const credits = (book: { cached_contributors?: unknown }): string[] => {
  const raw = Array.isArray(book.cached_contributors) ? book.cached_contributors : [];
  return raw.map(entry => {
    const node = entry as { author?: { name?: string }; name?: string };
    return node?.author?.name ?? node?.name ?? '';
  }).filter(Boolean);
};
/**
 * Accept a candidate only when the title matches exactly and the requested author is actually
 * credited. Hardcover holds duplicates such as a second "Dungeon Crawler Carl" credited to
 * "Dinniman, Matt" split across two entries, and importing reviews against the wrong record
 * would attach real readers to the wrong book.
 */
export function verifyIdentity(candidates: Record<string, unknown>[], target: HardcoverTarget): HardcoverBook | null {
  const wanted = normalizeIdentity(target.author);
  const matches = candidates
    .map(raw => ({
      id: Number(raw.id), title: String(raw.title ?? ''), slug: String(raw.slug ?? ''), authors: credits(raw),
      reviewsCount: Number(raw.reviews_count ?? 0), ratingsCount: Number(raw.ratings_count ?? 0)
    }))
    .filter(book => normalizeIdentity(book.title) === normalizeIdentity(target.title) &&
      book.authors.some(name => normalizeIdentity(name) === wanted));
  // Prefer the record readers actually used; ties break deterministically.
  return matches.sort((a, b) => b.ratingsCount - a.ratingsCount || b.reviewsCount - a.reviewsCount || a.id - b.id)[0] ?? null;
}

const BOOK_QUERY = `query CatalogBook($title: String!) {
  books(where: {title: {_eq: $title}}, order_by: {users_read_count: desc}, limit: 5) {
    id title slug reviews_count ratings_count cached_contributors } }`;
const REVIEW_QUERY = `query PublicReviews($bookId: Int!, $limit: Int!) {
  user_books(where: {book_id: {_eq: $bookId}, has_review: {_eq: true}, privacy_setting_id: {_eq: 1}, sponsored_review: {_eq: false}},
    order_by: {id: asc}, limit: $limit) {
    id review rating reviewed_at review_has_spoilers sponsored_review privacy_setting_id user { id } } }`;

export async function resolveBook(client: GraphQL, target: HardcoverTarget): Promise<HardcoverBook | null> {
  const data = await client(BOOK_QUERY, { title: target.title });
  return verifyIdentity((data.books as Record<string, unknown>[]) ?? [], target);
}
export async function fetchPublicReviews(client: GraphQL, bookId: number, limit = MAX_REVIEWS): Promise<HardcoverReview[]> {
  const bounded = Math.max(1, Math.min(MAX_REVIEWS, Math.trunc(limit)));
  const data = await client(REVIEW_QUERY, { bookId, limit: bounded });
  return ((data.user_books as HardcoverReview[]) ?? []);
}

export const hardcoverUrl = (slug: string) => `https://hardcover.app/books/${slug}`;
/**
 * Convert to stored evidence, dropping anything that is not a public, unsponsored, attributable
 * review. The privacy and sponsorship checks are repeated here on purpose: the query already
 * filters, and a row that slipped through either way must still never be retained.
 */
export function toEvidence(book: HardcoverBook, rows: HardcoverReview[]): ReaderEvidence[] {
  const url = hardcoverUrl(book.slug);
  return rows.flatMap(row => {
    const body = (row.review ?? '').replace(/\s+/g, ' ').trim();
    if (!body || row.privacy_setting_id !== 1 || row.sponsored_review === true || row.user?.id == null) return [];
    return [{
      // Digested, not raw: the snapshot is retained on disk, so even the review's own account
      // -scoped id is reduced to something stable enough to deduplicate and nothing more.
      externalId: hash(['hardcover-review', String(row.id)]).slice(0, 32), sourceUrl: url, sourceName: HARDCOVER_SOURCE,
      // The reviewer's account id becomes a digest here and is never stored in any other form.
      authorKey: voiceDigest(HARDCOVER_SOURCE, String(row.user.id)),
      body, rating: row.rating ?? null, ratingBest: row.rating == null ? null : 5,
      publishedAt: (row.reviewed_at ?? '').slice(0, 10) || null,
      // Hardcover carries a real spoiler flag, so it is used instead of assuming the worst.
      containsSpoilers: row.review_has_spoilers === true, kind: 'review' as const
    }];
  });
}

/**
 * Bind a target to a catalog work, verifying identity even when the caller names the work.
 *
 * An explicit `workId` is a convenience, not a licence: a wrong one silently attaches real
 * readers' opinions to the wrong book, which is worse than not linking at all. So the named
 * work must exist and must be credited to the same author, and its title must match unless a
 * person has explicitly reviewed the alias. When any of that fails the binding is REFUSED and
 * the reason is reported, rather than trusted.
 */
export function linkTarget(db: Database.Database, target: HardcoverTarget): { workId: string | null; seriesId: string | null; note?: string } {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_works'").get()) return { workId: null, seriesId: null };
  const rows = db.prepare('SELECT id, series_id, title, author FROM catalog_works').all() as { id: string; series_id: string; title: string; author: string }[];
  const wantedAuthor = normalizeIdentity(target.author);
  const wantedTitle = normalizeIdentity(target.catalogTitle ?? target.title);
  const credited = (row: { author: string }) => normalizeIdentity(row.author.split(',')[0]) === wantedAuthor;

  if (target.workId) {
    const row = rows.find(r => r.id === target.workId);
    if (!row) return { workId: null, seriesId: null, note: `Refused: no catalog work ${target.workId}.` };
    if (!credited(row)) return { workId: null, seriesId: null, note: `Refused: ${target.workId} is credited to ${row.author}, not ${target.author}.` };
    if (normalizeIdentity(row.title) !== wantedTitle && !target.aliasReviewed) {
      return { workId: null, seriesId: null, note: `Refused: ${target.workId} is "${row.title}", not "${target.catalogTitle ?? target.title}". Set aliasReviewed once a person has verified the alias.` };
    }
    return { workId: row.id, seriesId: row.series_id };
  }
  if (target.seriesId) {
    const series = rows.filter(r => r.series_id === target.seriesId);
    if (!series.length) return { workId: null, seriesId: null, note: `Refused: no catalog works in series ${target.seriesId}.` };
    if (!series.some(credited)) return { workId: null, seriesId: null, note: `Refused: series ${target.seriesId} is not credited to ${target.author}.` };
    return { workId: series.find(r => normalizeIdentity(r.title) === wantedTitle)?.id ?? null, seriesId: target.seriesId };
  }
  const found = rows.find(row => normalizeIdentity(row.title) === wantedTitle && credited(row));
  return { workId: found?.id ?? null, seriesId: found?.series_id ?? null };
}

/**
 * Keyed on the verified identity, the bounded query version and the limit — deliberately NOT on
 * the resolved book id, so a cached repeat needs no lookup request either and the whole import
 * resolves from the database at zero HTTP.
 */
export const snapshotKey = (target: HardcoverTarget, limit: number) =>
  `reader-snapshot://hardcover/${normalizeIdentity(target.title)}--${normalizeIdentity(target.author)}?v=${QUERY_VERSION}&limit=${limit}`;

export interface HardcoverImportResult { title: string; resolved: boolean; cached: boolean; bookId: number | null; url: string | null; reviewsAvailable: number | null; fetched: number; kept: number; stored: number; workId: string | null; note?: string }
export async function importHardcoverReviews(db: Database.Database, targets: HardcoverTarget[], options: {
  client?: GraphQL; limit?: number; force?: boolean; now?: Date;
} = {}): Promise<HardcoverImportResult[]> {
  const client = options.client ?? hardcoverClient();
  const bounded = Math.max(1, Math.min(MAX_REVIEWS, Math.trunc(options.limit ?? MAX_REVIEWS)));
  const results: HardcoverImportResult[] = [];
  for (const target of targets) {
    try {
    const key = snapshotKey(target, bounded);
    const held = loadSnapshot(db, key, { force: options.force, now: options.now });
    if (held) {
      // Linkage is resolved again rather than replayed: a correction made since capture should
      // apply to anything new, while rows already stored are left exactly as they are.
      const link = linkTarget(db, target);
      const stored = storeReaderEvidence(db, held.snapshot.evidence.map((item): StoredEvidence => ({
        ...item, workId: link.workId, seriesId: link.seriesId, documentId: held.documentId })));
      results.push({ title: target.title, resolved: true, cached: true, bookId: null,
        url: held.snapshot.evidence[0]?.sourceUrl ?? null, reviewsAvailable: held.snapshot.available,
        fetched: 0, kept: held.snapshot.evidence.length, stored, workId: link.workId,
        note: link.note ?? `Resolved from a snapshot captured ${held.snapshot.capturedAt.slice(0, 10)}; no request was made.` });
      continue;
    }
    const book = await resolveBook(client, target);
    if (!book) {
      results.push({ title: target.title, resolved: false, cached: false, bookId: null, url: null, reviewsAvailable: 0, fetched: 0, kept: 0, stored: 0, workId: null,
        note: 'No Hardcover record matched this exact title with that author credited.' });
      continue;
    }
    const rows = await fetchPublicReviews(client, book.id, bounded);
    const evidence = toEvidence(book, rows);
    const link = linkTarget(db, target);
    const snapshot: AcquisitionSnapshot = {
      version: QUERY_VERSION, source: HARDCOVER_SOURCE, capturedAt: (options.now ?? new Date()).toISOString(),
      workId: link.workId, seriesId: link.seriesId, available: book.reviewsCount, fetched: rows.length,
      method: 'earliest-by-review-id', evidence
    };
    const documentId = saveSnapshot(db, key, snapshot, { now: options.now });
    const stored = storeReaderEvidence(db, evidence.map((item): StoredEvidence => ({
      ...item, workId: link.workId, seriesId: link.seriesId, documentId })));
    results.push({ title: target.title, resolved: true, cached: false, bookId: book.id, url: hardcoverUrl(book.slug),
      reviewsAvailable: book.reviewsCount, fetched: rows.length, kept: evidence.length, stored, workId: link.workId,
      note: link.note ?? (link.workId ? undefined : 'Imported but not linked to a catalog work.') });
    } catch (error) {
      // One blocked target must not discard the targets that already imported cleanly, and
      // a failure is reported rather than being left to look like an empty result.
      results.push({ title: target.title, resolved: false, cached: false, bookId: null, url: null, reviewsAvailable: 0,
        fetched: 0, kept: 0, stored: 0, workId: null,
        note: error instanceof Error ? error.message : 'Hardcover import failed.' });
    }
  }
  return results;
}
