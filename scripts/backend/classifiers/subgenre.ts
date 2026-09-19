/**
 * Subgenre classifier — multi-signal detection for book subgenre assignment.
 *
 * Signals:
 *   1. Text analysis — scan title, subtitle, and full description against
 *      pattern rules from subgenres.json. Confidence varies by field.
 *   2. Hardcover tags — map community tags from Hardcover source data to
 *      our subgenre taxonomy (confidence 0.9).
 *   3. Series inheritance — if a book has no direct signals, inherit
 *      subgenres from other books in the same series.
 *
 * Each book can have multiple subgenres. Books with no signals get an empty
 * assignment list (no default fallback).
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db.js";
import type { BookRow } from "../db/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubgenreAssignment {
  subgenre: string;
  confidence: number;
  source: "text-analysis" | "hardcover-tags" | "series-inheritance";
}

interface SubgenreRule {
  patterns: string[];
  weight: { title: number; subtitle: number; description: number };
}

// ---------------------------------------------------------------------------
// Hardcover tag -> subgenre mapping
// ---------------------------------------------------------------------------

const TAG_MAP: Record<string, string> = {
  litrpg: "litrpg",
  "lit-rpg": "litrpg",
  gamelit: "litrpg",
  "game-lit": "litrpg",
  cultivation: "cultivation",
  xianxia: "cultivation",
  "progression-fantasy": "progression",
  "progression fantasy": "progression",
  "dungeon-core": "dungeon",
  "dungeon core": "dungeon",
  isekai: "isekai",
  "tower-climbing": "tower-climbing",
  "tower climbing": "tower-climbing",
  "tower defense": "tower-climbing",
  "system-apocalypse": "system-apocalypse",
  "system apocalypse": "system-apocalypse",
  "base-building": "base-building",
  "base building": "base-building",
  "kingdom-building": "base-building",
  "kingdom building": "base-building",
  "settlement building": "base-building",
  "time-loop": "time-loop",
  "time loop": "time-loop",
  academy: "academy",
  "magic academy": "academy",
  "magic school": "academy",
  crafting: "crafting",
  crafter: "crafting",
  blacksmith: "crafting",
  alchemist: "crafting",
  "monster-mc": "monster-mc",
  "monster mc": "monster-mc",
  "monster evolution": "monster-mc",
  wuxia: "wuxia",
};

// ---------------------------------------------------------------------------
// Config loading (cached at module level for batch processing)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

let _cachedRules: Map<
  string,
  { regex: RegExp; weight: SubgenreRule["weight"] }
> | null = null;

function loadSubgenreRules(): Map<
  string,
  { regex: RegExp; weight: SubgenreRule["weight"] }
> {
  if (_cachedRules) return _cachedRules;

  const configPath = join(__dirname, "..", "config", "subgenres.json");
  const raw = JSON.parse(
    readFileSync(configPath, "utf-8")
  ) as Record<string, unknown>;
  const rules = new Map<
    string,
    { regex: RegExp; weight: SubgenreRule["weight"] }
  >();

  for (const [key, value] of Object.entries(raw)) {
    if (key === "defaultSubgenre") continue;
    if (!value || typeof value !== "object" || !("patterns" in value)) continue;
    const rule = value as SubgenreRule;
    const regex = new RegExp(rule.patterns.join("|"), "i");
    rules.set(key, { regex, weight: rule.weight });
  }

  _cachedRules = rules;
  return rules;
}

// ---------------------------------------------------------------------------
// Classification signals
// ---------------------------------------------------------------------------

/**
 * Analyze text fields (title, subtitle, description) against subgenre patterns.
 */
