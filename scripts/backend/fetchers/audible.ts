import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHttpClient, type HttpClient } from "../http.js";
import {
  upsertBook,
  upsertBookSource,
  setBookSubgenres,
  insertFetchRun,
  completeFetchRun,
  upsertSearchCursor,
  getSearchCursor,
  getBook,
  type BookRow,
} from "../db/index.js";
import type { Fetcher, FetcherResult } from "./types.js";
import { narrationSignal } from '../classifiers/content.js';
import { validReleaseDate } from '../../../src/lib/catalog.js';

const AUDIBLE_API = "https://api.audible.com/1.0/catalog/products";
const RESPONSE_GROUPS =
  "product_attrs,contributors,series,media,rating,category_ladders";

/** How many days before a productive cursor is considered stale */
const CURSOR_STALE_DAYS = 7;
/** How many days before a zero-result cursor is retried (likely rate-limited) */
const CURSOR_EMPTY_RETRY_DAYS = 1;
/** How many days before an exhausted cursor with results is re-checked */
const CURSOR_EXHAUSTED_DAYS = 30;

export interface AudibleProduct {
  asin: string;
  title?: string;
  subtitle?: string;
  merchandising_summary?: string;
  publisher_summary?: string;
  language?: string;
  release_date?: string;
  publication_datetime?: string;
  runtime_length_min?: number;
  authors?: { asin?: string; name: string }[];
  narrators?: { name: string }[];
  series?: { asin?: string; title: string; sequence?: string }[];
  product_images?: Record<string, string>;
  rating?: { overall_distribution?: { average_rating?: number; num_ratings?: number } };
  category_ladders?: { ladder: { id: string; name: string }[] }[];
}

export interface AudibleResponse {
  products?: AudibleProduct[];
  total_results?: number;
}

interface CategoryConfig {
  id: string;
  name: string;
  maxPages: number;
}

interface SearchConfig {
  genres: string[];
  series: string[];
  categories: CategoryConfig[];
}

function loadSearchConfig(): SearchConfig {
  const configPath = join(
    import.meta.dirname,
    "..",
    "config",
    "audible-searches.json"
  );
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:p|div|li|h[1-6]|section)>/gi, " ")
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

