/**
 * Pipeline orchestrator — ties all fetchers, matchers, classifiers, and exporters
 * together into a coherent, sequential pipeline.
 *
 * Stages:
 *   1. MIGRATE    → Apply pending database migrations
 *   2. FETCH      → Run all enabled fetchers (Audible, Hardcover, Royal Road)
 *   3. CORRECT    → Re-merge multi-source books + apply manual overrides
 *   4. CLASSIFY   → Run subgenre classification on all books
 *   5. DETECT     → Run AI narration detection
 *   6. SCORE      → Compute quality scores
 *   7. EXPORT     → Generate static JSON files
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { runMigrations, getMigrationVersion } from "./migrate.js";
import { AudibleFetcher } from "./fetchers/audible.js";
import { HardcoverFetcher } from "./fetchers/hardcover.js";
import { RoyalRoadScraper } from "./fetchers/royalroad.js";
import { closeDb, getDb } from "./db.js";
import { getMultiSourceBookIds, remergeBook, getAllBooks, setBookSubgenresWithMeta, repairSeriesIdentities } from "./db/index.js";
import { classifyBook } from "./classifiers/subgenre.js";
import { narrationSignal } from './classifiers/content.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  year?: number;
  full?: boolean;
  source?: string;
  dryRun?: boolean;
}

export interface StageResult {
  name: string;
  duration: number;
  result: "success" | "warning" | "error";
  details: string;
}

export interface PipelineResult {
  stages: StageResult[];
  totalDuration: number;
  booksProcessed: number;
  booksExported: number;
}

export interface BackfillOptions {
  years: number[];
  delayBetweenYears?: number;
  dryRun?: boolean;
}

type StageFn = (ctx: PipelineContext) => Promise<string>;

interface StageDefinition {
  name: string;
  fn: StageFn;
  /** If true, a failure in this stage causes a non-zero exit code. */
  critical: boolean;
}

interface PipelineContext {
  options: PipelineOptions;
  years: number[];
  projectRoot: string;
  booksProcessed: number;
  booksExported: number;
}

// ---------------------------------------------------------------------------
// Stage implementations — delegate to existing modules
// ---------------------------------------------------------------------------

const stageMigrate: StageFn = async (_ctx) => {
  const count = runMigrations();
  const version = getMigrationVersion();
  if (count === 0) return `already up to date (version ${version})`;
  return `applied ${count} migration(s), now at version ${version}`;
};

