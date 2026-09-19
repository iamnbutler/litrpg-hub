# Dated audiobook bibliography coverage

`series.status` describes the story. It cannot establish which audiobooks exist or whether our catalog has every released book. An explicit, reviewed list is the smallest reliable way to make a separate audio assertion. `src/lib/audio-coverage.ts` implements the pure assessment and browser freshness gate. `scripts/backend/catalog/coverage-store.ts` resolves reviewed manifests against retained evidence and the series exporter publishes the result. The library uses the same release-state resolver for progress, bulk actions, and release labels.

## Contract

`assessAudioCoverage({ seriesId, now, manifest, works, editions })` returns an `AudioCoverage` value suitable for `series.audioCoverage`. All timestamps are exact UTC strings. Its public fields include:

| Field | Meaning |
| --- | --- |
| `status` / `current` | Verified, incomplete, unknown, or stale; `current` is convenience at `assessedAt`, not a lasting guarantee. |
| `verifiedAt` | Oldest required primary bibliography observation. Export/model/work update timestamps cannot refresh it. |
| `validUntil` | Exclusive expiry, capped at the earliest scheduled release and freshness of its own audio schedule evidence. |
| `expectedNumbers` | Exact reviewed mainline work-number set, independent of what happened to import. |
| `releasedWorkIds` | Verified canonical works with full audio observed on or after the stated release date; these can be required reads. |
| `scheduledWorkIds` | Verified full audio with a future exact date; these do not put a reader behind. |
| `works` | Selected release state/date and supporting edition IDs, once per canonical work. |
| `sourceUrls` / `manifestId` | Primary bibliography citations and reviewed manifest revision. |
| `issues` | Specific missing works, uncertain dates, unverified audio, stale evidence, or changed bibliography membership. |

The manifest declares a series, numbered-mainline scope, language, accepted marketplaces (for example `US` and `publisher-direct`), explicit `expectedNumbers`, review time, and author/publisher bibliography evidence. Every evidence record names a retained document, URL, observation time, and source type. The caller must supply **all** canonical works for the series, not just works found in the expected list. An unexpected mainline work invalidates the assertion until the list or its scope is reviewed. The pure contract supports an explicitly reviewed `supplement` role; the current loader does not yet project that role. A title heuristic cannot certify an exclusion.

Each accepted edition carries an `AudioEditionVerification` derived from a retained exact retailer product or a primary full-audio product page. It binds the canonical series, work ID and number, language, marketplace, unabridged format, and audio-specific release date to that document. The assessor never reads a generic work release date or a legacy edition date. The pure contract permits publisher-direct editions without ASINs; the current storage loader supports verified US ASIN products only. Buy links, a successful HTTP response, an inherited legacy match, a collection, an episode, and a dramatization cannot establish this proof.

An unresolved date blocks currency for that expected work, including month-only dates. When an already released recording proves the work is available, an undated or future alternate recording does not create another required read. If the only dated recording is in the future and another verified recording is undated, the work's release state remains unresolved.

## Freshness and finality

Active or unknown bibliographies expire after seven days, matching the strategy document's weekly active-index refresh. A reviewed final mainline list can use 180 days **only after every expected full audiobook is strictly verified as released**. `audioCatalogState: 'complete'` requires separate primary `finalListEvidence`; copying `catalog_series.status` is insufficient. A completed story with print-only or undated final audio never qualifies. A final list that still contains scheduled audio uses the active window.

These are conservative product policy defaults, not a promise that no author will publish during the interval. Show the as-of date. Scheduled audio also requires a source observation within seven days; refreshing only the bibliography cannot renew an old preorder. At the next scheduled release, the old assertion expires; an export cannot turn an old preorder into confirmed release just by advancing the clock. Reobserve that exact permitted product/page on or after its release date. No availability-by-country or current purchasing guarantee is implied.

`isAudioCoverageCurrent(coverage, now)` checks the exported status, assessment time, and exclusive expiry. A browser must run the equivalent check using its current clock. For example, an ongoing eight-book series can qualify while fresh; a seven-book catalog missing the reviewed eighth cannot. A verified twelve-book Cradle list can qualify, but deleting book twelve invalidates it despite a contiguous imported list and completed story status.

