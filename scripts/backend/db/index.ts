/**
 * Database helpers for fetchers.
 * Uses the connection from ../db.ts and writes to the schema from migrations/001_initial.sql.
 */
import { getDb } from "../db.js";
import { seriesIdentity } from "../../../src/lib/catalog.js";
import { mergeBook, mergeAllSources, type SourceBlob } from "../matchers/merger.js";
import { retainSource } from "../storage/history.js";

export interface BookRow {
  id: string; // ASIN
  title: string;
  subtitle: string | null;
  author: string | null;
  narrator: string | null;
  series_name: string | null; // stored via series table
  series_number: number | null;
  release_date: string | null;
  cover_url: string | null;
  runtime_minutes: number | null;
  rating: number | null;
  rating_count: number | null;
  description: string | null;
  url: string | null;
  is_ai_narrated: boolean;
}

/**
 * Upsert a series row and return its ID.
 * Uses slugified series name as the ID.
 */
function upsertSeries(name: string, author: string | null): string {
  const db = getDb();
  const id = seriesIdentity(name, author ?? '');
  db.prepare(
    `INSERT INTO series (id, title, author)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       author = COALESCE(excluded.author, series.author)`
  ).run(id, name, author);
  return id;
}

export function upsertBook(book: BookRow): boolean {
  const db = getDb();
  const existing = db.prepare('SELECT id, author FROM books WHERE id = ?').get(book.id) as { id: string; author: string } | undefined;

  // Handle series normalization
  let seriesId: string | null = null;
  if (book.series_name) {
    seriesId = upsertSeries(book.series_name, book.author || existing?.author || null);
  }

  if (existing) {
    db.prepare(
      `UPDATE books SET
        title = COALESCE(NULLIF(NULLIF(@title, ''), 'Untitled'), title),
        subtitle = COALESCE(NULLIF(@subtitle, ''), subtitle),
        author = COALESCE(NULLIF(@author, ''), author),
        narrator = COALESCE(NULLIF(@narrator, ''), narrator),
        series_id = COALESCE(@series_id, series_id),
        series_number = COALESCE(@series_number, series_number),
        release_date = COALESCE(NULLIF(@release_date, ''), release_date),
        cover_url = COALESCE(NULLIF(@cover_url, ''), cover_url),
        runtime_minutes = COALESCE(@runtime_minutes, runtime_minutes),
        rating = COALESCE(@rating, rating), rating_count = COALESCE(@rating_count, rating_count),
        description = CASE WHEN length(COALESCE(@description, '')) >= length(COALESCE(description, ''))
          THEN COALESCE(@description, description) ELSE description END,
        url = COALESCE(NULLIF(@url, ''), url),
        is_ai_narrated = CASE WHEN NULLIF(@narrator, '') IS NULL THEN is_ai_narrated ELSE @is_ai_narrated END,
        updated_at = datetime('now')
      WHERE id = @id`
    ).run({ ...book, series_id: seriesId, is_ai_narrated: book.is_ai_narrated ? 1 : 0 });
    return false; // updated
  } else {
    db.prepare(
      `INSERT INTO books (id, title, subtitle, author, narrator, series_id,
        series_number, release_date, cover_url, runtime_minutes,
        rating, rating_count, description, url, is_ai_narrated)
      VALUES (@id, @title, @subtitle, @author, @narrator, @series_id,
        @series_number, @release_date, @cover_url, @runtime_minutes,
        @rating, @rating_count, @description, @url, @is_ai_narrated)`
    ).run({ ...book, author: book.author ?? '', release_date: book.release_date ?? '', series_id: seriesId, is_ai_narrated: book.is_ai_narrated ? 1 : 0 });
    return true; // new
  }
}

/** Repair legacy title-only grouping without changing book IDs or raw sources. */
export function repairSeriesIdentities(): number {
  const db = getDb();
  const rows = db.prepare('SELECT b.id, b.author, b.series_id, s.title FROM books b JOIN series s ON s.id=b.series_id').all() as { id: string; author: string; series_id: string; title: string }[];
  return db.transaction(() => {
    let changed = 0;
    const update = db.prepare('UPDATE books SET series_id=? WHERE id=?');
    for (const row of rows) {
      const id = upsertSeries(row.title, row.author);
      if (id !== row.series_id) { update.run(id, row.id); changed++; }
    }
    db.prepare('UPDATE series SET book_count=(SELECT COUNT(*) FROM books WHERE series_id=series.id)').run();
    return changed;
  })();
}

