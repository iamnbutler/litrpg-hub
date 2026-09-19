# Quality benchmark notes

Research checked on 2026-09-19. The machine-readable companion is
`scripts/backend/quality/benchmarks.json`. These are calibration expectations and
regression controls, not measured quality verdicts about the named books.

## What the benchmark measures

Keep three outputs separate: evidenced craftsmanship, the current reader's fit
preferences, and evidence coverage/confidence. A well-edited erotic novel can have
high craftsmanship and a poor fit for a reader avoiding erotic content. An obscure
novel can have excellent craft and no renown evidence. Neither case is contradictory.

The craft dimensions are prose, editing, coherence, structure, pacing, and repetition.
Pacing means whether scenes and explanations serve the work's intended shape; it
does not mean that fast action is better than a deliberate slice-of-life story.
Character consistency and earned development can support coherence/structure.
Liking a character, enjoying a trope, preferring another genre, star ratings, and
rating counts do not support craftsmanship. A mention of slow pacing without an
explained defect may be taste evidence rather than craft evidence.

Unknown is not a low score. Metadata completeness belongs in the catalog inspector;
it affects confidence in a quality assessment, not the quality of the story.

## Initial series expectations

The user identified the first three series as high quality and Heretical Fishing as
upper-midrange, with a reported later decline. The numeric bands below are agent
guestimates translating that qualitative brief into broad calibration targets.
They are not the user's exact numbers, community consensus, or conclusions of this
research. The decline is a hypothesis to test with volume-specific evidence.

| Series | Proposed craft band | Basis | Limitation |
| --- | ---: | --- | --- |
| Dungeon Crawler Carl | 85–100 | User's high-quality anchor | Does not assert every volume scores this highly. |
| Cradle | 85–100 | User's high-quality anchor | A strong ending cannot be inferred from book-one comments. |
| The Primal Hunter | 80–95 | User's high-quality anchor | Genre enjoyment alone cannot establish execution quality. |
| Heretical Fishing | 60–79 | User's upper-midrange anchor | Later decline has not been independently established here. |

These series IDs and their works were checked against the local canonical database.
There are no automatic author-wide or every-book targets: a judgment about a series
does not judge an author's unrelated work. The benchmark should print a mismatch
or an evidence gap rather than alter a measured score to hit an anchor. Compare
craft against these bands, then separately show the preference-adjusted index.

## Renown evidence, with scope and dates

Renown is a small, optional discovery prior, capped at five index points. It must
not change the base craft score or create one where craft evidence is missing.
An absent renown record is neutral. Repeated marketing copies of one event count
once, including copies across publisher, author, and retailer sites. A series
claim must not be applied independently to every volume, and an author credential
must not be copied down to every book. When work scores aggregate upward, do not
count the same recognition again at the parent.