function analyzeText(
  book: BookRow,
  rules: Map<string, { regex: RegExp; weight: SubgenreRule["weight"] }>
): SubgenreAssignment[] {
  const assignments: SubgenreAssignment[] = [];

  for (const [subgenre, { regex, weight }] of rules) {
    let bestConfidence = 0;

    // Check title
    if (book.title && regex.test(book.title)) {
      bestConfidence = Math.max(bestConfidence, weight.title);
    }

    // Check subtitle
    if (book.subtitle && regex.test(book.subtitle)) {
      bestConfidence = Math.max(bestConfidence, weight.subtitle);
    }

    // Check full description
    if (book.description && regex.test(book.description)) {
      bestConfidence = Math.max(bestConfidence, weight.description);
    }

    if (bestConfidence > 0) {
      assignments.push({
        subgenre,
        confidence: bestConfidence,
        source: "text-analysis",
      });
    }
  }

  return assignments;
}

/**
 * Map Hardcover community tags to subgenres if the book has Hardcover source data.
 */
function analyzeHardcoverTags(bookId: string): SubgenreAssignment[] {
  const db = getDb();
  const sourceRow = db
    .prepare(
      "SELECT raw_data FROM book_sources WHERE book_id = ? AND source = 'hardcover'"
    )
    .get(bookId) as { raw_data: string } | undefined;

  if (!sourceRow) return [];

  try {
    const data = JSON.parse(sourceRow.raw_data);
    const taggings = data.taggings as
      | { tag: { tag: string } }[]
      | undefined;
    if (!taggings?.length) return [];

    const seen = new Set<string>();
    const assignments: SubgenreAssignment[] = [];

    for (const t of taggings) {
      const key = t.tag.tag.toLowerCase().trim();
      const mapped = TAG_MAP[key];
      if (mapped && !seen.has(mapped)) {
        seen.add(mapped);
        assignments.push({
          subgenre: mapped,
          confidence: 0.9,
          source: "hardcover-tags",
        });
      }
    }

    return assignments;
  } catch {
    return [];
  }
}

/**
 * Inherit subgenres from other books in the same series.
 * Only used when a book has no direct signals.
 */
function inheritFromSeries(bookId: string): SubgenreAssignment[] {
  const db = getDb();

  // Find the series this book belongs to
  const bookRow = db
    .prepare("SELECT series_id FROM books WHERE id = ?")
    .get(bookId) as { series_id: string | null } | undefined;

  if (!bookRow?.series_id) return [];

  // Get subgenres from sibling books in the same series
  const siblings = db
    .prepare(
      `SELECT DISTINCT bs.subgenre, MAX(bs.confidence) as confidence
       FROM book_subgenres bs
       JOIN books b ON b.id = bs.book_id
       WHERE b.series_id = ? AND b.id != ?
       GROUP BY bs.subgenre`
    )
    .all(bookRow.series_id, bookId) as {
    subgenre: string;
    confidence: number;
  }[];

  return siblings.map((s) => ({
    subgenre: s.subgenre,
    // Reduce confidence for inherited assignments
    confidence: Math.min(s.confidence * 0.8, 0.7),
    source: "series-inheritance" as const,
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a single book using multi-signal detection.
 *
 * Returns an array of subgenre assignments, possibly empty if no signals found.
 * Each subgenre appears at most once, with the highest confidence from any source.
 */
export function classifyBook(book: BookRow): SubgenreAssignment[] {
  const rules = loadSubgenreRules();

  // Gather signals from all sources
  const textSignals = analyzeText(book, rules);
  const tagSignals = analyzeHardcoverTags(book.id);

  // Merge: keep highest confidence per subgenre
  const merged = new Map<string, SubgenreAssignment>();

  for (const signal of [...textSignals, ...tagSignals]) {
    const existing = merged.get(signal.subgenre);
    if (!existing || signal.confidence > existing.confidence) {
      merged.set(signal.subgenre, signal);
    }
  }

  // If no direct signals, try series inheritance
  if (merged.size === 0) {
    const inherited = inheritFromSeries(book.id);
    for (const signal of inherited) {
      const existing = merged.get(signal.subgenre);
      if (!existing || signal.confidence > existing.confidence) {
        merged.set(signal.subgenre, signal);
      }
    }
  }

  return [...merged.values()];
}
