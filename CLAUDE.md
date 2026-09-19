# Shelf Goblin

The public reader app lives at https://shelfgobl.in/ and its repository is
`iamnbutler/shelfgoblin`. Cloudflare Worker `litrpg-hub`, D1 database
`litrpg-hub-accounts`, binding `DB`, browser storage keys, and legacy-origin
handling are compatibility identifiers. Do not rename them as cosmetic cleanup.

## Product and UI

This is a browsing and reading tool. Open directly into the cover grid, with an
optional compact list. Preserve the warm, book-focused visual character; do not
flatten it into a generic data table. Keep search, filters, library actions, and
release dates immediately accessible. Book covers supply the visual interest.
Use compact app headings and restrained book typography. Do not add marketing
heroes, slogans, oversized headline layouts, promotional sections, or a landing
page. Keep pipeline terminology out of reader-facing text; technical details
belong in the catalog inspector or producer tools.

## Repository boundary

- This repository owns the UI, reader accounts, libraries, Cloudflare Worker,
  committed public JSON snapshots, and the public catalog contract package.
- [shelfgoblin-data](https://github.com/iamnbutler/shelfgoblin-data) is private and
  owns acquisition, SQLite, migrations, source evidence, enrichment, scoring,
  benchmarks, exports, and backups. Make producer changes there.
- Browsing and builds consume `static/data/catalog.json` and
  `static/data/health.json`. They never fetch source pages, open the private
  database, or call inference APIs. Never copy private comments, source bodies,
  model responses, or API credentials into this repository.
- `packages/catalog-contract` is the single implementation of shared pure types
  and behavior. `src/lib` compatibility modules re-export it. Build it before
  checking consumers; publish versioned immutable package archives for the
  producer, with an exact dependency and lockfile integrity. No sibling-checkout
  imports or copied implementations.

## Reader data and evidence

Preserve work/edition/series aliases and browser storage keys so saved reading
history survives catalog changes. Missing data remains unknown. Sexualized
marketing, explicit scenes, harem, AI narration, disclosed AI writing, and listing
quality remain separate; covers cannot establish story content or AI authorship.
Filters never delete source records or library history. Reader opinions are
distinct from publisher facts, and experimental quality scores are not a public
ranking until calibrated and explicitly enabled.

## Commands and automation

- `npm ci` builds the contract workspace and synchronizes SvelteKit.
- `npm run dev` uses the committed public catalog; accounts are optional locally.
- `npm run build:contract` rebuilds changed shared contract source.
- `npm run check`, `npm run check:worker`, `npm test`, `npm run build` verify the app.
- `npm run db:migrate` applies reviewed account D1 migrations.
- `npm run deploy:cloudflare` manually deploys the canonical app and account Worker.

The public catalog workflow runs private producer code on standard public
repository runners at 08:17 UTC. It requires a separately provisioned
`CATALOG_DATA_TOKEN` scoped to private-repository Contents read/write. Neither
private logs nor raw artifacts may be published. Recurring and manual producer
runs must skip 22:00–02:00 UTC and reserve enough time to checkpoint before 22:00.
An explicit user request can authorize the one-run `allow_outside_window` input
for a manual refresh. Do not enable it routinely; scheduled runs cannot use it.
Snapshot publication does not automatically deploy Cloudflare or GitHub Pages.

The independent upstream is LitRPG Chart. Production deployment remains manual.
