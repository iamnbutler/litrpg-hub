# Shelf Goblin

The public app lives at https://shelfgobl.in/. The repository, Worker, database, and browser storage identifiers retain their original `litrpg-hub` names to preserve deployment and library continuity.

## Product and UI

This is a browsing and reading tool. Open directly into the cover grid, with an optional compact list. Preserve the warm, book-focused visual character; do not flatten it into a generic data table. Keep search, filters, shelf actions, and release dates immediately accessible. Book covers supply the visual interest. Use compact app headings and restrained book typography. Do not add marketing heroes, slogans, oversized headline layouts, promotional sections, or a landing page.

## Source integrity

- The Audible catalog API may return HTTP 200 with an empty product array and a positive total when throttled. Treat this as failure; do not advance the successful cursor or replace the catalog.
- The catalog `series` query parameter does not reliably filter by series. Use a verified series webpage, parse its actual product containers, then verify each product's series ASIN and author. Do not scrape arbitrary `/pd/` links, which include recommendations.
- Preserve longer descriptions and nonempty metadata when merging partial responses. Missing dates and narrator names remain unknown. Never invent ASINs to fill series gaps.
- Series identity includes the primary author. Keep editions with different narrators separate. Raw source rows are retained; reader filters do not delete books.
- Run the bounded `pipeline:series` command for a refresh. A blocked or incomplete source stops the job and keeps the existing snapshot.

## Inference

- Jev profiles reading traits and metadata. OpenAI observes covers; Jev combines these observations with the listing.
- Sexualized marketing, on-page explicit content, harem, AI narration, disclosed AI writing, and listing quality are separate. Covers cannot establish story content or AI authorship.
- All inference is explicit offline work. Cache by inputs, image hash, model, and rubric. Never put API keys in browser code or committed files.
- Use bounded runs and inspect token usage. Do not scale a new rubric before checking positive, negative, and ambiguous examples.

## Commands

- `npm run dev` — run the static UI using the committed catalog.
- `npm run pipeline:series -- --series dungeon-crawler-carl --limit 20` — verified series refresh.
- `npm run pipeline:enrich -- --limit 24` — Jev reading profiles.
- `npm run pipeline:covers -- --limit 24` — cover observations and content decisions.
- `npm run pipeline:export` — export the local SQLite snapshot.
- `npm run check`, `npm run check:backend`, `npm test`, `npm run build` — verification.

The independent upstream is LitRPG Chart. Deployment is manual; builds never fetch or call inference APIs.
