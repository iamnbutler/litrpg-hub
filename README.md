# 🪎 Shelf Goblin

An audiobook catalog for LitRPG and progression fantasy. Follow series, track the
books you have read, find similar series, and check audio releases. Forked from
[LitRPG Chart](https://github.com/iamnbutler/litrpg-chart).

[Open Shelf Goblin](https://shelfgobl.in/) · [Catalog inspector](https://shelfgobl.in/inspector/)

## Run the app

Use Node 22.9+ and npm. A fresh checkout runs from committed public JSON without a
catalog database, API keys, or the private producer repository.

```sh
npm ci
npm run dev
npm run check
npm run check:worker
npm test
npm run build
```

`npm ci` builds the shared catalog contract before synchronizing SvelteKit. After
changing contract source, run `npm run build:contract` before checking consumers.

The app opens into a compact cover grid with search, filters, series details, and
release views. My library contains followed series; read state belongs to books,
with edition aliases preserving older saved IDs. Future releases and unresolved
audio dates are not silently marked read. GitHub sign-in synchronizes a library
across devices; browsing and a guest library also work without an account.

## App and catalog ownership

| Repository | Owns |
| --- | --- |
| [shelfgoblin](https://github.com/iamnbutler/shelfgoblin) — public | UI, reader accounts and libraries, account Worker, public JSON, shared catalog contract |
| [shelfgoblin-data](https://github.com/iamnbutler/shelfgoblin-data) — private | Acquisition, SQLite and migrations, source evidence, OpenAI/Jev enrichment, quality research, benchmarks, exports, backups |

The app reads `static/data/catalog.json`; the inspector reads
`static/data/health.json`. These are replaceable public snapshots, not the durable
catalog. Builds and page loads never scrape sources or call models. The inspector
scores data completeness and evidence quality, not literary quality. Experimental
book, series, and author rankings remain in the producer until calibrated and
explicitly enabled for readers.

Full source pages, review bodies, reviewer identifiers, model receipts, private
reports, and cached assets stay in the private producer and its archive. Public
exports carry bibliographic facts, cover links, reviewed descriptions,
classifications, and derived reader context. Keep acquisition and model
credentials out of browser code and committed files. Pipeline commands and
restore instructions now live in the
[producer documentation](https://github.com/iamnbutler/shelfgoblin-data).

## Shared catalog contract

[packages/catalog-contract](packages/catalog-contract/README.md) is the single
implementation of public catalog types and pure identity, edition, series,
audio-coverage, and recommendation behavior. The app uses it as a workspace;
`src/lib` retains compatibility re-exports. The producer installs a versioned
public GitHub release archive with an exact URL and lockfile integrity.

```sh
npm run build:contract
npm test
npm pack --workspace @shelfgoblin/catalog-contract
```

To release a contract change, bump its version, build and test it, attach the
package archive to a new immutable
[public release](https://github.com/iamnbutler/shelfgoblin/releases), then update the
producer's dependency and lockfile together. Never replace a released archive or
copy the source into the producer. App builds use the local workspace and do not
fetch a contract release.

## Recurring catalog work

The public repository's `catalog-refresh.yml` runs private producer code on
standard public-repository runners, avoiding private-repository Actions minutes.
It schedules a bounded refresh at **08:17 UTC daily**. Both the workflow and worker
skip **22:00–02:00 UTC**, including delayed and manual starts, and reserve time for
a private checkpoint before 22:00.

An explicitly requested one-off manual refresh can opt into `allow_outside_window`.
It defaults to false, applies only to that dispatch, and is ignored for scheduled
runs. The worker's work and checkpoint time limits remain in force.

`CATALOG_DATA_TOKEN` is provisioned as an encrypted secret in this public
repository: a dedicated fine-grained token scoped to Contents read/write for
**only** `iamnbutler/shelfgoblin-data`, expiring **December 18, 2026**. Rotate it
before expiry. The workflow's `GITHUB_TOKEN` writes only to this public repository.
Paid refreshes use the configured encrypted `OPENAI_API_KEY` and
`TYPESAFE_API_KEY` secrets. The verification-only job reserves its 15-minute
timeout; full refreshes reserve 27 minutes for work and checkpointing.

Manual dispatch defaults to `task=verify`, which installs, type-checks, and tests
the private producer without model credentials. Use `task=refresh` for catalog
work; its manual default `no_enrich=true` skips paid inference. The scheduled
refresh enables the configured bounded enrichment stages.

A refresh restores and verifies the private snapshot, processes selected work,
and saves a private checkpoint before committing allowed public JSON. Private
child logs stay on the ephemeral runner; raw evidence and test output are never
uploaded as public artifacts. Checkpoint failure prevents public publication.
Runner loss can still interrupt a checkpoint, so inspect a failed run before
retrying paid work. Neither Cloudflare nor GitHub Pages deploys automatically
after a catalog commit.

## Accounts and deployment

Cloudflare serves `https://shelfgobl.in/`. The account Worker exchanges GitHub
OAuth codes server-side using state and PKCE; D1 stores account libraries and
hashed session tokens. Library revisions prevent stale writes from silently
replacing newer changes. Guests can explicitly add their local library to an
account, or use export/import. The optional adult-content setting uses a
self-attested date of birth; GitHub sign-in does not verify age.

Production resources retain their compatibility names: Worker `litrpg-hub`, D1
binding `DB`, and database `litrpg-hub-accounts`. Browser storage keys and older
library export formats also remain unchanged. [wrangler.jsonc](wrangler.jsonc)
records the production origin and existing database ID.

```sh
npm run db:migrate          # Apply reviewed account migrations before deployment
npm run secrets:cloudflare # Upload only the two OAuth credentials from .env
npm run deploy:cloudflare  # Build at / and deploy the app + account Worker
```

Register `https://shelfgobl.in/auth/callback/` in the GitHub OAuth app and keep
`SITE_URL` / `OAUTH_GITHUB_REDIRECT_URI` aligned. Deployment is manual. The Pages
workflow is also manual; a repository rename changes its project path. The
`BASE_PATH=/litrpg-hub` CI build tests the historical subpath only and does not
promise that the old Pages URL remains hosted.

The unchanged Worker ID preserves the
[former Workers address](https://litrpg-hub.iamnbutler.workers.dev/) for compatibility.
Browser storage is origin-specific: unsynced old-domain libraries need exporting
there and importing at Shelf Goblin. Synced account libraries remain attached to
the same GitHub identity. Signing in does not automatically combine guest data
with account data.

For local accounts, use a separate development OAuth app with callback
`http://localhost:5173/auth/callback/`. Put its two credentials in ignored
`.dev.vars.local`, run `npm run db:migrate:local`, then start `npm run dev:accounts`
and `npm run dev` in separate terminals. Vite proxies account requests to Wrangler;
local D1 state stays under `.wrangler/`. Browsing needs neither service nor keys.