* **Dungeon Crawler Carl, book one:** Books-A-Million announced its inaugural 2025
  Book of the Year selection on **2025-11-04**. This is the retailer's own selection,
  based on bookseller enthusiasm; it is not a juried literary award or an audiobook
  performance award. The originating announcement establishes the recognition
  independently of star ratings. [Books-A-Million announcement](https://www.prnewswire.com/news-releases/books-a-million-names-dungeon-crawler-carl-as-inaugural-book-of-the-year-302604458.html)
* **Dungeon Crawler Carl, book one:** Penguin Random House labels the book a New
  York Times bestseller. This is a publisher-reported bestseller claim; the exact
  chart date and position were not established from this page. Treat it accordingly,
  rather than inventing an event date from the edition's publication date.
  [Publisher book page](https://www.penguinrandomhouse.com/books/772002/dungeon-crawler-carl-by-matt-dinniman/)
* **Cradle, series:** Will Wight's official series page describes Cradle as a New
  York Times bestselling series. It is an author/publisher claim about the series,
  not independent proof that every volume charted. Its event date is unknown.
  [Official series page](https://www.willwight.com/cradle.html)
* **Dreadgod, book eleven:** In a **2022-06-21** post, Wight reported the audiobook
  at number four on Audible's bestseller list while on preorder. That date belongs
  to the historical claim; it is not a current chart position or an award.
  [Dreadgod preorder announcement](https://www.willwight.com/a-blog-of-dubious-intent/dreadgod-pre-order-is-live)
* **The Primal Hunter, series:** Aethon's **2023-01-18** WEBTOON announcement calls
  the series an Amazon Top Charts bestseller. The post dates the publisher's claim,
  not the unspecified chart event. Its adaptation announcement corroborates market
  visibility, not literary quality. [Publisher announcement](https://aethonbooks.com/2023/01/18/aethon-partners-with-webtoon-for-origincomic-adaptations/)

No renown points are awarded for Heretical Fishing's publisher-reported Royal Road
Rising Star position: the ranking mechanism has not been checked to exclude rating
signals. It remains useful series identity and publication evidence, without being
a back door for ratings. [Podium series page](https://podiumentertainment.com/series/1893/heretical-fishing)

## Release cadence needs provenance

An audiobook release date records an edition becoming available. It is not a clock
measuring how long the author wrote the book. Keep format, first-publication role,
source, and reissue/backlog status with every date. Collapse editions and collections
before calculating intervals. Missing first-publication evidence stays unknown.

Two concrete counterexamples matter for these very anchors:

* Zogarth's own Primal Hunter page advertises five chapters a week averaging 2,500
  words. That is approximately 100,000 words over eight weeks if sustained
  (arithmetic from the stated schedule, not a measured historical production rate).
  An eight-week release interval alone cannot disqualify this high-quality anchor.
  [Author's Royal Road listing](https://www.royalroad.com/fiction/36049/the-primal-hunter)
* On **2023-01-31**, Will Wight said both Waybound and his new space-fantasy book
  were nearing completion of their drafts. His **2023-03-02** announcement named
  The Captain for April 4 and Waybound for June 6. Those releases were 63 days apart,
  but the earlier post shows overlapping work rather than a new book composed from
  scratch between release dates. [January progress report](https://www.willwight.com/a-blog-of-dubious-intent/archives/01-2023),
  [March release announcement](https://www.willwight.com/a-blog-of-dubious-intent/announcing-the-captain-and-nothing-else)

Rapid cadence can prioritize evidence collection. Any index adjustment should need
verified original-work chronology, excluded backlog/reissue explanations, and
independent craft-defect evidence. Never infer AI writing from speed.

## The low-end benchmark gap

This bounded search did **not** establish a defensible set of low-craft LitRPG
audiobooks with verified AI-generated writing. There is no real-book "AI slop"
negative label in this benchmark. Anonymous accusations, cover appearance, model
name recognition, output frequency, and AI-detector guesses are not sufficient.

There is a real **disclosure-format control**, without a quality label: the author's
Royal Road listing for *WORTHLESS: A Dungeon Merchant LitRPG* by Jon Pettner carries
the platform's AI-Generated Content warning. This establishes the displayed
disclosure only; it does not establish what proportion of the prose was generated,
craft quality, or an audiobook edition. It is outside the audiobook calibration set.
[Author's listing](https://www.royalroad.com/fiction/190302/worthless-a-dungeon-merchant-litrpg)

Likewise, Amazon defines Virtual Voice as computer-generated narration. That says
nothing by itself about authorship of the underlying text or its craftsmanship.
[KDP explanation](https://kdp.amazon.com/en_US/help/topic/GFAQU3LUEHCRB8KD)

Negative controls therefore use clearly invented fixtures with specified editing
defects, repetitive padding, and incoherent progression. They are engineering
regressions, not reviews of disguised real authors. Controls also include strong
erotic writing, fast releases of a backlog, deliberate cozy pacing, sparse evidence,
and a declining multi-volume series.

## How to report evaluation honestly

1. Freeze the input selection, evidence hashes, rubric, preferences, and scoring
   version for each run. Report the assessed works and volumes, not just a series
   title beside a number.
2. Run deterministic controls for rating invariance, format/edition duplication,
   sparse evidence, content/craft separation, capped renown, and unequal author
   bibliography sizes. These test implementation behavior.
3. Run the four real series anchors as calibration diagnostics. Print observed
   score, target band, data coverage, and missing dimensions. A missing score is
   an acquisition gap, not a passing result or a zero. Do not use the target in
   model prompts or score calculation.
4. Collect an independently reviewed real holdout spanning quality levels,
   volume positions, genres, popularity, and publishing models. Multiple reviewers
   should judge evidence without title/author/ratings where feasible. Resolve
   disagreements explicitly and retain the original judgments. Freeze this set
   before tuning the next scoring version.
5. Test falloff with comparable early, middle, and late volume evidence. Book-one
   comments alone cannot validate a series trend. A long prolific series must not
   overwhelm a short second series when scoring the author.

The visible synthetic fixtures are not a blind holdout, and matching four chosen
favorites does not validate the model. Do not publish accuracy, precision, or
confidence-interval claims until there is an independently labeled evaluation set.
Current ranges are sensitivity bounds and broad editorial expectations.