// ---------------------------------------------------------------------------
// Book lookup helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a full book row by ID, or undefined if not found.
 */
export function getBook(bookId: string): BookRow | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT b.id, b.title, b.subtitle, b.author, b.narrator,
              s.title AS series_name, b.series_number,
              b.release_date, b.cover_url, b.runtime_minutes,
              b.rating, b.rating_count, b.description, b.url,
              b.is_ai_narrated
       FROM books b
       LEFT JOIN series s ON s.id = b.series_id
       WHERE b.id = ?`
    )
    .get(bookId) as Record<string, unknown> | undefined;

  if (!row) return undefined;

  return {
    id: row.id as string,
    title: row.title as string,
    subtitle: (row.subtitle as string) ?? null,
    author: (row.author as string) ?? null,
    narrator: (row.narrator as string) ?? null,
    series_name: (row.series_name as string) ?? null,
    series_number: (row.series_number as number) ?? null,
    release_date: (row.release_date as string) ?? null,
    cover_url: (row.cover_url as string) ?? null,
    runtime_minutes: (row.runtime_minutes as number) ?? null,
    rating: (row.rating as number) ?? null,
    rating_count: (row.rating_count as number) ?? null,
    description: (row.description as string) ?? null,
    url: (row.url as string) ?? null,
    is_ai_narrated: Boolean(row.is_ai_narrated),
  };
}

/**
 * Get all source names that have data for a given book.
 */
export function getBookSourceNames(bookId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT source FROM book_sources WHERE book_id = ?")
    .all(bookId) as { source: string }[];
  return rows.map((r) => r.source);
}

/**
 * Get all source blobs for a given book (for re-merging).
 */
export function getBookSources(bookId: string): { source: string; raw_data: string }[] {
  const db = getDb();
  return db
    .prepare("SELECT source, raw_data FROM book_sources WHERE book_id = ?")
    .all(bookId) as { source: string; raw_data: string }[];
}

// ---------------------------------------------------------------------------
// Merge-aware upsert
// ---------------------------------------------------------------------------

export interface MergeAndUpsertResult {
  isNew: boolean;
  updatedFields: string[];
  needsReview: boolean;
}

/**
 * Merge-aware upsert: fetches the existing book (if any), runs the field
 * merge strategy to resolve conflicts, and writes the merged result back.
 *
 * Use this instead of plain upsertBook when ingesting data from a source
 * that may conflict with data from other sources.
 */
export function mergeAndUpsertBook(
  bookData: Partial<BookRow> & { id: string },
  source: string,
  matchConfidence = 1.0,
): MergeAndUpsertResult {
  const existing = getBook(bookData.id);

  if (!existing) {
    const newBook: BookRow = {
      id: bookData.id,
      title: bookData.title ?? "Untitled",
      subtitle: bookData.subtitle ?? null,
      author: bookData.author ?? null,
      narrator: bookData.narrator ?? null,
      series_name: bookData.series_name ?? null,
      series_number: bookData.series_number ?? null,
      release_date: bookData.release_date ?? null,
      cover_url: bookData.cover_url ?? null,
      runtime_minutes: bookData.runtime_minutes ?? null,
      rating: bookData.rating ?? null,
      rating_count: bookData.rating_count ?? null,
      description: bookData.description ?? null,
      url: bookData.url ?? null,
      is_ai_narrated: bookData.is_ai_narrated ?? false,
    };
    upsertBook(newBook);
    return { isNew: true, updatedFields: [], needsReview: matchConfidence < 0.9 };
  }

  const knownSources = getBookSourceNames(bookData.id);
  const result = mergeBook(
    {
      existingBook: existing,
      incomingData: bookData,
      source,
      matchConfidence,
    },
    knownSources,
  );

  if (result.updatedFields.length > 0) {
    upsertBook(result.book);
  }

  return {
    isNew: false,
    updatedFields: result.updatedFields,
    needsReview: result.needsReview,
  };
}

// ---------------------------------------------------------------------------
// Re-merge from stored sources
// ---------------------------------------------------------------------------

/**
 * Re-merge a single book from all its stored source blobs.
 * Used by the CORRECT pipeline stage to replay merges after
 * source data or priorities change.
 */
export function remergeBook(bookId: string): string[] {
  const existing = getBook(bookId);
  if (!existing) return [];

  const rawSources = getBookSources(bookId);
  if (rawSources.length === 0) return [];

  const blobs: SourceBlob[] = rawSources.map((rs) => ({
    source: rs.source,
    rawData: parseSourceBlob(rs.source, rs.raw_data),
  }));

  const base: BookRow = {
    ...existing,
    title: "Untitled",
    subtitle: null,
    author: null,
    narrator: null,
    series_name: null,
    series_number: null,
    release_date: null,
    cover_url: null,
    runtime_minutes: null,
    rating: null,
    rating_count: null,
    description: null,
    url: null,
    is_ai_narrated: false,
  };

  const result = mergeAllSources(base, blobs);

  const changed: string[] = [];
  for (const field of result.updatedFields) {
    const key = field as keyof BookRow;
    if (existing[key] !== result.book[key]) {
      changed.push(field);
    }
  }

  if (changed.length > 0) {
    upsertBook(result.book);
  }

  return changed;
}

/**
 * Get IDs of all books that have data from more than one source.
 */
export function getMultiSourceBookIds(): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT book_id FROM book_sources
       GROUP BY book_id
       HAVING COUNT(DISTINCT source) > 1`
    )
    .all() as { book_id: string }[];
  return rows.map((r) => r.book_id);
}

