/**
 * Hardcover.app enrichment fetcher.
 *
 * Searches Hardcover's GraphQL API for books already in our database
 * to enrich them with community genre tags and ratings. This is an
 * enrichment-only source — it never creates new book records.
 *
 * Rate limiting: 1 req/sec (well under their 60/min limit).
 * Caching: Skips books that already have a hardcover source record
 * less than 7 days old.
 */

import { createHttpClient, type HttpClient } from "../http.js";
import { getDb } from "../db.js";
import {
  upsertBookSource,
  setBookSubgenres,
  insertFetchRun,
  completeFetchRun,
} from "../db/index.js";

const HARDCOVER_API = "https://api.hardcover.app/v1/graphql";
const CACHE_DAYS = 7;

// GraphQL query: search by title + author, return tags and ratings
const SEARCH_QUERY = `
  query SearchBook($query: String!) {
    search(query: $query, query_type: "Book", per_page: 5) {
      results {
        ... on Book {
          id
          title
          contributions {
            author {
              name
            }
          }
          rating
          ratings_count
          users_read_count
          taggings {
            tag {
              tag
            }
          }
        }
      }
    }
  }
`;

interface HardcoverBook {
  id: number;
  title: string;
  contributions?: { author: { name: string } }[];
  rating?: number;
  ratings_count?: number;
  users_read_count?: number;
  taggings?: { tag: { tag: string } }[];
}

interface SearchResponse {
  data?: {
    search?: {
      results?: HardcoverBook[];
    };
  };
}

interface BookToEnrich {
  id: string;
  title: string;
  author: string | null;
}

/** Map Hardcover tags to our subgenre taxonomy. */
const TAG_MAP: Record<string, string> = {
  litrpg: "litrpg",
  "lit-rpg": "litrpg",
  gamelit: "litrpg",
  "game-lit": "litrpg",
  cultivation: "cultivation",
  xianxia: "cultivation",
  "progression-fantasy": "litrpg",
  "progression fantasy": "litrpg",
  "dungeon-core": "dungeon",
  "dungeon core": "dungeon",
  isekai: "isekai",
  "tower-climbing": "tower-climbing",
  "tower climbing": "tower-climbing",
  "tower defense": "tower-climbing",
  "system-apocalypse": "system-apocalypse",
  "system apocalypse": "system-apocalypse",
  apocalypse: "system-apocalypse",
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
  "martial arts": "wuxia",
};

function mapTags(taggings: { tag: { tag: string } }[]): string[] {
  const subgenres = new Set<string>();
  for (const t of taggings) {
    const key = t.tag.tag.toLowerCase().trim();
    const mapped = TAG_MAP[key];
    if (mapped) subgenres.add(mapped);
  }
  return [...subgenres];
}

/** Fuzzy match: check if author names overlap (first + last name match). */
function authorsMatch(ourAuthor: string | null, theirAuthors: HardcoverBook["contributions"]): boolean {
  if (!ourAuthor || !theirAuthors?.length) return true; // lenient if missing
  const ourNames = ourAuthor.toLowerCase().split(",").map((s) => s.trim());
  const theirNames = theirAuthors.map((c) => c.author.name.toLowerCase().trim());
  return ourNames.some((ours) =>
    theirNames.some((theirs) => {
      // Match if last names are the same
      const ourLast = ours.split(" ").pop();
      const theirLast = theirs.split(" ").pop();
      return ourLast === theirLast;
    })
  );
}

export class HardcoverFetcher {
  name = "hardcover";
  private http: HttpClient;
  private token: string | undefined;

  constructor() {
    // 1000ms between requests — gentle on their API
    this.http = createHttpClient({ timeoutMs: 15000, maxRetries: 2, minDelayMs: 1000 });
    this.token = process.env.HARDCOVER_API_TOKEN;
  }

  async enrich(): Promise<{ enriched: number; skipped: number; errors: string[] }> {
    if (!this.token) {
      console.log("  [hardcover] No HARDCOVER_API_TOKEN set, skipping enrichment");
      return { enriched: 0, skipped: 0, errors: [] };
    }

    const db = getDb();
    const errors: string[] = [];

    // Find books that don't have a fresh hardcover source record
    const booksToEnrich = db.prepare(`
      SELECT b.id, b.title, b.author
      FROM books b
      LEFT JOIN book_sources bs ON bs.book_id = b.id AND bs.source = 'hardcover'
      WHERE bs.id IS NULL
         OR julianday('now') - julianday(bs.fetched_at) > ?
      ORDER BY b.rating_count DESC
      LIMIT 100
    `).all(CACHE_DAYS) as BookToEnrich[];

    if (booksToEnrich.length === 0) {
      console.log("  [hardcover] All books recently enriched, nothing to do");
      return { enriched: 0, skipped: 0, errors: [] };
    }

    console.log(`  [hardcover] Enriching ${booksToEnrich.length} books...`);
    const runId = insertFetchRun("hardcover", "enrichment", 0);

    let enriched = 0;
    let skipped = 0;

    for (const book of booksToEnrich) {
      const searchQuery = `${book.title} ${book.author ?? ""}`.trim();

      try {
        const result = await this.http.post<SearchResponse>(
          HARDCOVER_API,
          { query: SEARCH_QUERY, variables: { query: searchQuery } },
          { Authorization: `Bearer ${this.token}` },
        );

        const results = result.data?.search?.results ?? [];
        // Find best match: title similarity + author match
        const match = results.find((r) =>
          r.title && authorsMatch(book.author, r.contributions)
        );

        if (!match) {
          skipped++;
          continue;
        }

        // Store raw response
        upsertBookSource(book.id, "hardcover", JSON.stringify(match), String(match.id));

        // Enrich subgenres from community tags
        if (match.taggings?.length) {
          const tags = mapTags(match.taggings);
          if (tags.length > 0) {
            // Add hardcover tags alongside existing ones (don't replace)
            const existing = db.prepare(
              "SELECT subgenre FROM book_subgenres WHERE book_id = ?"
            ).all(book.id) as { subgenre: string }[];
            const allSubgenres = new Set(existing.map((r) => r.subgenre));
            for (const tag of tags) allSubgenres.add(tag);
            setBookSubgenres(book.id, [...allSubgenres]);
          }
        }

        enriched++;
      } catch (err) {
        const msg = `Hardcover enrichment failed for "${book.title}": ${err instanceof Error ? err.message : err}`;
        console.error(`    ${msg}`);
        errors.push(msg);
      }
    }

    completeFetchRun(runId, booksToEnrich.length, enriched);
    console.log(`  [hardcover] Enriched ${enriched}, skipped ${skipped}, errors ${errors.length}`);

    return { enriched, skipped, errors };
  }
}