/** Availability copy is a storefront statement, not part of the work's synopsis. */
export function productDescription(product: AudibleProduct): string | null {
  const source=product.publisher_summary?.trim()||product.merchandising_summary?.trim();
  if(!source)return null;
  return stripHtml(source).replace(/^This title will be streaming in Audible Plus through [A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?, \d{4}\.\s*/i,'').trim()||null;
}

function guessSubgenres(product: AudibleProduct): string[] {
  const text = [product.title, product.subtitle, product.merchandising_summary]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const subgenres: string[] = [];
  if (/litrpg|lit[\s-]?rpg|gamelit/.test(text)) subgenres.push("litrpg");
  if (/cultivation|cultivator|qi |dao |xianxia|wuxia/.test(text))
    subgenres.push("cultivation");
  if (/dungeon\s*core|dungeon\s*crawl/.test(text))
    subgenres.push("dungeon");
  if (
    /isekai|transported|reincarnated|reborn\s*(in|as|into)|summoned\s*(to|into)|another\s*world/.test(
      text
    )
  )
    subgenres.push("isekai");
  return subgenres;
}

/** Placeholder recording values are unknown, including when replaying an older cache. */
export function recordingNarrator(value: string | null | undefined): string | null {
  const placeholder = /^(?:T\.?B\.?[DA]\.?|unknown|not (?:yet )?(?:announced|available)|unannounced|to be (?:announced|determined)|pending|n\/?a|none|-)$/i;
  return (value ?? '').split(',').map(name => name.trim()).filter(name => name && !placeholder.test(name)).join(', ') || null;
}
export function recordingRuntime(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && value! > 0 ? value! : null;
}
const narratorNames = (product: AudibleProduct) => Array.isArray(product.narrators)
  ? product.narrators.flatMap(narrator => narrator && typeof narrator.name === 'string' ? [narrator.name] : []).join(', ') : '';

/** Only a source disclosure establishes AI narration. Missing credits are unknown. */
export function isAiNarrated(p: AudibleProduct): boolean {
  return narrationSignal(narratorNames(p)).verdict === 'present';
}

export function productToBookRow(p: AudibleProduct): BookRow {
  const series = p.series?.[0];
  let seriesNumber: number | null = null;
  if (series?.sequence) {
    const num = parseFloat(series.sequence);
    if (!isNaN(num)) seriesNumber = num;
  }

  let title = p.title ?? "";
  if (!title && series) {
    title = seriesNumber ? `${series.title} ${seriesNumber}` : series.title;
  }
  if (!title) title = "Untitled";

  const rating = p.rating?.overall_distribution;

  return {
    id: p.asin,
    title,
    subtitle: p.subtitle ?? null,
    author: (p.authors ?? []).map((a) => a.name).join(", ") || null,
    narrator: recordingNarrator(narratorNames(p)),
    series_name: series?.title ?? null,
    series_number: seriesNumber,
    release_date: validReleaseDate(p.release_date),
    cover_url: p.product_images?.["500"] ?? Object.values(p.product_images ?? {})[0] ?? null,
    runtime_minutes: recordingRuntime(p.runtime_length_min),
    rating: rating?.average_rating ?? null,
    rating_count: rating?.num_ratings ?? null,
    description: productDescription(p),
    url: `https://www.audible.com/pd/${p.asin}`,
    is_ai_narrated: isAiNarrated(p),
  };
}

export class IncompleteCatalogError extends Error {
  constructor() { super('Audible returned an incomplete catalog page (possible soft rate limit). Cursor not advanced; stopping this source.'); }
}
export function catalogPage(data: AudibleResponse, page: number): { products: AudibleProduct[]; exhausted: boolean } {
  if (!Array.isArray(data.products)) throw new IncompleteCatalogError();
  const total = data.total_results;
  if (data.products.length === 0 && (total == null || total > (page - 1) * 50)) throw new IncompleteCatalogError();
  // A partial page with remaining advertised results is not a successful end of the catalog.
  if (data.products.length > 0 && data.products.length < 50 && total != null && total > (page - 1) * 50 + data.products.length) throw new IncompleteCatalogError();
  return { products: data.products, exhausted: total != null ? page * 50 >= total : data.products.length < 50 };
}

function isCursorFresh(
  cursor: { last_fetched_at: string; is_exhausted: number; results_found: number } | undefined,
  year: number,
  currentYear: number,
  staleDays: number
): boolean {
  if (!cursor) return false;

  const fetchedAt = new Date(cursor.last_fetched_at + "Z").getTime();
  const ageDays = (Date.now() - fetchedAt) / (1000 * 60 * 60 * 24);

  if (cursor.is_exhausted) {
    if (cursor.results_found === 0) {
      // Zero results likely means rate-limited — retry after short cooldown
      return ageDays < CURSOR_EMPTY_RETRY_DAYS;
    }
    // Had real results — this search is done, re-check rarely
    return ageDays < CURSOR_EXHAUSTED_DAYS;
  }

  // Not exhausted — use standard staleness window
  return ageDays < staleDays;
}

export class AudibleFetcher implements Fetcher {
  name = "audible";
  private http: HttpClient;
  private staleDays: number;

  constructor(options?: { staleDays?: number; http?: HttpClient }) {
    this.http = options?.http ?? createHttpClient({ timeoutMs: 15000, maxRetries: 3, minDelayMs: 300 });
    this.staleDays = options?.staleDays ?? CURSOR_STALE_DAYS;
  }

  private async fetchPage(
    keywords: string,
    page: number,
    sort?: string
  ): Promise<AudibleResponse> {
    const params: Record<string, string> = {
      keywords,
      num_results: "50",
      page: String(page),
      response_groups: RESPONSE_GROUPS,
      image_sizes: "500",
    };
    if (sort) params.products_sort_by = sort;
    return this.http.get<AudibleResponse>(AUDIBLE_API, params);
  }

  /**
   * Best-of-N retry: fetch a page multiple times and merge by ASIN
   * to compensate for Audible API returning partial results.
   */
  private async fetchPageMerged(
    keywords: string,
    page: number,
    sort?: string,
    attempts = 3
  ): Promise<AudibleProduct[]> {
    // Repeating semantic failures increases throttling and used to turn errors into success.
    const data = await this.fetchPage(keywords, page, sort);
    return catalogPage(data, page).products;
  }

  private async fetchCategoryPage(
    categoryId: string,
    page: number,
    sort?: string
  ): Promise<AudibleResponse> {
    const params: Record<string, string> = {
      category_id: categoryId,
      num_results: "50",
      page: String(page),
      response_groups: RESPONSE_GROUPS,
      image_sizes: "500",
    };
    if (sort) params.products_sort_by = sort;
    return this.http.get<AudibleResponse>(AUDIBLE_API, params);
  }

  private processProduct(
    product: AudibleProduct,
    year: number,
    seen: Set<string>,
    options?: { skipYearFilter?: boolean }
  ): { isNew: boolean } | null {
    if (seen.has(product.asin)) return null;
    // English only
    const existing = getBook(product.asin);
    if (product.language?.toLowerCase() !== "english" && !(existing && !product.language)) return null;
    if (!existing && (!product.title || !product.authors?.length)) return null;
    // Year filter (skipped for series searches — store in actual release year)
    if (!options?.skipYearFilter) {
      const releaseYear = Number(validReleaseDate(product.release_date)?.slice(0, 4));
      if (releaseYear !== year) return null;
    }
    // No content filtering at fetch time — store everything

    seen.add(product.asin);

    const bookRow = productToBookRow(product);
    const isNew = upsertBook(bookRow);
    upsertBookSource(product.asin, "audible", JSON.stringify(product));
    setBookSubgenres(product.asin, guessSubgenres(product));

    return { isNew };
  }

  async fetch(options: {
    year: number;
    incremental: boolean;
  }): Promise<FetcherResult> {
    const { year, incremental } = options;
    const currentYear = new Date().getFullYear();
    const config = loadSearchConfig();
    const seen = new Set<string>();
    const errors: string[] = [];
    let booksNew = 0;
    let booksUpdated = 0;
    let booksFound = 0;

    // Category browsing: use category_id to browse Audible's genre taxonomy
    for (const category of config.categories) {
      const searchKey = `category:${category.name}`;

      if (incremental) {
        const cursor = getSearchCursor("audible", searchKey, year);
        if (isCursorFresh(cursor, year, currentYear, this.staleDays)) {
          console.log(`  [skip] ${searchKey} (cursor fresh)`);
          continue;
        }
      }

      const runId = insertFetchRun("audible", searchKey, year);
      let pagesFetched = 0;
      let resultsFound = 0;
      let isExhausted = false;

      console.log(`  Browsing category: ${category.name} (${category.id})`);
      try {
        for (let page = 1; page <= category.maxPages; page++) {
          const data = await this.fetchCategoryPage(category.id, page, "-ReleaseDate");
          const { products, exhausted } = catalogPage(data, page);
          pagesFetched++;
          resultsFound += products.length;

          if (products.length === 0) {
            isExhausted = true;
            break;
          }

          for (const p of products) {
            const result = this.processProduct(p, year, seen);
            if (result) {
              booksFound++;
              if (result.isNew) booksNew++;
              else booksUpdated++;
            }
          }

          // Stop if we've gone past the target year
          const last = products[products.length - 1];
          if (last?.release_date && new Date(last.release_date).getFullYear() < year) {
            isExhausted = true;
            break;
          }

          if (exhausted) {
            isExhausted = true;
            break;
          }
        }
      } catch (err) {
        const msg = `Category browse "${category.name}" failed: ${err instanceof Error ? err.message : err}`;
        console.error(`  ${msg}`);
        errors.push(msg);
        completeFetchRun(runId, pagesFetched, resultsFound, 'failed');
        return { source: this.name, booksFound, booksNew, booksUpdated, errors };
      }

      completeFetchRun(runId, pagesFetched, resultsFound);
      upsertSearchCursor("audible", searchKey, year, isExhausted, resultsFound);
    }

    // Genre keyword searches: paginate deeply, sorted by date
    for (const keyword of config.genres) {
      const searchKey = `genre:${keyword}`;

      if (incremental) {
        const cursor = getSearchCursor("audible", searchKey, year);
        if (isCursorFresh(cursor, year, currentYear, this.staleDays)) {
          console.log(`  [skip] ${searchKey} (cursor fresh)`);
          continue;
        }
      }

      const runId = insertFetchRun("audible", searchKey, year);
      let pagesFetched = 0;
      let resultsFound = 0;
      let isExhausted = false;

      console.log(`  Searching: ${keyword}`);
      try {
        for (let page = 1; page <= 15; page++) {
          const data = await this.fetchPage(keyword, page, "-ReleaseDate");
          const { products, exhausted } = catalogPage(data, page);
          pagesFetched++;
          resultsFound += products.length;

          if (products.length === 0) {
            isExhausted = true;
            break;
          }

          for (const p of products) {
            const result = this.processProduct(p, year, seen);
            if (result) {
              booksFound++;
              if (result.isNew) booksNew++;
              else booksUpdated++;
            }
          }

          // Stop if we've gone past the target year
          const last = products[products.length - 1];
          if (last?.release_date && new Date(last.release_date).getFullYear() < year) {
            isExhausted = true;
            break;
          }

          if (exhausted) {
            isExhausted = true;
            break;
          }
        }
      } catch (err) {
        const msg = `Genre search "${keyword}" failed: ${err instanceof Error ? err.message : err}`;
        console.error(`  ${msg}`);
        errors.push(msg);
        completeFetchRun(runId, pagesFetched, resultsFound, 'failed');
        return { source: this.name, booksFound, booksNew, booksUpdated, errors };
      }

      completeFetchRun(runId, pagesFetched, resultsFound);
      upsertSearchCursor("audible", searchKey, year, isExhausted, resultsFound);
    }

    // Series-specific searches: merged best-of-3 per page (no date sort)
    for (const keyword of config.series) {
      const searchKey = `series:${keyword}`;

      if (incremental) {
        const cursor = getSearchCursor("audible", searchKey, year);
        if (isCursorFresh(cursor, year, currentYear, this.staleDays)) {
          console.log(`  [skip] ${searchKey} (cursor fresh)`);
          continue;
        }
      }

      const runId = insertFetchRun("audible", searchKey, year);
      let pagesFetched = 0;
      let resultsFound = 0;
      let isExhausted = false;

      console.log(`  Searching series: ${keyword}`);
      try {
        for (let page = 1; page <= 3; page++) {
          const products = await this.fetchPageMerged(keyword, page, undefined, 3);
          pagesFetched++;
          resultsFound += products.length;

          if (products.length === 0) {
            isExhausted = true;
            break;
          }

          for (const p of products) {
            const result = this.processProduct(p, year, seen, { skipYearFilter: true });
            if (result) {
              booksFound++;
              if (result.isNew) booksNew++;
              else booksUpdated++;
            }
          }

          if (products.length < 50) {
            isExhausted = true;
            break;
          }
        }
      } catch (err) {
        const msg = `Series search "${keyword}" failed: ${err instanceof Error ? err.message : err}`;
        console.error(`  ${msg}`);
        errors.push(msg);
        completeFetchRun(runId, pagesFetched, resultsFound, 'failed');
        return { source: this.name, booksFound, booksNew, booksUpdated, errors };
      }

      completeFetchRun(runId, pagesFetched, resultsFound);
      upsertSearchCursor("audible", searchKey, year, isExhausted, resultsFound);
    }

    return {
      source: this.name,
      booksFound,
      booksNew,
      booksUpdated,
      errors,
    };
  }
}