// ---------------------------------------------------------------------------
// Source blob parsing (raw_data JSON -> Partial<BookRow>)
// ---------------------------------------------------------------------------

function parseSourceBlob(source: string, rawJson: string): Partial<BookRow> {
  try {
    const data = JSON.parse(rawJson);
    if (source === "audible") return parseAudibleBlob(data);
    if (source === "hardcover") return parseHardcoverBlob(data);
    return data as Partial<BookRow>;
  } catch {
    return {};
  }
}

function parseAudibleBlob(data: Record<string, unknown>): Partial<BookRow> {
  const series = (data.series as { title: string; sequence?: string }[] | undefined)?.[0];
  let seriesNumber: number | null = null;
  if (series?.sequence) {
    const num = parseFloat(series.sequence);
    if (!isNaN(num)) seriesNumber = num;
  }

  const authors = data.authors as { name: string }[] | undefined;
  const narrators = data.narrators as { name: string }[] | undefined;
  const rating = data.rating as {
    overall_distribution?: { average_rating?: number; num_ratings?: number };
  } | undefined;
  const images = data.product_images as Record<string, string> | undefined;
  const summary = data.merchandising_summary as string | undefined;

  return {
    title: (data.title as string) ?? undefined,
    subtitle: (data.subtitle as string) ?? undefined,
    author: authors?.map((a) => a.name).join(", ") || undefined,
    narrator: narrators?.map((n) => n.name).join(", ") || undefined,
    series_name: series?.title ?? undefined,
    series_number: seriesNumber ?? undefined,
    release_date: (data.release_date as string) ?? undefined,
    cover_url: images?.["500"] ?? undefined,
    runtime_minutes: (data.runtime_length_min as number) ?? undefined,
    rating: rating?.overall_distribution?.average_rating ?? undefined,
    rating_count: rating?.overall_distribution?.num_ratings ?? undefined,
    description: summary ? stripHtmlSimple(summary) : undefined,
    url: data.asin ? `https://www.audible.com/pd/${data.asin}` : undefined,
  };
}

function parseHardcoverBlob(data: Record<string, unknown>): Partial<BookRow> {
  const contributions = data.contributions as { author: { name: string } }[] | undefined;
  return {
    title: (data.title as string) ?? undefined,
    author: contributions?.map((c) => c.author.name).join(", ") || undefined,
    rating: (data.rating as number) ?? undefined,
    rating_count: (data.ratings_count as number) ?? undefined,
  };
}

