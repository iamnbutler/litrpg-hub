# Catalog ownership and publication

The durable catalog and its production tools live in private
[shelfgoblin-data](https://github.com/iamnbutler/shelfgoblin-data). Its
[catalog strategy](https://github.com/iamnbutler/shelfgoblin-data/blob/main/docs/catalog-strategy.md)
covers acquisition, canonical records, retained evidence, progressive enrichment,
job queues, and backups. Run those tools in the producer checkout.

The public app consumes `static/data/catalog.json` and
`static/data/health.json`. These are derived snapshots; they cannot reconstruct
source history or paid inference receipts. A failed source or export must not
replace a working public snapshot with empty data. Source pages, review bodies,
model responses, and private databases never belong in this repository.

The shared
[catalog contract](../packages/catalog-contract/README.md)
owns public types and pure identity, series, edition, audio-coverage, and
recommendation behavior. The app uses its workspace; the producer installs an
immutable versioned archive. Retain stable IDs and aliases when catalog data
changes so existing libraries continue to resolve.

Reader accounts and library synchronization remain in the app's Cloudflare
Worker and D1 database. Their migrations are independent of producer migrations.
Builds and browsing never acquire source data or call models. See the
[app README](../README.md) for the public scheduled runner, publication boundary,
and automatic Cloudflare deployment of verified catalog commits.
