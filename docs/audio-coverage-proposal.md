# Audiobook coverage in the app

Story completion and audiobook completeness are separate facts. A completed
story, a contiguous imported list, or a reader finishing every listed book does
not prove the audiobook bibliography is complete.

The shared
[`audio-coverage` contract](../packages/catalog-contract/src/audio-coverage.ts)
implements the pure assessment and freshness gate. The app's
`src/lib/audio-coverage.ts` is a compatibility re-export. The private producer
resolves reviewed manifests and retained audiobook evidence before exporting
`series.audioCoverage`; its
[design and review process](https://github.com/iamnbutler/shelfgoblin-data/blob/main/docs/audio-coverage-proposal.md)
lives with that code.

## Public contract

| Field | Meaning |
| --- | --- |
| `status` / `current` | Verified, incomplete, unknown, or stale; `current` describes the assessment time only. |
| `verifiedAt` | Oldest required bibliography observation, not a new export timestamp. |
| `validUntil` | Exclusive expiry, including the next scheduled audio release. |
| `expectedNumbers` | Explicit reviewed mainline list, independent of the imported rows. |
| `releasedWorkIds` | Works with confirmed released full audiobooks. |
| `scheduledWorkIds` | Confirmed future audiobooks; these do not put a reader behind. |
| `works` | Release state, date, and supporting editions, once per work. |
| `sourceUrls` / `manifestId` | Bibliography sources and reviewed revision. |
| `issues` | Missing works, unresolved audio, stale evidence, or changed membership. |

The browser calls `isAudioCoverageCurrent(coverage, now)` using its current clock.
An exported `current: true` is not timeless. The library shares the contract's
release-state resolver for progress, bulk read actions, and release labels.
Unknown dates, expired coverage, and unverified membership remain unresolved;
marking books read cannot repair missing source evidence. Preferences never prune
the series membership used to calculate progress.

Active or unknown bibliographies have a seven-day freshness window. A reviewed
final mainline list can use 180 days only when every expected full audiobook is
confirmed released. A completed story alone cannot earn that window. Scheduled
audio needs current evidence of its own, and reaching a preorder date requires a
new observation before the app treats the recording as confirmed released.

The producer's original full-audio identity checks, retained documents, review
registries, and source jobs remain private. The app does not reproduce them or
start a crawler when a reader refreshes the page. An audio-coverage assertion is
not a guarantee of present purchase availability in every country.
