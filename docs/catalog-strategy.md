# A catalog that improves without being rebuilt

The database is the durable catalog. Fetchers add observations; merge rules select facts; classifiers add interpretations; the site consumes a published snapshot. A scraper outage must not remove books, and a model upgrade must not require downloading their evidence again.

## Build coverage deliberately

1. Start with a reviewed set of important LitRPG/progression series. Resolve their stable source IDs and authors, then enumerate every volume and edition. Measure missing first volumes and gaps instead of assuming the first fetched record is the series entry point.
2. Expand through known authors, publishers, explicit new-book submissions, and source-supported feeds/APIs. Broad keyword searches produce candidates for review, not automatic genre membership. Track completed discovery pages so a refresh does not restart the whole search.
3. Fetch a full book/series description once. The current Audible API snippets are often about 200 characters; that is inadequate evidence for detailed recommendations or confident absence of sexual content. Retain a better description when a later response is shorter.
4. Attach independent sources using exact identifiers first. ISBN, source book/edition IDs, and a verified series ID + volume + author are useful. Title/author similarity only generates candidates. An author surname alone cannot justify a match. Preserve unresolved cases for review.
5. Keep a small reviewed benchmark: established series, new and translated authors, ordinary romance, harem, no-harem statements, sexualized covers, ordinary action covers, incomplete records, and alternate editions. Evaluate individual classifier dimensions, false positives, and unclassified coverage.

