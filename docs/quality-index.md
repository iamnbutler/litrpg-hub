# Quality research index

The backend now computes separate book, series, and author records from retained evidence. This is a **research index**, not the site's public sort order. Its current numeric craft estimate measures sentiment in explicit reader comments about particular craft aspects. It has not been calibrated as a universal literary-quality grade.

Star ratings and rating counts do not enter selection, prompts, scores, renown, or benchmarks. Numeric and symbol ratings embedded in comment prose are redacted too. Regression tests change every stored star value and verify identical evidence, jobs, and scores.

## Run and resume

The normal catalog SQLite database holds source evidence, jobs, paid responses, and versioned results. `TYPESAFE_API_KEY` comes from the ignored `.env`. Scoring, exporting, and benchmarking make no model calls.

```sh
npm run pipeline:quality -- plan --series dungeon-crawler-carl
npm run pipeline:quality -- run --series dungeon-crawler-carl --limit 20
npm run pipeline:quality -- score
npm run pipeline:quality -- benchmark
npm run pipeline:quality -- status
npm run pipeline:quality -- show --series cradle
npm run pipeline:quality -- show --work work-cradle-1
```

`plan` selects current evidence and queues one review per durable job. `run` claims a bounded number of jobs; repeat it to resume. Changed or removed inputs are checked before spending. Successful HTTP bodies commit before parsing. A retained invalid response parks for review instead of being bought repeatedly. Model/rubric/input hashes isolate experiments, while deterministic interpretation can re-read stored distributions without a new call. Token totals count purchases once and distinguish responses with unknown usage from free cache hits.

Default artifacts live under ignored `data/quality/`. `export --out PATH` opens SQLite read-only and writes only a derived report. Neither command changes `static/data/catalog.json`, deploys an app, or puts private review text into a public build. The public refresh workflow does not run quality inference.

The private quality selector includes spoiler-marked reviews because specific discussion of plot construction can be useful evidence. Those flags remain attached to private evidence; quality reports contain no review text or quotations. The public reader-impressions selector still excludes spoilers. Deduplication, whole-comment bounds, and rating redaction apply before inference.

## What the numbers mean

Craft has six axes: prose 20%, editing 15%, coherence 20%, structure 15%, pacing 15%, and unnecessary repetition 15%. Audio performance is assessed separately. A deliberate cozy pace, disliking a character, erotic content, and an unsupported AI-authorship allegation are not writing defects.

Each accepted review judgment needs its own direct-relevance and polarity support. The retained grade distribution maps exceptional/good/mixed/poor/severe to 100/75/50/25/0. Unknown probability is not converted to a neutral opinion. A concentrated estimate spanning adjacent grades can contribute an uncertain direction; `uncertainVoices` stays separate from readers explicitly reporting mixed execution. Dispersed or opposing estimates remain withheld. An aspect needs three independent voices; a diagnostic overall point needs two qualifying aspects and five distinct relevant voices. The entire selected sample must finish before a point is emitted, so worker order cannot determine scores.

The point is the weighted mean of **observed** axes. Missing axes widen sensitivity bounds and lower coverage; they do not lower the point or count as absence of a defect. These bounds are not statistically calibrated confidence intervals. A 60 based only on plot and pacing cannot be compared fairly with a 60 based on all six axes. Always inspect dimensions, coverage, and uncertainty. `policy.publicRankingEnabled` remains false.

Series average assessed books equally. Authors average assessed series equally, using only verified individual credits; a prolific series cannot dominate merely by having more books. Coauthored output remains joint output. Missing known works lower coverage and confidence. A contiguous or fully assessed known list is not assumed to be an exhaustive bibliography. A later-volume trend needs comparable early and late dimensions; missing late reviews never establish decline.

The separate preference index retains every adjustment:

- Explicit/harem preferences can deduct up to 10 points; sexualized marketing up to 6. Overlapping content deductions use the maximum, not their sum. They leave craft unchanged and are configurable in the scoring API.
- Individually sourced recognition can add at most 5 points. Repeated publicity does not stack, star popularity is excluded, and recognition does not create missing craft evidence.
- Rapid publication is context, not a drafting-speed measurement. A capped production-risk adjustment requires verified original-publication dates, evidence ruling out serial/back-catalogue/reissue batching, and independent craft defects. Audiobook release dates cannot trigger it. The live adapter currently lacks that original-publication proof and applies no cadence penalty.

## Benchmarks and current limitations

[benchmarks.json](../scripts/backend/quality/benchmarks.json) holds the user's qualitative reference series, explicitly labeled numeric guestimates, and invented scoring controls. Targets never enter a model prompt or scoring inputs. [Research notes](quality-benchmarks.md) retain primary links and scope for recognition/cadence claims.

The first core trial completed 308 selected review judgments. Five books cleared the minimum diagnostic gate, all on structure and pacing only. DCC and Cradle therefore produced narrow, low-confidence estimates outside the proposed high-quality bands; Primal Hunter and Heretical Fishing lacked enough qualifying axes. This is a failed calibration attempt, not a finding that those series are mediocre. The gate/scale and the requested overall-quality construct are not yet aligned.

