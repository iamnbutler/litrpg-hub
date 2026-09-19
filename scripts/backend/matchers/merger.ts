/**
 * Field merge strategy for multi-source book data.
 *
 * When the same book appears in multiple data sources (Audible, Hardcover,
 * Royal Road, manual overrides), this module resolves field-level conflicts
 * using a per-field priority map. The rules:
 *
 *   1. Manual overrides always win.
 *   2. Higher-priority source overwrites lower for each field.
 *   3. Null/undefined never overwrites a non-null value.
 *   4. Array fields (subgenres) are unioned, not replaced.
 *   5. Low-confidence matches (< 0.9) flag needsReview = true.
 *   6. Provenance is tracked in the book_sources table.
 */

import type { BookRow } from "../db/index.js";

// ---------------------------------------------------------------------------
// Source priority per field (lower index = higher priority)
// ---------------------------------------------------------------------------

type SourceName = "manual" | "audible" | "audible-series" | "hardcover" | "royalroad";

/**
 * For each book field, the ordered list of sources from highest to lowest
 * priority. A source not listed is treated as lower than any listed source.
 */
const FIELD_PRIORITY: Record<string, SourceName[]> = {
  title: ["manual", "audible", "hardcover"],
  subtitle: ["manual", "audible", "hardcover"],
  author: ["manual", "audible", "hardcover"],
  narrator: ["manual", "audible"],
  release_date: ["manual", "audible", "hardcover"],
  runtime_minutes: ["audible"],
  cover_url: ["audible", "hardcover"],
  rating: ["audible"],
  rating_count: ["audible"],
  description: ["manual", "audible-series", "audible", "hardcover"],
  url: ["audible"],
  series_name: ["manual", "audible", "hardcover"],
  series_number: ["manual", "audible", "hardcover"],
  is_ai_narrated: ["manual", "audible"],
};

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MergeOptions {
  existingBook: BookRow;
  incomingData: Partial<BookRow>;
  source: string;
  matchConfidence: number;
}

export interface MergeResult {
  updatedFields: string[];
  book: BookRow;
  needsReview: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the priority rank of `source` for `field` (0 = highest). */
function priorityOf(field: string, source: string): number {
  const list = FIELD_PRIORITY[field];
  if (!list) return Infinity;
  const idx = list.indexOf(source as SourceName);
  return idx === -1 ? list.length : idx; // unlisted sources rank after all listed ones
}

/**
 * Determine whether the incoming source should overwrite the existing
 * value for a particular field.
 *
 * Returns true if the incoming source has equal or higher priority
 * (lower rank number). Ties go to the incoming value so re-fetching
 * from the same source refreshes the data.
 */
function incomingWins(field: string, existingSource: string, incomingSource: string): boolean {
  const existingRank = priorityOf(field, existingSource);
  const incomingRank = priorityOf(field, incomingSource);
  return incomingRank <= existingRank;
}

/**
 * Among the known sources (excluding the incoming one), return the
 * highest-priority source for the given field. This is a conservative
 * estimate of which source "owns" the existing value.
 */
function bestExistingSource(field: string, incomingSource: string, knownSources: string[]): string {
  const list = FIELD_PRIORITY[field];
  if (!list) return incomingSource;

  let best: string | null = null;
  let bestRank = Infinity;
  for (const src of knownSources) {
    if (src === incomingSource) continue;
    const rank = priorityOf(field, src);
    if (rank < bestRank) {
      bestRank = rank;
      best = src;
    }
  }
  return best ?? incomingSource;
}

// Fields that participate in merging (excludes `id` which is the primary key).
const MERGEABLE_FIELDS: (keyof BookRow)[] = [
  "title",
  "subtitle",
  "author",
  "narrator",
  "series_name",
  "series_number",
  "release_date",
  "cover_url",
  "runtime_minutes",
  "rating",
  "rating_count",
  "description",
  "url",
  "is_ai_narrated",
];

// ---------------------------------------------------------------------------
// Core merge function
// ---------------------------------------------------------------------------

/**
 * Merge incoming data into an existing book record according to the
 * per-field priority rules.
 *
 * @param options.existingBook    The current canonical book row.
 * @param options.incomingData    Partial book data from a source.
 * @param options.source          Which source the incoming data is from.
 * @param options.matchConfidence 0-1 confidence that this data refers to the same book.
 * @param knownSources            Optional list of sources already stored for this book
 *                                (used for smarter existing-source inference).
 */
export function mergeBook(options: MergeOptions, knownSources?: string[]): MergeResult {
  const { existingBook, incomingData, source, matchConfidence } = options;
  const merged = { ...existingBook } as Record<string, unknown>;
  const updatedFields: string[] = [];
  const sources = knownSources ?? [];

  for (const field of MERGEABLE_FIELDS) {
    const incoming = incomingData[field];

    // Rule 3: null/undefined never overwrites a non-null value.
    if (incoming === null || incoming === undefined) continue;

    const existing = existingBook[field];

    // If the existing value is null, any source can fill it in.
    if (existing === null || existing === undefined) {
      merged[field] = incoming;
      updatedFields.push(field);
      continue;
    }

    // Both values are non-null — apply priority rules.
    const existingSource = bestExistingSource(field, source, sources);
    if (incomingWins(field, existingSource, source)) {
      // Only record as updated if the value actually changes.
      if (existing !== incoming) {
        merged[field] = incoming;
        updatedFields.push(field);
      }
    }
  }

  // Rule 5: Low confidence flags review.
  const needsReview = matchConfidence < 0.9;

  return {
    updatedFields,
    book: merged as unknown as BookRow,
    needsReview,
  };
}

// ---------------------------------------------------------------------------
// Multi-source re-merge
// ---------------------------------------------------------------------------

/**
 * Given all source blobs for a book plus a base book row, replay the
 * merge in priority order to produce the canonical merged result.
 *
 * Sources are sorted internally (lowest priority first so higher-priority
 * sources overwrite), so caller order doesn't matter.
 */
export interface SourceBlob {
  source: string;
  rawData: Partial<BookRow>;
}

export function mergeAllSources(
  baseBook: BookRow,
  sources: SourceBlob[],
): MergeResult {
  // Sort sources: lowest priority first (they get applied first, then overwritten).
  const ranked = [...sources].sort((a, b) => {
    const avgA = averagePriority(a.source);
    const avgB = averagePriority(b.source);
    return avgB - avgA;
  });

  let current = { ...baseBook };
  const allUpdated = new Set<string>();
  const allKnownSources = ranked.map((s) => s.source);

  for (const { source, rawData } of ranked) {
    const result = mergeBook(
      {
        existingBook: current,
        incomingData: rawData,
        source,
        matchConfidence: 1.0, // Re-merging already-matched data.
      },
      allKnownSources,
    );
    current = result.book;
    for (const f of result.updatedFields) allUpdated.add(f);
  }

  return {
    updatedFields: [...allUpdated],
    book: current,
    needsReview: false,
  };
}

function averagePriority(source: string): number {
  let sum = 0;
  let count = 0;
  for (const field of MERGEABLE_FIELDS) {
    sum += priorityOf(field, source);
    count++;
  }
  return count > 0 ? sum / count : Infinity;
}
