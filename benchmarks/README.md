# Issue #6 evaluation evidence

`datasets/issue6-pilot-subset-v1.json` contains **actual** sanitized candidate
observations from the private issue6-pilot-v1 capture, not generated release titles.
The source capture has 12 works, 38 exact requests and 2,010 observations. This
publishable subset retains 262 within-case physical candidates; each exact response
lists retained IDs in original upstream order and reports its original count.
The same ID preserves duplicate observations across queries within a case.
Unretained results are omitted, **not** negative labels. No global deduplication
across the two separate capture windows is asserted.

## Privacy and review

- Only the public anime and public general-purpose sources are retained; adult
  source evidence is excluded. No private/semi-private tracker or library export.
- Original release URLs, magnets, GUIDs and hashes are absent. Even checksum-like
  title tags are removed. Source pseudonyms and reassigned sequential IDs replace
  capture identifiers. Numeric size/health metadata is observed, not verified.
- All retained titles were inspected by the assistant; the human approved the
  targeted identity judgments, Blue Box TVDB mapping, multi-acceptable rubric,
  inferred-season-pack acceptance, and publication/provider disclosure in this
  session. This is assisted annotation with targeted human review, **not** an
  independently audited file-content ground truth or a copyright license for
  media. The small factual metadata subset contains no media content/artwork.
- Documentary `To End All War Oppenheimer The Atomic Bomb` is a different work;
  LEGO Batman and Dark Knight Returns are distractors for The Batman (2022).
  Explicit wrong seasons are unacceptable. Matching-season-only packs can be
  acceptable with **inferred** coverage, never proof of contents. Ambiguous
  bracketed/multilingual episode claims remain uncertain and unscored.
- Preferences for this label revision are suitability first, no mandatory codec,
  resolution or language winner. Multiple plausible releases and useful partial
  episode coverage are acceptable. Preference tiers are not human-ranked here.

## Limits

This is a deterministic first-eight/highest-seeder-eight per-query subset, unioned
before projection; sampling is not based on labels. Overlap can leave fewer than
16 retained rows per query. It preserves distractors but is not representative of
all search traffic. Empty responses remain exact captured observations with
unknown upstream completeness, not proof of global absence. Query recall is at
most **subset-pool-relative**, never indexer-wide. New query strings, categories,
indexers or limits are unsupported, not simulated with substring search.

Public TVDB/Skyhook and TMDB metadata supplied identities; anime aliases came from
the public sources recorded in the [capture report](../docs/investigations/issue-6-benchmark-pilot.md).
The eight/four franchise split was exposed during annotation; it is not a blind
holdout for future prompt tuning. Queue-association inputs synthesized from this
evidence must be labeled mixed provenance, not captured production queue rows.

Regenerate proposed annotations offline with `tools/benchmark_fixture.py`.
`--reviewed` records this specific pilot's approved rubric; never use it to bless
a different capture. Any relabeling creates a new immutable dataset revision.
