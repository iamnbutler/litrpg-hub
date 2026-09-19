# LitRPG Hub

A compact index for LitRPG and progression fantasy: a searchable series index, personal reading shelves, explainable recommendations, and audiobook release dates. Evolved from [LitRPG Chart](https://github.com/iamnbutler/litrpg-chart).

## Run it

Node 22.9+ and npm. The committed catalog lets a fresh checkout run without a database or API key.

```sh
npm ci
npm run dev
npm run check
npm run check:backend
npm test
npm run build
```

The default view is a cover grid with compact controls and an optional list layout. The UI includes search by title, series, author, and narrator; genre and content filters; a series entry view or all editions; upcoming, historical, and unconfirmed releases; and book details with source notes. Reading shelves and personal ratings are saved in this browser. Export/import a JSON shelf backup to move between browsers. There are no shared accounts or community reviews yet. Star ratings in the catalog come from Audible.

Book links use `?book=ASIN`; discovery links use `?view=similar&like=ASIN`. The app remains a static SvelteKit site. Set `BASE_PATH=/litrpg-hub` for GitHub Pages, or leave it empty for a root deployment. The deployment workflow is manual and builds the committed snapshot.

## Jev experiments

[Jev / TypeSafe](https://docs.typesafe.ai/introduction) evaluates 12 independent questions in one request per book: genre, explicit content, harem, listing quality, and eight taste dimensions. The app compares those profiles in code, lets readers adjust what matters, and explains shared traits. Books awaiting profiles use explicitly labeled genre matches. Recommendations exclude other volumes of the same series and limit repeated authors. Popularity is only a small tie-breaker.

Put `TYPESAFE_API_KEY` in an ignored `.env` (see `.env.example`). Keys are used only by offline jobs. Builds, page loads, filters, and recommendation sliders make no Jev calls.

```sh
# Inspect the next batch without calling the API
npm run pipeline:enrich -- --limit 24 --dry-run

# Enrich up to 24 uncached series entry points
npm run pipeline:enrich -- --limit 24

# Inspect/update a particular edition
npm run pipeline:enrich -- --book B08V8B2CGV
npm run pipeline:enrich -- --book B08V8B2CGV --force

# Export the resulting assessments for the UI
npm run pipeline:export
```

Each run has a maximum of 100 evaluations. Responses are validated before saving, failures stop the job, previous successes remain usable, and token counts are printed. SQLite caches by the supplied metadata, complete rubric, rubric version, and requested model. A changed description invalidates its old assessment. `jev-latest` is a moving alias: pin `JEV_MODEL` to a model version for repeatability, or use `--force` when deliberately refreshing that alias. Raw responses stay in the local database; normalized assessments go in the public catalog.

**Content judgments have limits.** Sexualized covers/marketing, explicit sexual content, harem, AI narration, disclosed AI writing, and listing quality are separate signals. Romance, violence, mature themes, small audiences, and author identity are not exclusion rules. An absent narrator is unknown. AI writing is flagged only when the source explicitly discloses it; Jev is not an authorship detector. Listing-quality flags route suspicious metadata for review and do not claim the novel itself is low quality. Unknown and low-confidence records remain visible by default. The thresholds are conservative starting points, not a calibrated benchmark.

## Cover classification

The cover pipeline uses **OpenAI GPT-4.1 mini** to produce structured visual observations, then **Jev** to assess those observations alongside the book metadata. The rubric catches clothed pin-up marketing as well as explicit imagery. An attractive character, ordinary romance, or a shirtless action scene alone is not sufficient. Cover evidence never establishes on-page sex, harem relationships, AI authorship, or prose quality.

Set `OPENAI_API_KEY` and `TYPESAFE_API_KEY` in `.env`. `COVER_MODEL` defaults to `gpt-4.1-mini`; it can be pinned to a snapshot. The observed model version is recorded. Run:

```sh
npm run pipeline:covers -- --limit 24 --dry-run
npm run pipeline:covers -- --limit 24
npm run pipeline:covers -- --book B0GPFWKVMM --book B0GPFWTMM9
npm run pipeline:export
```

The job defaults to series entry points, accepts `--all-editions`, and caps each run at 100 books. Images are checked against source hosts, content types, byte signatures, and a 5 MB limit. Their bytes are retained under `data/covers` (or `CATALOG_ASSET_DIR`) so changing the model or rubric can reuse the original image without downloading it again. SHA-256 image hashes, model, prompt, schema, and rubric version key the visual cache, so editions sharing a cover reuse the observation. Source URLs for upcoming/recent books are rechecked after seven days, older releases after 180 days, and unknown release dates after 30 days; `--refresh-images` checks it immediately and `--force` repeats inference. Jev content judgments additionally depend on the book metadata and visual evidence. Missing images, refusals, errors, low confidence, and ambiguous covers are never treated as confirmed clean. Failed jobs preserve prior successes.

**Hide sexualized content** is enabled by default and uses confident marketing flags. Detailed filters separately control explicit scenes, harem, AI narration, and disclosed AI writing. Unclassified content stays visible unless explicitly excluded. Details show the actual evidence and source, and filters show cover-assessment coverage. Builds and browsing make no API calls. This is a bounded initial sample, not a claim that every catalog cover has been assessed.

Reviewed exceptions go in `scripts/backend/config/content-overrides.json`:

```json
{
  "BOOK_ASIN": {
    "harem": { "verdict": "absent", "note": "Publisher explicitly confirms no harem. Source URL and review date here." }
  }
}
```

See [the experiment notes](docs/jev-discovery.md) for what to try next and how to evaluate it.

## Catalog and scraping

`data/books.db` is local and ignored. In this fork it began as an independent snapshot of the Chart database. A fresh clone needs a source fetch or a copied SQLite backup before running export; an empty database is refused so it cannot erase the committed catalog.

```sh
# Prefer a bounded, verified series refresh
npm run pipeline:series -- --help
npm run pipeline:series -- --series dungeon-crawler-carl --limit 20
npm run pipeline:series -- --series the-completionist-chronicles --limit 40

# Broader discovery remains available as an explicit job
npm run pipeline:fetch -- --source audible --year 2026
npm run pipeline:classify
npm run pipeline:export
```

Series discovery parses actual product containers with Cheerio, follows only same-series pagination, and verifies both the source series ASIN and author. Where available it retains the longer per-book publisher synopsis from the series page. Partial product responses never wipe good metadata. Empty catalog responses with a positive result count, malformed payloads, partial pages, and source errors stop the source without advancing a successful search cursor. Fetch runs distinguish completed, partial, and failed work. The full pipeline stops before export after a critical fetch failure.

Books keep stable IDs and distinct raw source snapshots; unchanged payloads update their last-seen time without duplicating the evidence. Series grouping includes the primary author and normalizes punctuation/extra contributor credits. Obvious duplicate backfill placeholders are hidden from browse/release views when an exact richer edition exists; their records and direct links remain available. Distinct narrators, editions, dates, and authors stay distinct. Alias reconciliation across different pen names still needs source identifiers or human review.

Exports preserve uncertain records and provide `catalog.json`, `review.json`, year files, and a series index. Dates are normalized in UTC. Impossible dates and far-future placeholders become unknown and appear under **Date unknown**. Genre-uncertain books are available through **Include genres awaiting review**. Per-reader content preferences never delete source records.

The UI shows the median source timestamp, not the export time, so a new build does not imply a refreshed catalog. The initial snapshot is largely April 2026. The first live series refresh during this fork returned an incomplete page and was recorded as failed; the existing catalog was preserved. Series coverage, content labels, and future release dates remain incomplete.

## Checks

Regression tests cover missing narrator credits, negated content disclaimers, unknown/low-confidence filters, author/series collisions, duplicate placeholders, date normalization, similarity ranking, malformed Jev and vision results, cover refusals, invalid image downloads, changed-cover invalidation, rate-limit backoff, partial metadata preservation, and failed fetch cursors. CI runs frontend and backend type checks, tests, and a static build with the Pages base path. No network credentials are required for CI.

## Preserve the catalog

The SQLite database and cover assets are durable input to future enrichment. They are ignored by Git; the committed JSON is only the site's read model. `CATALOG_DB_PATH` and `CATALOG_ASSET_DIR` can point to a persistent volume outside this checkout.

```sh
npm run pipeline:backup
# Or create a bundle in another location:
npm run pipeline:backup -- --dir /path/to/catalog-backups
```

Each new backup contains a verified SQLite snapshot (including committed WAL changes), source history, inference caches, cover files, and a checksum manifest. Copy the bundle to off-machine storage. To restore, copy it to a new directory and point the two storage variables at its `books.db` and `covers` directory; keep the original backup unchanged. Run `pipeline:export` to reconstruct the site snapshot. Do not copy a live SQLite file by itself.

[Catalog strategy](docs/catalog-strategy.md) describes coverage, work/edition identity, evidence retention, targeted refreshes, the proposed task queue, and the migration order. Work/edition separation, field-level claims, the persisted queue, and remote backup scheduling remain next steps.
