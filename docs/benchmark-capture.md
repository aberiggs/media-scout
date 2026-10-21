# Private benchmark capture

`tools/benchmark_capture.py` prepares or performs a bounded, read-only Prowlarr
search capture. Copy the script and manifest to a private directory on the
approved host via SSH; invoke it there with `--settings-db PATH --manifest
PATH --out PATH`. The production database is opened read-only and is not copied.

Manifest JSON uses version 1, for example:

```json
{"version":1,"cases":[{"id":"case-1","kind":"tv","title":"Example","queries":[{"family":"title","query":"Example S01E01","categories":[5000]}]}]}
```

Without `--execute`, the tool validates and prints a plan without opening
settings. Live capture requires `--execute`; optionally pass at most two
explicit `--indexer-ids`. The tool calls only Prowlarr indexer metadata,
status, and search GET endpoints. It does not contact Sonarr/Radarr, submit
downloads, or run models. Errors/backoff are unavailable, never an empty result.
Completeness is provisional: HTTP 200 does not establish that each indexer
returned all matches. Captures are provisional unlabeled data until human review;
no model runs are part of this workflow.

Keep output artifacts private and outside the repository. Do not publish raw
captures or include them in commits. The capture intentionally omits upstream
links and raw GUID/hash identifiers.

## Bounds and service selection

Requires Python 3.9+ on Linux/Unix (the standalone CLI uses a wall-clock signal
deadline in its main thread). This preparation utility is intentionally separate
from the TypeScript application's runtime. It imports no application composition,
monitoring, state writer, or download client. Ordinary npm tests never invoke it.

Each capture allows at most 12 cases, six query slots each, 72 distinct searches,
two enabled healthy indexers, 30 minutes, 200 stored rows per query, 10,000 stored
rows total, and 8 MiB per HTTP response. A request is bounded to 30 seconds
including response reading; searches are paced by at least one second. No
automatic retry occurs. A controlled failure/interruption retains partial results
and stops the entire capture, including later cases. A successful HTTP array is
still **upstream-completeness-unknown**: the requested limit might not bound
upstream work, and an indexer failure may not be surfaced by Prowlarr. Status is
checked before and after every search; a newly cooling source is unavailable,
not an empty success. Reaching a result cap is explicitly truncated.

Use explicit indexer IDs after inspecting enabled/healthy status and category
capabilities. An omitted indexer-status entry means no recorded cooldown, not
unavailable. Default selection is the first two enabled, non-cooling entries;
it does not establish indexer quality, category support, or public-data status.
For public-data experiments explicitly select only public sources. The manifest's
categories must match source capabilities; notably anime can be exposed as 6000
rather than the planner's 5070 hint. This utility does not change app categories.

If a saved proxy address is unreachable but the **same verified service** has a
published localhost port, `--base-url http://127.0.0.1:9696` overrides the connection
for this process only. The override accepts loopback destinations only; never
forward a production key to an unrelated listener. It does not edit the DB.
Redirects are denied, including cross-origin redirects.

Output is exclusively created with mode 0600 and cannot overwrite another
capture. Use a mode-0700 parent directory. Only the connection URL and key are
selected in memory from `app_settings`; the DB and full settings are never
exported. Raw release responses exist only in memory. Text is scrubbed for
URLs, keys, paths and hash-like IDs; physical duplicate relationships are retained
as random per-capture IDs, including transitive equivalences. Unknown identifiers
do not make unrelated rows duplicates. Error diagnostics contain safe codes only.

## Metadata, labels and replay

Prepare verified target identity/numbering context separately from the strict
query manifest. Public Sonarr/Skyhook TVDB metadata can establish season/absolute
mappings; public MAL title pages can establish anime aliases; Radarr's read-only
movie lookup supplies TMDB IDs and years. Do not read the personal library or
substitute a MAL/TMDB ID for TVDB. Missing mappings remain unknown. The capture
CLI does not fetch or validate that metadata itself.

Keep a provenance/observation-time file alongside each capture, and freeze the
query manifest **before** searching. Declare development/held-out partitions by
work/franchise, not result row. Persist exact query/categories/indexer pseudonyms,
ordered results, observed time, and limit. There is no substring-search replay:
an unrecorded query is unsupported, not empty. Candidate counts alone do not
establish identity, acceptable coverage, recall, or an objectively best query.

All initial labels are `unreviewed`. Human review must permit multiple acceptable
releases and distinguish explicit scope, inferred packs, wrong work/season and
uncertainty. Do not claim import or inspected torrent contents. This utility does
not supply a model-quality score or a human-validated benchmark suite. Public
release sources reduce disclosure risk, but artifacts still require inspection
before publication. Never commit a production DB, full settings, raw responses,
private release links, GUIDs/hashes, or credentials.

Offline checks:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'benchmark_capture_test.py'
```
