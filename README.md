# LitRPG Hub

An audiobook catalog for LitRPG and progression fantasy. Follow series, track the books you have read, find similar series, and check audio releases. Forked from [LitRPG Chart](https://github.com/iamnbutler/litrpg-chart).

## Run the app

Node 22.9+ and npm. The committed JSON snapshot lets a fresh checkout run without a database or API keys.

```sh
npm ci
npm run dev
npm run check
npm run check:backend
npm test
npm run build
```

The interface is a compact cover grid with search, optional list layout, genres, content preferences, series details, and release views. My library contains followed series. Reading progress and personal ratings belong to works, with edition aliases preserving older saved IDs. Mark all as read applies to released audio; future releases and unknown dates are not silently marked read. The original browser shelf is retained when migrating to the series library. Export a library backup to move it between browsers; there are no shared accounts yet.

Series links use `?view=series&series=dungeon-crawler-carl`; individual editions use `?book=ASIN`. The static SvelteKit build makes no model calls or source requests. `BASE_PATH=/litrpg-hub` builds for a GitHub Pages subdirectory. Deployment is manual.

## Build the catalog

SQLite is the durable catalog; public JSON is its replaceable read model. The initial Chart snapshot remains available while a reviewed core is rebuilt from publisher and author bibliographies. Those legacy records are **not** all verified core records.

The selected registry is [catalog-seeds.json](scripts/backend/config/catalog-seeds.json). Aethon, Soundbooth Theater, Podium, Portal Books, Mountaindale Press, and selected author sites provide work lists and fuller descriptions. Publisher indexes retain unselected candidates for later review. Audible is used to verify **already observed, exact audiobook identifiers**, rather than discover arbitrary keyword matches.

```sh
# Register selected series and reuse previously discovered publisher links
npm run catalog -- seed
npm run catalog -- run --stage sources --limit 100

# Import attributed, reviewed research notes for gaps a crawler cannot fill
npm run catalog -- curate

# Verify exact audiobook identities, dates, narrators and runtimes
npm run catalog -- plan-audio
npm run catalog -- run --stage audio --limit 100

# Plan only missing or changed summaries and Jev profiles
npm run catalog -- plan
npm run catalog -- run --stage enrich --limit 100
npm run catalog -- run --stage assess --limit 100

# Inspect coverage and publish the current read model
npm run catalog -- audit
npm run catalog -- status
npm run pipeline:export
```

Use `--series SERIES_ID` to restrict curation, planning, execution, refresh, retry, or audit. Work can be stopped and resumed with the same command. Durable jobs have unique entity/task/input keys, leases, retry backoff, and explicit review states. Successful results are retained before the next job starts. Review failures do not delete earlier facts or become empty catalogs.

For a single bounded pass through the stages, use `catalog:grind`. By default it resumes saved source and audio jobs without calling models. `--enrich` enables OpenAI descriptions and Jev profiles; each stage defaults to 25 attempts and accepts a limit from 0 to 300. Zero skips that stage. The command reports completions, review cases, remaining jobs and new token usage. Interrupting it finishes the active job before stopping.

```sh
npm run catalog:grind -- --source-limit 50 --audio-limit 50
npm run catalog:grind -- --series divine-apostasy --enrich --extract-limit 20 --assess-limit 20
# Explicitly schedule due observations while preserving earlier completed attempts
npm run catalog:grind -- --refresh --enrich
```

The driver processes registered series and saved candidates. It does not select new series, approve uncertain matches, or install a recurring worker. Run `catalog seed` after reviewing registry changes.

```sh
# Schedule completed source jobs whose saved checks are due
npm run catalog -- refresh
npm run catalog -- run --stage sources --limit 100
npm run catalog -- run --stage audio --limit 100

# Retry transient failures; include review jobs only after investigating the cause
npm run catalog -- retry --stage audio --series the-ten-realms
npm run catalog -- retry --stage audio --series the-ten-realms --review
```

Raw documents, field claims, identifiers and competing editions remain in the private database. Exact product checks require the expected author, series, numeric volume, English language, and standard audiobook format. Numbered audio links on a supported author bibliography can create verification jobs before a work's title is known; the retained page and product must agree before import. Coauthors are distinct people, and conflicting credits preserve competing claims for review. A wrong-volume buy link becomes a review job. Print dates, web-serial volume numbers, omnibus counts, and retailer placeholder years never become audiobook release facts. Distinct performances keep their own narrators and dates.

Source pages are cached by URL and body hash with conditional requests and due dates. Recognized interstitials and identifier-only API responses are rejected. Other degraded pages remain recorded observations; importer guards preserve prior facts and queue review rather than treating them as an empty catalog. Series indexes are checked weekly; stable book pages have longer intervals. Adding a selected series reuses saved index candidates without scraping the index again. `catalog audit` distinguishes confirmed audio, unverified legacy matches, absent audio evidence, missing volumes, undated editions, and stale enrichment. A contiguous list alone never proves a bibliography is complete. Reviewed audio manifests establish the expected mainline list separately from imported rows. The library says “Up to date” only while that assertion is current and every verified released work is read; otherwise it can say “All known audio read.” Story completion is a separate field. See [audio coverage](docs/audio-coverage-proposal.md).

## Descriptions, metadata and recommendations

Set `OPENAI_API_KEY` and `TYPESAFE_API_KEY` in an ignored `.env`; [.env.example](.env.example) lists optional settings. Offline OpenAI jobs write original, source-grounded synopses and extract descriptive features with supporting spans. Series summaries use the first-book premise. Newly acquired full publisher descriptions stay as private evidence; legacy records retain their short retailer listing snippets until curated. `CATALOG_OPENAI_MODEL` controls the extraction model.

[Jev](https://docs.typesafe.ai/introduction) assesses genre, content disclosures, listing quality and eight reading traits. Results retain the actual model, rubric, input hash, confidence and token usage. Changed evidence invalidates the old promoted interpretation. Catalog extraction and work-profile workers save HTTP responses before validation, including malformed or incomplete output, so unchanged retries do not purchase the same failed response again. If a paid receipt cannot commit, those workers park that job and stop further paid work for storage review. Author-profile and reader-trait jobs currently cache successfully parsed responses. A missing usage report is unknown, not evidence of a free call.

The [editorial review registry](scripts/backend/config/catalog-editorial-reviews.json) approves specific extraction receipts against their source inputs, contributing URLs and feature taxonomy. An approved synopsis stays fixed across model reruns; a manual correction takes precedence while the original response remains private and intact. Changing the title, author, source text, contributing URLs or taxonomy invalidates that review. Only approved positive features reach the public catalog; omitted tags mean unknown. Later-volume summaries can remain unreviewed even when their source extraction is current.

Similar series uses cached profiles, reader-adjustable priorities, and explanations of shared traits. Missing profiles fall back to labeled genre matches. Reviewed shared mechanics add a small bonus, capped at 0.04; ignored taste dimensions and already-compared Jev dimensions do not receive that bonus again. An unsupported stats claim on a reviewed book is treated as unknown. Popularity has a small weight. Matching uses an eligible starting audiobook, excludes the seed series, and limits repeated authors. Reader preferences are applied before a recommendation is presented; hiding an early volume cannot turn a later volume into a new series entry point.

Model interpretations remain fallible. Supporting text is not proof that a model interpreted it correctly, and sparse blurbs cannot establish the absence of a trope. Coverage and review queues are part of the data model.

## Content filters and covers

Sexualized marketing, explicit scenes, harem, AI narration, disclosed AI writing, and listing quality are separate signals. OpenAI vision describes the stored cover; Jev combines those observations with source metadata. Cover art never establishes explicit scenes, harem relationships, AI authorship, or prose quality. Missing credits and low-confidence classifications remain unknown.

```sh
npm run pipeline:covers -- --limit 24 --dry-run
npm run pipeline:covers -- --limit 100
npm run pipeline:covers -- --book B0GPFWKVMM --book B0GPFWTMM9
npm run pipeline:authors -- plan
npm run pipeline:authors -- run --limit 10
npm run pipeline:export
```

Cover jobs cache image bytes under `data/covers`, named by content hash. A model or rubric change reuses those bytes; shared covers reuse an observation. `COVER_MODEL` defaults to `gpt-4.1-mini`. `--refresh-images` checks the source image; `--force` deliberately repeats inference. Vision and Jev content runs retain their raw responses before validation, including failed answers. Forced attempts append history and preserve the last valid result for unchanged evidence; changed image bytes invalidate the old cover verdict. Builds and browsing never run these jobs.

Author defaults require positive evidence across independent series and multiple works, followed by Jev review. They fill only unknown book signals. Changed evidence or a later withdrawn classification invalidates the older default. Reviewed [author rules](scripts/backend/config/author-content.json), such as the user-supplied Bruce Sentar rule, remain distinct from automated inference. [Per-book overrides](scripts/backend/config/content-overrides.json) take final precedence and require a note.

Sexualized content is hidden by default. Explicit content, harem and disclosed AI use have separate controls. Unclassified content remains visible unless the reader chooses otherwise. These are evidence-based preferences, not a universal quality score or an AI-writing detector.

## Reader feedback

Reader evidence has its own provenance, source IDs, spoiler flags and distinct-voice digests. Raw comments stay in the private database. Publisher facts, reader opinions and content verdicts remain separate. Aggregate context requires several independent substantive voices and must retain uncertainty and disagreement. A handful of storefront testimonials does not qualify; the first Soundbooth Theater sample was too small and produced no reader consensus. Public Hardcover reviews use its authenticated API, exact title/author matching, privacy filtering, a bounded sample, and thirty-day snapshots. Book-level reviews can cover any format and are not presented as confirmed listener votes. Jev extracts cautious traits; OpenAI writes short original observations with a verbatim-overlap guard. Sample counts, sources and disagreement accompany those observations; model confidence is never a reader-agreement percentage.

Eligibility and displayed counts use the actual deduplicated, spoiler-filtered sample sent for inference. Traits and observations have separate durable jobs scoped to works or series. Paid prose responses are retained before validation, so a rejected answer can be reviewed without purchasing it again. Stored observations are checked against the current validation policy on every export. A [reviewed correction](scripts/backend/config/reader-observation-corrections.json) must match the exact entity, inference receipt, evidence hash, model, rubric and source URLs; the original answer remains intact. Without per-aspect measurements, prose cannot claim that most or many readers share a particular view. Reader observations currently provide context rather than changing recommendation rank.

```sh
npm run pipeline:readers -- import-cached
npm run pipeline:readers -- import-hardcover --title "Dungeon Crawler Carl" --author "Matt Dinniman" --limit 50
npm run pipeline:readers -- plan
npm run pipeline:readers -- run --limit 20
npm run pipeline:readers -- status
npm run pipeline:readers -- corrections
```

Use the ignored `HARDCOVER_API_TOKEN` setting for API acquisition. A cached repeat makes zero HTTP requests. `--force` intentionally reacquires the sample; changed evidence invalidates its previous aggregate.

## Keep the catalog safe

`data/books.db`, raw source text, model responses, reader text and cover bytes are ignored by Git. Use `CATALOG_DB_PATH` and `CATALOG_ASSET_DIR` for storage outside the checkout. A fresh catalog worker should restore a backup; the public JSON is insufficient to reconstruct source history or paid caches. Export refuses an empty database.

```sh
# Verified online SQLite snapshot, covers and checksum manifest
npm run pipeline:backup

# Upload that bundle to an explicitly private GitHub data repository
npm run pipeline:archive -- --repo OWNER/PRIVATE_DATA_REPO

# Verify an extracted/downloaded snapshot without modifying it
npm run pipeline:verify-backup -- --snapshot /path/to/catalog-snapshot
```

The archive command checks repository privacy, file checksums and accidental credential inclusion before upload. It uploads a versioned private release, not raw evidence to the public application repository. To restore, extract a snapshot to a separate directory, run the offline verifier, and point the two storage paths at its `books.db` and `covers` directory. The verifier checks manifest files, SQLite integrity and foreign keys, reports table counts, and compares the books count. It does not establish complete historical image coverage. Do not copy a live SQLite file by itself: committed changes may still be in its WAL.

CI runs frontend/backend checks, offline regression tests and the static build. Tests cover identity mismatches, bad links, incomplete responses, description preservation, job leases, paid-cache recovery, content precedence, library migration and recommendation filtering. See [catalog strategy](docs/catalog-strategy.md) for the data model and remaining work.