After including eligible private spoiler reviews and reinterpreting stored probabilities without repurchasing them, the current snapshot has 323 judged reviews, six diagnostic book estimates, two series estimates and two author estimates. The index retains all 397 known works, 51 series and 48 author identities, with unknown scores where evidence does not suffice.

A manual audit of 16 retained comments found both genuine sparse evidence and real classification mistakes: aspect spillover, missed brief character-development praise, and confusion between this-volume praise and series-wide criticism. The audit is purposive, not an unbiased error-rate estimate. No thresholds were lowered just to make famous titles score higher.

There is no verified real low-quality AI-written audiobook anchor yet. Synthetic poor-editing and incoherence cases exercise the low end without labeling a real author from a cover, publication schedule, or suspicion. Heretical Fishing's later decline remains a hypothesis pending later-volume evidence. A separate real holdout and an empirically justified mapping to overall quality remain required before public ranking.

## Actual-model regression examples

```sh
npm run pipeline:quality:eval -- --report
npm run pipeline:quality:eval -- --run --limit 16
```

Sixteen invented examples exercise craft praise/defects, explicit mixed prose, audio-only claims, taste, erotic preference, unsupported AI accusations, rapid-release inference, and prompt injection. They are rubric-aware regressions, not a blind accuracy benchmark. The first actual Jev run passed 15/16; a coherence-only defect also received a structure penalty. That failure stays visible rather than being relabeled after seeing the answer.

The tool uses only private `data/quality/eval.db`, refuses existing unmarked databases, and never feeds synthetic rows into the catalog. Default reporting makes no calls or writes. Paid fixtures replay free; changing expected answers does not repurchase identical model inputs.

## Extractive classifier comparison

```sh
npm run pipeline:quality:claims -- report --series dungeon-crawler-carl
npm run pipeline:quality:claims -- run --work work-dungeon-crawler-carl-1 --limit 12
npm run pipeline:quality:claims -- report --out data/quality/claims-report.json
```

This separate experimental path asks OpenAI for aspect/polarity claims tied to literal spans in a retained review. The default is `gpt-5.6-terra` with low reasoning; `--model` creates a separately cached experiment. An explicit scope and a bounded number of uncached attempts are required to spend. Reports expose labels and coverage; source quotations and rationales stay in private receipts. These results do **not** currently feed scores.

In a bounded comparison on 16 invented examples plus 16 purposively selected real comments, GPT-4.1 mini produced seven invalid extractions. Terra produced valid literal spans for all 32 and passed all 16 invented examples. Reading the real comments still found semantic errors: a literal citation does not prove its aspect mapping, and a one-sided quote can omit a relevant qualification elsewhere in the comment. This is not an unbiased accuracy estimate.

`claim-verifier.ts` adds a separately cached Jev audit of existing extractions. Its exported `planQualityClaimsVerification`, `loadVerifiedQualityClaims` and `processVerifiedQualityClaims` functions never acquire comments or buy extraction. The verifier sees the entire blinded review and the proposed quotes, without the extractor's rationale. It asks whether the evidence supports the exact aspect/polarity and whether the polarity includes all material opposing claims. Both probabilities must reach 0.85; otherwise the candidate remains `needs-review`, with no automatic rewrite. The receipt binds the extraction, source input, models and questions. Verification remains a private classifier comparison rather than a public quality claim. In the first 16-comment trial, only 3 of 31 candidates cleared both gates; the others went to review. This exposed substantial false-rejection risk, so passing invented examples has not been treated as evidence that the combined classifier is ready. Replaying all 16 verifications made zero model calls and reported zero new tokens.

## Storage and the DB repository

SQLite `quality_index_runs` and `quality_index_scores` preserve content-addressed snapshots. `quality_index_head` records currentness separately: A → B → A reuses immutable A while advancing the current pointer. Older input cannot rewind it. Existing catalog backup/archive commands include these tables and the paid receipts.

An optional aggregate-only PostgreSQL importer was also implemented and exercised in the sibling `litrpg-db` checkout. Its remote repository is archived; this adapter is a local prototype, not the application's production data store. The active catalog continues to use SQLite and the private `litrpg-hub-data` archive:

```sh
cd ../litrpg-db
bun run quality inspect --file ../litrpg-hub/data/quality/index.json
bun run quality import --file ../litrpg-hub/data/quality/index.json --dry-run
bun run quality import --file ../litrpg-hub/data/quality/index.json --write --apply-schema
bun run quality query --kind series --metric craft
```

The import never writes canonical book/series/author rows or adult-content flags. It retains all three external identities even when no safe local binding exists. Books bind only by verified source ID plus author; ambiguous or absent bindings stay unresolved. Raw comments, per-reader identifiers, rating fields, and credentials are rejected or excluded at the import boundary. Its snapshots and scores are immutable, with a separate current-head table and explicit historical queries. See that repository's `docs/quality-index.md` for the contract.
