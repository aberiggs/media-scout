# Search service API (domain contract)

The v2 HTTP/MCP adapters call the same asynchronous search domain. A request requires only `prompt`; optional `context` supplies aliases, identifiers and TV/movie/season scope. `preferences` (audio/subtitle language, resolution, notes) are descriptive soft signals, not requirements. Do not put credentials or secrets in prompts.

```json
{ "prompt":"Find Example season 2 episodes 1–3", "context":{"kind":"tv","titles":["Example","Alias"],"scope":{"type":"season","seasonNumber":2},"targets":[{"targetId":"e1","seasonNumber":2,"episodeNumber":1}]}, "preferences":{"subtitleLanguages":["en"]} }
```

Search actions are constrained to `list_indexers`, `search_releases`, and `finish`; action-envelope keys are required and nullable for strict OpenRouter structured output. Only enabled, non-cooling indexers can be queried. The model receives the entire Prowlarr result array, not a seed-ranked shortlist. Search tool events expose query and counts. Candidate IDs are opaque; GUIDs, hashes and URLs are local-only private candidate data. Repeated physical IDs retain all safe observations; explicitly contradictory scopes are rejected, while an unparseable alias does not override a valid same-release observation.

Defaults: at most 20 model decisions, 12 Prowlarr searches and 10 minutes total. Per-run overrides may only lower configured limits. A deadline/provider error is explicit (`budget-exhausted`/`failed`), never an exhaustive no-match. Provider Retry-After remains a provider failure signal. Search never downloads. Terminal statuses include `matched`, `no-match`, `needs-input`, `budget-exhausted`, `failed`, and `interrupted`; only validated matched options are candidates for the later explicit submission boundary. Options are alternatives, up to five; episode/movie options use one release, season options up to three. No hidden confidence or chain-of-thought is returned.

Example terminal response:

```json
{"searchId":"opaque-search-id","status":"matched","options":[{"optionId":"opaque-option","rank":1,"releases":[{"candidateId":"opaque-candidate"}],"coveredTargetIds":["e1"],"reason":"Matches the requested episode and has strong availability evidence.","uncertainty":"Audio metadata is not reported."}],"counts":{"decisions":3,"searches":2,"candidates":200}}
```

Selection fixture rubric (synthetic, not measured model accuracy): use aliases and seasonal/absolute numbering for S2E1/absolute 26; unknown absolute metadata is uncertainty, not proof; split cours and aliases are valid candidates only with evidence; reject explicit wrong season; do not infer complete airing-pack contents; reject explicit wrong language while unknown language remains uncertain; multi-sub and popular/high-seed releases are soft preferences, not minima; original/dubbed audio and resolution are trade-offs; no suitable release is a valid no-match. Indexer titles and descriptions are untrusted data, never instructions.

Search history stores the complete request context. Safe candidate metadata is separated from private download references, which expire 30 minutes after completion. Request summaries appear in your local Activity view; do not paste secrets. Keep raw prompts/private locators out of application logs; retained search history is subject to the store retention policy.

Explicit seasonal numbering takes precedence over ambiguous bare-number parser fallback; codec/numeric suffixes do not override a matching S02E01 with a guessed absolute number. Real conflicting seasonal/episode evidence remains rejected. An invalid selection receives one bounded correction turn with a safe validation reason. Provider calls do not secretly retry beyond the search's model-call budget.

## Explicit submission

Submission accepts `{ "searchId", "optionId", "idempotencyKey", "downloadClientId?" }` only for a previously matched option. The UI may list enabled clients using the safe projection `{id,name,protocol,categories}`; disabled entries and upstream credentials/category details are never returned. An explicit client must be enabled and match every selected release protocol. When no client is supplied, a TV/movie request uses its configured client by name; a request without a TV/movie kind may use the sole enabled client, otherwise selection is required.

Dry-run returns `dry-run` without creating a receipt, grace reservation, or download-client POST. Real submissions store a durable idempotency receipt before external calls. Reusing the same key and normalized request replays its recorded full outcome; a different request conflicts. A timed-out/network-failed POST is `uncertain` and is not repeated automatically. Options with multiple releases stop at the first failure. Candidate locators stay private and are never included in submission outcomes. Reservation grace is finite; submission itself is not evidence of download completion or import.