const stageFetch: StageFn = async (ctx) => {
  const { options } = ctx;
  const parts: string[] = [];

  // 1. Royal Road discovery (find new series to search on Audible)
  if (!options.source || options.source === "royalroad") {
    try {
      const rr = new RoyalRoadScraper();
      const { discovered, errors: rrErrors } = await rr.discover();
      if (discovered.length > 0) {
        parts.push(`royalroad: ${discovered.length} new series discovered`);
        // Log discovered series for manual review / future auto-add
        for (const s of discovered.slice(0, 10)) {
          console.log(`    → ${s.title} (${s.subgenres.join(", ")})`);
        }
        if (discovered.length > 10) {
          console.log(`    ... and ${discovered.length - 10} more`);
        }
      } else {
        parts.push("royalroad: no new series");
      }
      if (rrErrors.length > 0) parts.push(`royalroad: ${rrErrors.length} errors`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      parts.push(`royalroad: failed (${msg})`);
    }
  }

  // 2. Audible fetch (primary data source)
  if (!options.source || options.source === "audible") {
    const fetcher = new AudibleFetcher();
    for (const year of ctx.years) {
      console.log(`  Fetching ${year}...`);
      const result = await fetcher.fetch({
        year,
        incremental: !options.full,
      });
      ctx.booksProcessed += result.booksFound;
      parts.push(
        `audible ${year}: ${result.booksNew} new, ${result.booksUpdated} updated`
      );
      if (result.errors.length > 0) {
        throw new Error(result.errors.join('; '));
      }
    }
  }

  // 3. Hardcover enrichment (after Audible, so we have books to enrich)
  if (!options.source || options.source === "hardcover") {
    try {
      const hc = new HardcoverFetcher();
      const { enriched, errors: hcErrors } = await hc.enrich();
      parts.push(`hardcover: ${enriched} books enriched`);
      if (hcErrors.length > 0) parts.push(`hardcover: ${hcErrors.length} errors`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      parts.push(`hardcover: failed (${msg})`);
    }
  }

  return parts.join("; ");
};

const stageCorrect: StageFn = async (_ctx) => {
  const repaired = repairSeriesIdentities();
  // Re-merge all books that have data from multiple sources,
  // replaying the field-level priority strategy so that higher-priority
  // sources win per-field.
  const multiSourceIds = getMultiSourceBookIds();
  if (multiSourceIds.length === 0) {
    return `${repaired} series identities repaired; no multi-source books to merge`;
  }

  let mergedCount = 0;
  let fieldsChanged = 0;

  for (const bookId of multiSourceIds) {
    const changed = remergeBook(bookId);
    if (changed.length > 0) {
      mergedCount++;
      fieldsChanged += changed.length;
    }
  }

  return `re-merged ${mergedCount}/${multiSourceIds.length} books (${fieldsChanged} fields updated)`;
};

const stageClassify: StageFn = async (_ctx) => {
  const books = getAllBooks();
  if (books.length === 0) {
    return "no books to classify";
  }

  let classified = 0;
  let unclassified = 0;
  const distribution: Record<string, number> = {};

  for (const book of books) {
    const assignments = classifyBook(book);
    setBookSubgenresWithMeta(
      book.id,
      assignments.map((a) => ({
        subgenre: a.subgenre,
        confidence: a.confidence,
        source: a.source,
      }))
    );

    if (assignments.length > 0) {
      classified++;
      for (const a of assignments) {
        distribution[a.subgenre] = (distribution[a.subgenre] ?? 0) + 1;
      }
    } else {
      unclassified++;
    }
  }

  // Log subgenre distribution
  const sorted = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
  console.log("  Subgenre distribution:");
  for (const [subgenre, count] of sorted) {
    console.log(`    ${subgenre}: ${count}`);
  }

  return `${classified} classified, ${unclassified} unclassified (${books.length} total)`;
};

const stageDetect: StageFn = async (_ctx) => {
  const books = getAllBooks();
  const statement = getDb().prepare('UPDATE books SET is_ai_narrated=? WHERE id=?');
  let disclosed = 0;
  getDb().transaction(() => {
    for (const book of books) {
      const detected = narrationSignal(book.narrator).verdict === 'present';
      statement.run(detected ? 1 : 0, book.id);
      if (detected) disclosed++;
    }
  })();
  return `${disclosed} disclosed AI narrator credits; missing credits remain unknown in the catalog`;
};

const stageScore: StageFn = async (_ctx) => {
  // Metadata completeness is useful for repair queues; it is never a verdict on prose or authorship.
  getDb().prepare(`UPDATE books SET quality_score = (
    (CASE WHEN length(COALESCE(description,'')) >= 60 THEN 1 ELSE 0 END) +
    (CASE WHEN length(COALESCE(author,'')) > 0 THEN 1 ELSE 0 END) +
    (CASE WHEN length(COALESCE(narrator,'')) > 0 THEN 1 ELSE 0 END) +
    (CASE WHEN length(COALESCE(cover_url,'')) > 0 THEN 1 ELSE 0 END)
  ) / 4.0`).run();
  return 'metadata completeness updated; Jev listing-quality assessments are run explicitly with pipeline:enrich';
};

const stageExport: StageFn = async (ctx) => {
  if (ctx.options.dryRun) {
    return "dry run — skipped";
  }

  // Delegate to the JSON exporter (runs as a separate process since it's a script with top-level execution)
  const exporterPath = join(
    import.meta.dirname,
    "exporters",
    "json.ts"
  );
  try {
    execSync(`npx tsx ${exporterPath}`, {
      stdio: "inherit",
      cwd: ctx.projectRoot,
    });
    return "static JSON files written";
  } catch {
    throw new Error("JSON export failed");
  }
};

// ---------------------------------------------------------------------------
// Stage registry
// ---------------------------------------------------------------------------

const ALL_STAGES: StageDefinition[] = [
  { name: "MIGRATE", fn: stageMigrate, critical: true },
  { name: "FETCH", fn: stageFetch, critical: true },
  { name: "CORRECT", fn: stageCorrect, critical: false },
  { name: "CLASSIFY", fn: stageClassify, critical: false },
  { name: "DETECT", fn: stageDetect, critical: false },
  { name: "SCORE", fn: stageScore, critical: false },
  { name: "EXPORT", fn: stageExport, critical: true },
];

/** Map CLI subcommands to stage index ranges (inclusive). */
export const SUBCOMMAND_STAGES: Record<string, [number, number]> = {
  fetch: [0, 1], // MIGRATE + FETCH
  export: [6, 6], // EXPORT
  classify: [3, 5], // CLASSIFY + DETECT + SCORE
  build: [0, 6], // all stages
};

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

function determineYears(options: PipelineOptions): number[] {
  if (options.year) return [options.year];
  const current = new Date().getFullYear();
  return [current - 1, current, current + 1];
}

export async function runPipeline(
  options: PipelineOptions = {},
  stageRange?: [number, number]
): Promise<PipelineResult> {
  const start = Date.now();
  const years = determineYears(options);

  const projectRoot = join(import.meta.dirname, "..", "..");

  const ctx: PipelineContext = {
    options,
    years,
    projectRoot,
    booksProcessed: 0,
    booksExported: 0,
  };

  const [startIdx, endIdx] = stageRange ?? [0, ALL_STAGES.length - 1];
  const stagesToRun = ALL_STAGES.slice(startIdx, endIdx + 1);
  const totalStages = ALL_STAGES.length;

  console.log("Pipeline started");

  if (options.dryRun) {
    return { stages: stagesToRun.map(stage => ({ name: stage.name, duration: 0, result: 'success', details: 'dry run — planned, no reads from external sources or database writes' })), totalDuration: 0, booksProcessed: 0, booksExported: 0 };
  }

  const results: StageResult[] = [];

  for (const stage of stagesToRun) {
    const stageIdx = ALL_STAGES.indexOf(stage);
    const label = `  [${stageIdx + 1}/${totalStages}]`;
    const stageStart = Date.now();

    let result: StageResult;
    try {
      const details = await stage.fn(ctx);
      const duration = (Date.now() - stageStart) / 1000;
      result = { name: stage.name, duration, result: "success", details };
      console.log(
        `${label} ${stage.name.padEnd(10)} \u2713 (${duration.toFixed(1)}s) \u2014 ${details}`
      );
    } catch (err: unknown) {
      const duration = (Date.now() - stageStart) / 1000;
      const msg = err instanceof Error ? err.message : String(err);
      const severity = stage.critical ? "error" : "warning";
      result = { name: stage.name, duration, result: severity, details: msg };
      const icon = stage.critical ? "\u2717" : "\u26A0";
      console.error(
        `${label} ${stage.name.padEnd(10)} ${icon} (${duration.toFixed(1)}s) \u2014 ${msg}`
      );
    }

    results.push(result);
    if (result.result === 'error') break; // Preserve the last good export after a failed fetch.
  }

  closeDb();

  const totalDuration = (Date.now() - start) / 1000;

  console.log(
    `\nPipeline completed in ${totalDuration.toFixed(1)}s \u2014 ` +
      `${ctx.booksProcessed} books processed, ${ctx.booksExported} exported`
  );

  return {
    stages: results,
    totalDuration,
    booksProcessed: ctx.booksProcessed,
    booksExported: ctx.booksExported,
  };
}

// ---------------------------------------------------------------------------
// Backfill pipeline — exhaustive historical fetch for a range of years
// ---------------------------------------------------------------------------

const DEFAULT_BACKFILL_DELAY_MS = 5000;

export async function runBackfillPipeline(
  options: BackfillOptions
): Promise<PipelineResult> {
  const start = Date.now();
  const projectRoot = join(import.meta.dirname, "..", "..");
  const delayMs = options.delayBetweenYears ?? DEFAULT_BACKFILL_DELAY_MS;

  const results: StageResult[] = [];
  let totalBooksProcessed = 0;
  let totalBooksExported = 0;

  // 1. MIGRATE — run once before any fetching
  console.log("Backfill pipeline started");
  console.log(`  Years: ${options.years.join(", ")}`);
  console.log(`  Delay between years: ${delayMs}ms`);
  console.log("");

  const migrateStart = Date.now();
  try {
    const details = await stageMigrate({
      options: {},
      years: options.years,
      projectRoot,
      booksProcessed: 0,
      booksExported: 0,
    });
    const duration = (Date.now() - migrateStart) / 1000;
    results.push({ name: "MIGRATE", duration, result: "success", details });
    console.log(`  [1/3] MIGRATE    \u2713 (${duration.toFixed(1)}s) \u2014 ${details}`);
  } catch (err: unknown) {
    const duration = (Date.now() - migrateStart) / 1000;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: "MIGRATE", duration, result: "error", details: msg });
    console.error(`  [1/3] MIGRATE    \u2717 (${duration.toFixed(1)}s) \u2014 ${msg}`);
    closeDb();
    return {
      stages: results,
      totalDuration: (Date.now() - start) / 1000,
      booksProcessed: 0,
      booksExported: 0,
    };
  }

  // 2. FETCH — iterate over each year with full mode (no incremental cursors)
  const fetchStart = Date.now();
  const fetchParts: string[] = [];
  const fetchErrors: string[] = [];
  const fetcher = new AudibleFetcher();

  for (let i = 0; i < options.years.length; i++) {
    const year = options.years[i];
    console.log(`\n  Year ${year} (${i + 1}/${options.years.length}): fetching...`);

    try {
      const result = await fetcher.fetch({
        year,
        incremental: false, // backfill is always exhaustive
      });
      totalBooksProcessed += result.booksFound;
      fetchParts.push(
        `${year}: ${result.booksNew} new, ${result.booksUpdated} updated`
      );
      if (result.errors.length > 0) {
        fetchErrors.push(...result.errors);
        fetchParts.push(`${year}: ${result.errors.length} error(s)`);
      }
      console.log(
        `  Year ${year}: done \u2014 ${result.booksNew} new, ${result.booksUpdated} updated, ${result.booksFound} total`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      fetchParts.push(`${year}: failed (${msg})`);
      fetchErrors.push(msg);
      console.error(`  Year ${year}: failed \u2014 ${msg}`);
    }

    // Delay between years (skip after the last one)
    if (i < options.years.length - 1 && delayMs > 0) {
      console.log(`  Waiting ${delayMs}ms before next year...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const fetchDuration = (Date.now() - fetchStart) / 1000;
  const fetchSummary = fetchParts.join("; ");
  const fetchResultStatus: "success" | "warning" =
    fetchErrors.length > 0 ? "warning" : "success";
  results.push({
    name: "FETCH",
    duration: fetchDuration,
    result: fetchResultStatus,
    details: fetchSummary,
  });
  console.log(
    `\n  [2/3] FETCH      ${fetchResultStatus === "success" ? "\u2713" : "\u26A0"} (${fetchDuration.toFixed(1)}s) \u2014 ${fetchSummary}`
  );

  // 3. EXPORT — generate static JSON for all years
  if (options.dryRun) {
    results.push({
      name: "EXPORT",
      duration: 0,
      result: "success",
      details: "dry run \u2014 skipped",
    });
    console.log(`  [3/3] EXPORT     \u2713 (0.0s) \u2014 dry run \u2014 skipped`);
  } else {
    const exportStart = Date.now();
    const exportCtx: PipelineContext = {
      options: {},
      years: options.years,
      projectRoot,
      booksProcessed: totalBooksProcessed,
      booksExported: 0,
    };
    try {
      const details = await stageExport(exportCtx);
      const duration = (Date.now() - exportStart) / 1000;
      totalBooksExported = exportCtx.booksExported;
      results.push({ name: "EXPORT", duration, result: "success", details });
      console.log(`  [3/3] EXPORT     \u2713 (${duration.toFixed(1)}s) \u2014 ${details}`);
    } catch (err: unknown) {
      const duration = (Date.now() - exportStart) / 1000;
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name: "EXPORT", duration, result: "error", details: msg });
      console.error(`  [3/3] EXPORT     \u2717 (${duration.toFixed(1)}s) \u2014 ${msg}`);
    }
  }

  closeDb();

  const totalDuration = (Date.now() - start) / 1000;
  console.log(
    `\nBackfill completed in ${totalDuration.toFixed(1)}s \u2014 ` +
      `${totalBooksProcessed} books processed across ${options.years.length} year(s)`
  );

  return {
    stages: results,
    totalDuration,
    booksProcessed: totalBooksProcessed,
    booksExported: totalBooksExported,
  };
}

export function hasCriticalFailure(result: PipelineResult): boolean {
  return result.stages.some((s) => s.result === "error");
}