[Hardcover's API](https://docs.hardcover.app/api/getting-started/) exposes books and editions and can enrich a resolved identity. [Open Library's monthly data dumps](https://openlibrary.org/developers/dumps) offer another route to bulk metadata without per-book scraping. Neither should be assumed complete for this niche. Use their source IDs and provenance, and keep ratings from different sources distinct.

## Canonical records and evidence

| Record | Responsibility |
| --- | --- |
| Series | Stable internal ID, title aliases, creators, source identities, ordered membership. |
| Work | One book/volume, independent of format. Canonical title/author, descriptions, series membership, review state. Recommendations and reader shelves should normally target this ID. |
| Edition | Ebook, print, audiobook, dramatization, collection, language/region. ISBN/ASIN and source edition IDs, narrator, publisher, runtime, cover, edition-specific release dates. |
| Source record | The external source ID and every distinct fetched payload, content hash, first/last observation, and next check time. |
| Field claim | Value, source evidence, scope, observed time, confidence/review status. An accepted value can change without deleting the competing claims. |
| Cover asset | Image bytes named by SHA-256, source URL, MIME type, last check time. Multiple editions may reference one asset. |
| Assessment | Entity or asset, input digest, model, rubric version, result, confidence, timestamp, usage. Interpretation is separate from source facts. |
| Job | Entity, task, input digest, priority, due time, status, attempts, and last error. A unique task/entity/input key prevents duplicate work. |

The legacy `books.id` is an Audible ASIN; those rows are editions. Canonical series, works, and edition links now sit alongside them. Public IDs remain stable and library reconciliation keeps old edition and generated-work aliases. Uncertain editions remain separate until evidence supports a merge. A series is not itself a work, and an omnibus may contain multiple works.

Editorial corrections must have priority over automated guesses and remain attached to their evidence. A missing value is not a deletion; a failed lookup is not proof that a book vanished. Genre labels, sexualized marketing, explicit scenes, harem, AI narration, disclosed AI writing, and listing quality each need their own evidence.

The editorial registry now binds an approved extraction receipt to source inputs, every contributing URL and a feature-taxonomy version. Model changes can produce new candidates without replacing the approved prose or tags. Evidence changes invalidate the review. Source-supported features are positive claims only; an omitted tag cannot be converted into an absence score.

## Progressive enrichment

Schedule missing or stale tasks rather than rerunning the whole pipeline:

| Event | Work to schedule |
| --- | --- |
| New source ID | Fetch metadata, resolve identity, retain the source, fill missing fields. |
| Better description | Reassess metadata-dependent labels and reading traits. Reuse the cover observation. |
| Cover bytes changed | Observe the new image; reassess cover-dependent marketing labels. |
| Vision rubric/model changed | Read stored image bytes and reobserve. No source request is required. |
| Jev rubric/model changed | Reevaluate stored metadata/observations. No image download or vision call is required. |
| Release date changed | Update that edition and release views. Do not regenerate reading traits. |
| Rating count changed | Update that source's rating and local ranking. No content inference is required. |
| Confirmed correction | Recompute dependent exports/recommendations and retain the superseded evidence. |

Priorities: requested/recently viewed books with missing evidence, upcoming releases, series gaps, high-interest uncatalogued titles, then older incomplete records. The persisted queue records leases, attempts, backoff and review states. It runs on the catalog worker, independently of site builds.

Suggested starting refresh policy, to adjust using observed change rates: upcoming releases every 1–7 days, active author/series indexes weekly, recent ratings monthly, stable historical metadata every 3–6 months or on a report. Completed image analysis never expires merely because the calendar changed; only its evidence, model, or rubric changes. Conditional requests can avoid payload downloads when a source supplies ETag/Last-Modified.

## Storage and publishing

For this stage, SQLite with short transactions on a persistent volume is sufficient. `CATALOG_DB_PATH` and `CATALOG_ASSET_DIR` can point outside the checkout. Private GitHub release archives now hold versioned snapshots and cover assets off machine. The archive command verifies that its destination is private; public application commits contain only exported catalog data. Local snapshots alone do not protect against losing the machine.

Use SQLite's [online backup mechanism](https://www.sqlite.org/backup.html), not a copy of the live `.db` file that may omit committed WAL data. `npm run pipeline:backup` creates a new snapshot, checks database integrity, packages cover assets, and records file checksums. Retain versions and periodically restore to a separate location. A new worker must restore this catalog rather than start from an empty database.

Publish validated, versioned JSON and the referenced covers for the static app. The JSON is a read model that can be rebuilt from the database; it is not the sole copy of the source evidence. Builds and browsers never fetch source catalogs or run paid inference. Add Postgres when shared accounts, multiple writers, or a hosted editing API justify it; the entity and evidence model stays the same.

## Implemented in this fork

- SQLite catalog, latest source records, append-only distinct source history, retained inherited evidence, and guarded merging of partial metadata.
- Canonical series/work/edition identity, field-level claims, reviewed publisher-first seeds, cached discovery candidates and exact audiobook verification.
- Persistent source, audio-verification, description, Jev, author and reader jobs, with bounded execution and explicit review states.
- Separate Jev reading profiles, OpenAI image observations, Jev content assessments, and manual overrides.
- Input/model/rubric hashes, stored cover bytes, image refresh intervals, and bounded resumable enrichment commands.
- Atomic per-file exports, missing/invalid date handling, source timestamps, content coverage, and reader-side filters that do not delete records.
- Verified backup bundles containing the database, source history, inference caches, image assets, and checksum manifest. Storage paths are configurable.
- Private remote release archives; complete fetched documents and raw reader evidence stay private. Curated works publish original summaries; inherited records still carry their short retailer listing snippets.
- A series library with work-level progress, released-audio actions, and preservation of older saved reading IDs.

## Remaining work

1. Expand the reviewed registry and fill author/publisher bibliography gaps; do not mistake the retained legacy volume count for verified coverage.
2. Expand reviewed audio bibliography manifests beyond the initial set and monitor known upcoming audio, including delayed and undated releases.
3. Acquire permitted public reader evidence through exact resolved identities, measure sample bias, and validate extracted traits before they influence ranking.
4. Add a small editorial review screen for unresolved identities, series gaps, description conflicts, uncertain content, and corrected labels. The CLI audit and durable review queue already expose these cases.
5. Schedule worker runs and private backups on the chosen persistent host, and regularly verify a full restore. Hosting and shared user accounts remain separate deployment decisions.

The existing catalog remains usable throughout these steps. Classification coverage is measured per dimension; the initial bounded batches do not imply that all books have been assessed.
