# Discovery experiments

The implemented path is deliberately inspectable: publisher metadata → independent Jev judgments → cached profiles → weighted matching in code. Read [TypeSafe primitives](https://docs.typesafe.ai/primitives), [confidence](https://docs.typesafe.ai/confidence), and [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring) for the API model.

## First slice

- **Taste profiles:** stats, action, humor, cozy tone, worldbuilding, crafting/building, politics, and found family. Each is a five-level rubric with confidence. The first live batch assessed 24 popular series entry points with `jev-1.13.0` (49,267 input and 6,861 output tokens).
- **Similar to:** compare confident profile dimensions, weight the traits a reader values, and show the strongest shared positive traits. Shared absences have lower weight. Genre overlap fills in missing profiles; those results are labeled separately.
- **Content preferences:** distinct explicit-content and harem choices with a real unknown category. Direct source disclaimers take priority. Jev listing-quality signals are review flags, not claims of AI authorship.
- **Source hygiene:** preserve provenance and missing values, show uncertain dates, avoid matching books just because a title is similar, and keep the current snapshot when scraping is incomplete.

## Promising next experiments

1. **“DCC, but…”** Parse a request into independent preferences: humor required, explicit content unwanted, stats optional, found family preferred. Rerank a small candidate set rather than attempting one giant book-selection prompt.
2. **Personal recommendations:** combine several four/five-star books on a reader’s shelf. Keep multiple taste clusters (a cozy mood and an action mood) rather than averaging everything into one bland profile. Do this locally using the existing cached profiles.
3. **A stretch pick:** deliberately relax one low-priority dimension while preserving the reader’s non-negotiables. Explain the tradeoff: “less numerical progression, more found family.” Do not present an arbitrary matching score as a probability that someone will enjoy a book.
4. **Series continuity:** assess whether a new volume or alternate edition belongs to a series only after stable IDs/author checks have generated candidates. Jev can flag a suspicious match for review; it should not silently merge records.
5. **Useful content notes:** enrich with full publisher descriptions and verifiable warnings. Keep romance prominence separate from graphic sex, and harem separate from a cast with several women. Explicit “no harem” statements make good regression cases.
6. **Quality triage:** add independent signals for incoherent listings, repeated descriptions across titles, metadata contradictions, and publisher-disclosed generation. Combine these into a review queue. A model’s sense that prose is generic must never become proof of AI authorship, and AI narration must not be conflated with AI writing.

## Evaluate before scaling

Create a small labeled set covering established books, new authors, translated fiction, explicit and non-explicit romance, genuine harem, no-harem disclaimers, absent narrators, virtual voice, unrelated series with shared names, and incomplete descriptions. Keep a held-out group when changing rubrics. Measure false positives and unknown coverage separately for each content dimension; choose thresholds from those results rather than trusting raw confidence as an accuracy guarantee.

For discovery, collect pairwise reader judgments (“which would you try next?”), track series leakage and author repetition, and compare taste matching to the genre-only baseline. Test that changing each slider changes the expected ranking. Evaluate both false similarities and missed connections. The first 24 profiles demonstrate the integration, not recommendation quality across the whole catalog.

Fetch richer evidence before spending on catalog-wide inference. Short marketing blurbs cannot establish absence of sexual content, writing quality, authorship, or every reading trait. The current short descriptions lead to many appropriate unknown content judgments. Preserve that uncertainty and show coverage in the UI.

## Cover evidence trial

The added path is cover bytes → GPT-4.1 mini visual observations → Jev + book metadata → cached reader-filter signals. Image observations are cached independently from content decisions so a new Jev rubric does not require another vision call. The actual image bytes are stored too, allowing a new vision rubric to run without scraping the cover again.

The first 28-cover trial used `gpt-4.1-mini-2025-04-14`: the two reported failures (Born to Rule, ASIN B0GPFWKVMM, and Master Blacksmith, B0GPFWTMM9) were both classified as sexualized marketing at 0.90 estimated confidence. Dungeon Crawler Carl, Legends & Lattes, and the other 24 popular-series covers were not flagged. This is a smoke test, not a measured catalog-wide accuracy rate. Expand the reviewed evaluation set with ambiguous sensual styling and action covers before tuning thresholds or scaling.

The visual rubric includes clothed pin-up composition, deliberately emphasized anatomy, and sexualized costumes; nudity is not required. It excludes inferences about on-page sex, harem, prose quality, or AI authorship. Ambiguous covers stay unclassified. Reader preferences show coverage and preserve these separate dimensions.