## What the current storage/export proves

- `catalog_works` establishes canonical work identity. `publication_status` and `first_release_date` may describe print/ebook publication; they are not audio proof.
- `catalog_editions.identifiers_json.verifiedDocument` is written by `importAudioProduct` after `verifyAudioProduct` checks the exact product, author, series/volume, English language and unabridged format. The loader revalidates the newest saved logical US-ASIN response across query variants. Its `workIdentityHash` binds the canonical work title, author, number and identity; routine refresh rejects a changed binding. A nonempty document ID alone is insufficient.
- `importWork` also attaches matching legacy ASINs as audio editions without a `verifiedDocument`. Their existing dates and titles do not satisfy this contract. Its `COALESCE` updates can retain an older generic date when the new source date is absent, so read the selected audio date claim from the verified document instead.
- A future source-only proof adapter can qualify publisher audio after its retained page establishes a full book and audio-specific date. Merely having `format='audiobook'`, a fetched source URL, or a retailer buy link is weaker.
- `exporters/series.ts` currently marks canonical works `verified: true` and groups editions into a public work. That flag means canonical membership; it must not become `audioCoverage` proof. Grouping also takes the earliest edition date, which can include unverified legacy metadata.
- The current audit honestly leaves `catalogCompleteness: 'unknown'`. Its broad operational `confirmedAudio` count includes dramatizations and source-only rows with a fetched URL; do not reuse that predicate for a full-audiobook currency assertion.
- A document's `fetched_at` is the retained payload observation, while `catalog_urls.checked_at` can describe a later successful conditional check. A newer 304 may refresh a reviewed unchanged document only when the checked document ID/content hash still matches the manifest. A new document/hash requires list review. Queue timestamps, inferred summaries, and unrelated source fetches never refresh a bibliography assertion.

## Integration and review

1. Add a small reviewed manifest configuration. Begin with manually checked Cradle's twelve works and any fresh primary ongoing list that has exact audio identities. Keep the author/publisher citations, retained document identities and review dates with the list. Do not derive it from `MAX(number)`, a seed's story status, retailer counts, or the current imported rows.
2. In the exporter, resolve the declared primary evidence to retained documents and actual successful observation times. Build `CoverageWork[]` from the entire canonical series. Revalidate exact retained audiobook products with `verifyAudioProduct`; parse supported primary audio products for source-only editions. Populate proof dates directly from those audio-specific documents/claims, preserving market scope. Missing documents or unresolved identity produce no verification.
3. Call the assessor once per series and export `audioCoverage`. Use the browser freshness gate; an undated boolean cannot replace this assertion. Preserve all series membership for progress; preferences must not prune this evidence input.
4. In library progress, require a current assertion and every `releasedWorkId` read. Keep scheduled work separate. Reading an undated work cannot repair the missing source date. Expired/unknown coverage means “all catalogued books read” can remain true, but “up to date” cannot be asserted. Side-story progress is a separate scope policy and should not be presented as proven by this mainline assertion.
5. On source changes or scheduled release dates, enqueue the existing bounded source/audio verification work. Refresh only permitted known URLs. If new evidence changes membership or finality, require another explicit manifest review; do not silently rewrite the expected set to match imported rows.

## Why review the list rather than guess a publisher count

Publisher pages are good identity evidence, but their counts can combine print, preorder, omnibus, novella, and alternate audio editions. Some series pages omit intermediate books; a contiguous partial scrape cannot expose a missing tail. The retained Cradle research found a publisher series index that misnumbered intermediate volumes and listed a short-story collection after book twelve. These failure modes make counts unsuitable as completeness assertions.

An automated adapter should propose a versioned candidate list, extract evidence, and flag differences from the reviewed manifest. It should not certify its own extraction as exhaustive. The explicit manifest is a small review burden for the core catalog, catches missing imports independently, and supports a future review UI without a database migration now.

The reviewed manifests currently live in `scripts/backend/config/catalog-audio-manifests.json`. An identity-only bibliography imports a canonical work with unknown format; it does not create a pretend print edition. Explicitly documented audio-unavailable tails and reviewed supplement scope remain future extensions. Absence of a buy link is not proof that an audiobook does not exist.
