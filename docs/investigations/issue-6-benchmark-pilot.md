# Issue #6: bounded real-release capture pilot

Backlog: [LLM benchmarks #6](https://github.com/aberiggs/media-scout/issues/6).
This is dataset preparation, not a model-quality result or a completed in-app
benchmark feature. Related prompt/query improvements remain in #15.

## What was authorized and done

The user authorized live Prowlarr calls and model calls if needed, revised the
pilot to four anime/four US shows/four movies, and identified the production DB
on the approved SSH host as the connection-settings source. Settings were read
through SQLite read-only/query-only access. No DB copy, personal library export,
daemon/cycle, settings change, grab, download-link fetch, or deployment occurred.
No model calls were needed or made; model quality and costs remain unmeasured.

The standalone Python capture utility runs where the services and SQLite DB are
reachable without installing app dependencies on that host. It is not part of
the TypeScript runtime. See [capture workflow](../benchmark-capture.md).

## Target manifest and provenance

The frozen [query manifest](../../tools/benchmark-manifests/pilot-v1.json) contains
52 query slots, 50 distinct query/category requests after exact deduplication.
It records retrieval hypotheses, not prescribed exact planner outputs.

| Cohort | Works | Target metadata |
|---|---|---|
| Anime | Blue Box; Frieren; The Apothecary Diaries; One Piece | TVDB 429934/S02E01/absolute 26; 424536/S02E01/29; 431162/S02E01/25; 81797/S22E01/1086 |
| US TV | The Bear; Abbott Elementary; Severance; The Last of Us | TVDB 403294; 402910; 371980; 392256; each S02E01 |
| Movies | Dune: Part Two; Everything Everywhere All at Once; The Batman; Oppenheimer | TMDB 693134/2024; 545611/2022; 414906/2022; 872585/2023 |

TV identity/season/absolute mapping came from public Sonarr/Skyhook TVDB metadata,
not the personal library: `https://skyhook.sonarr.tv/v1/tvdb/shows/en/{tvdbId}`.
The Blue Box feed reported S02E01 aired October 4, 2026, making it a seasonal
sequel case at this observation time. Its MAL title page confirms Ao no Hako /
Blue Box. Public MAL title search corroborated Sousou no Frieren and Kusuriya no
Hitorigoto. Those aliases do not establish season mappings; TVDB metadata does.
Movie identity/year was verified through read-only Radarr public-metadata lookup.
No artwork, descriptions, personal library paths or ownership records were saved.

## Source calibration and retained evidence

The initial two selected public-classified sources were anime-focused, including
an adult variant. Capability category IDs alone were insufficient to recognize
that source-purpose mismatch. The adult source was excluded entirely from the
retained dataset, and anime-source TV/movie results were not used as general-media
availability evidence. Future runs must inspect source identity/purpose as well
as enabled/healthy status, privacy and category capabilities **before capture**.

A public general-purpose source then timed out at the 30-second wall deadline;
that attempt was recorded unavailable and stopped, not retried or scored empty.
One alternative public general-purpose source completed the 16-query TV/movie
follow-up. No private/semi-private source was queried. Each run checked source
status before and after search and used no automatic search retries.

| Retained cohort | Exact queries | Stored release observations | Within-capture physical IDs |
|---|---:|---:|---:|
| Four anime, anime source only | 22 | 971 | 626 |
| Four US shows + four movies, general source | 16 | 1,039 | 815 |
| Total | 38 | 2,010 | 1,441 |

Physical equivalence is established only within each capture, not globally across
the two capture windows. Counts are observations, not accepted candidates. The
full completed source runs recorded 66 successful searches plus one timed-out
attempt; the earlier owned capture interrupted for safety corrections produced no
usable artifact and its request count was not retained. Do not describe 67 as the
complete session request total. Caps apply per capture, not retroactively to that
unrecorded exploratory interruption.

All responses remain **upstream-completeness-unknown**, including successful
empty arrays. A source can fail silently or impose its own result cap; local
storage limits do not bound upstream indexer work. No exhaustive recall claim is
supported. Captures were not paired simultaneous model comparisons.

## Useful observations, not yet scores

- Blue Box's verified seasonal and absolute numbers are both legitimate inputs.
  On the retained anime source, `Blue Box S02E01` returned 14 rows and the
  romanized seasonal query returned 15. `Blue Box 26` returned 75, including
  titles explicitly advertising other episodes. More results is not better
  precision and does not establish target coverage.
- One Piece `S22E01` returned zero in that source snapshot, while `1086` returned
  34. Absolute, seasonal and alternate-title forms need complementary evaluation,
  not a universal rule to prefer either numbering format.
- On the general source, The Bear's broad-title query returned zero while its
  episode query returned 31; Everything Everywhere All at Once returned zero
  for the title alone and 75 with the supplied year. These are captured responses,
  not proof of current global availability or stable future search behavior.
- Movie broad-title results included wrong-work/year distractors. They make
  useful candidate-judgment cases after annotation.
- The existing planner category hint 5070 is not a universal anime category.
  Actual selected-source capabilities motivated 5000/6000 in this experimental
  manifest. This did not modify production categories or query policy.

## Artifacts, privacy and next gate

Full captures and the projected `dataset-v1-unreviewed.json` remain in a private
mode-0700 artifact directory outside Git, with mode-0600 files. A companion review
document contains per-case counts, verified target scope and small candidate
samples. Raw upstream responses, original GUIDs/hashes/magnets/download URLs,
settings documents and credentials were not persisted or published. A direct
canary comparison confirmed the remote artifacts contain none of the saved API
key values. Public repository files contain only tooling, public target/query
metadata, aggregate observations, and this report—not captured release lists.

Labels are **unreviewed**. Next: human-review identity, supported/inferred coverage
and multiple acceptable choices; freeze a label revision and franchise-level
development/held-out partition before prompt tuning. The proposed split is eight
development/four held-out works, but no blind held-out model result is claimed.
Do not send private-derived evidence to a hosted model or publish candidate
artifacts without the required review. Model/provider choice and explicit spend
limits remain inputs to a later live model run. The app runner and UI are not
implemented by this capture-only increment.