function stripHtmlSimple(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#xa0;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Fetch all book rows from the database.
 */
export function getAllBooks(): BookRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT b.id, b.title, b.subtitle, b.author, b.narrator,
              s.title AS series_name, b.series_number,
              b.release_date, b.cover_url, b.runtime_minutes,
              b.rating, b.rating_count, b.description, b.url,
              b.is_ai_narrated
       FROM books b
       LEFT JOIN series s ON s.id = b.series_id`
    )
    .all() as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    subtitle: (row.subtitle as string) ?? null,
    author: (row.author as string) ?? null,
    narrator: (row.narrator as string) ?? null,
    series_name: (row.series_name as string) ?? null,
    series_number: (row.series_number as number) ?? null,
    release_date: (row.release_date as string) ?? null,
    cover_url: (row.cover_url as string) ?? null,
    runtime_minutes: (row.runtime_minutes as number) ?? null,
    rating: (row.rating as number) ?? null,
    rating_count: (row.rating_count as number) ?? null,
    description: (row.description as string) ?? null,
    url: (row.url as string) ?? null,
    is_ai_narrated: Boolean(row.is_ai_narrated),
  }));
}

// ---------------------------------------------------------------------------
// Book source tracking
// ---------------------------------------------------------------------------

export function upsertBookSource(
  bookId: string,
  source: string,
  rawData: string,
  sourceId: string = bookId
): void {
  const db = getDb();
  db.transaction(() => {
    const previous = db.prepare('SELECT book_id,source,source_id,raw_data,fetched_at FROM book_sources WHERE book_id=? AND source=?').get(bookId,source) as Parameters<typeof retainSource>[1] | undefined;
    if (previous?.raw_data) retainSource(db,previous);
    const fetchedAt = new Date().toISOString();
    retainSource(db,{ book_id:bookId, source, source_id:sourceId, raw_data:rawData, fetched_at:fetchedAt });
    db.prepare(`INSERT INTO book_sources (book_id,source,source_id,raw_data,fetched_at) VALUES (?,?,?,?,?)
      ON CONFLICT(book_id,source) DO UPDATE SET source_id=excluded.source_id,raw_data=excluded.raw_data,fetched_at=excluded.fetched_at`).run(bookId,source,sourceId,rawData,fetchedAt);
  })();
}

export function setBookSubgenres(bookId: string, subgenres: string[]): void {
  const db = getDb();
  db.prepare("DELETE FROM book_subgenres WHERE book_id = ?").run(bookId);
  const insert = db.prepare(
    "INSERT INTO book_subgenres (book_id, subgenre) VALUES (?, ?)"
  );
  for (const sg of subgenres) {
    insert.run(bookId, sg);
  }
}

export function setBookSubgenresWithMeta(
  bookId: string,
  subgenres: { subgenre: string; confidence: number; source: string }[]
): void {
  const db = getDb();
  db.prepare("DELETE FROM book_subgenres WHERE book_id = ?").run(bookId);
  const insert = db.prepare(
    "INSERT INTO book_subgenres (book_id, subgenre, confidence, source) VALUES (?, ?, ?, ?)"
  );
  for (const sg of subgenres) {
    insert.run(bookId, sg.subgenre, sg.confidence, sg.source);
  }
}

export function insertFetchRun(
  source: string,
  searchKey: string,
  year: number
): number {
  const db = getDb();
  const result = db
    .prepare(
      "INSERT INTO fetch_runs (source, search_key, year) VALUES (?, ?, ?)"
    )
    .run(source, searchKey, year);
  return Number(result.lastInsertRowid);
}

export function completeFetchRun(
  runId: number,
  pagesFetched: number,
  resultsFound: number,
  status: 'completed' | 'failed' | 'partial' = 'completed'
): void {
  const db = getDb();
  db.prepare(
    `UPDATE fetch_runs SET pages_fetched = ?, results_found = ?,
     completed_at = datetime('now'), status = ? WHERE id = ?`
  ).run(pagesFetched, resultsFound, status, runId);
}

export function upsertSearchCursor(
  source: string,
  searchKey: string,
  year: number,
  isExhausted: boolean,
  resultsFound: number = 0
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO search_cursors (source, search_key, year, last_fetched_at, is_exhausted, results_found)
     VALUES (?, ?, ?, datetime('now'), ?, ?)
     ON CONFLICT(source, search_key, year) DO UPDATE SET
       last_fetched_at = datetime('now'),
       is_exhausted = excluded.is_exhausted,
       results_found = excluded.results_found`
  ).run(source, searchKey, year, isExhausted ? 1 : 0, resultsFound);
}

export interface SearchCursor {
  last_fetched_at: string;
  is_exhausted: number;
  results_found: number;
}

export function getSearchCursor(
  source: string,
  searchKey: string,
  year: number
): SearchCursor | undefined {
  const db = getDb();
  return db
    .prepare(
      "SELECT last_fetched_at, is_exhausted, results_found FROM search_cursors WHERE source = ? AND search_key = ? AND year = ?"
    )
    .get(source, searchKey, year) as SearchCursor | undefined;
}
