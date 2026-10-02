# Operator recovery lane

This is an isolated administrative lane for a human to repair an existing queue association or release an eligible local reservation. It is not called by the normal runner, planner, picker, queue associator, or automatic MCP batch actions. It has no search/grab/download-client mutation path. A successful release only writes `released_at` and an audit note; the original intent status, capture, receipt, markers, source identity and history remain intact.

## Enablement and approval boundary

`ALLOW_OPERATOR_ACTIONS=false` is the strict default. Setting it to `true` is an explicit host opt-in, not authentication or proof of human identity. The MCP `ma_review_action` tool contains both preview and mutating variants and is marked destructive as a whole; an MCP host must require human approval for every call, including commits. Tool metadata and a caller-supplied challenge string cannot prove a human typed that string. If the host cannot enforce per-call approval, use the interactive TTY CLI (`node_modules/.bin/tsx src/operator-cli.ts`); it refuses non-TTY use and has no `--yes`/noninteractive path.

The CLI and MCP both require the same fresh observation, one-use token, exact action challenge, note, and state checks. Tokens are random 256-bit values, only SHA-256 digests are persisted, and token evidence expires after 120 seconds. Successful commits consume the token and write an audit record atomically with the mutation. Failed, stale, mismatched, or replayed commits do not mutate or consume it.

## Workflow

1. Select an open review and prepare `associate_queue` or `release_intent_hold`.
2. The operator service performs fresh complete Sonarr/Radarr library and queue reads itself. Partial/unknown reads fail closed. It binds source configuration fingerprints, exact stable queue references/material, target inventory, durable state, and the prepared private association lookup. No client can supply snapshots, completeness flags, intent identifiers, clocks, or hashes.
3. Review the safe preview. For an association, choose only supplied media/target indices. Commit re-reads the actual library and both complete queues, verifies unchanged association material and durable fingerprints, checks current provider IDs, and persists a private human override. It establishes initial media association only; it does not prove episode coverage, submission provenance, remote receipt, or a vanished hold. A subsequent LLM cache write cannot replace a still-applicable human override.
4. For a hold release, inspect the download client(s), including the routing used at submission. The exact acknowledgement is: `I inspected the download client(s), including routing used at submission; no matching download is active, and I authorize releasing this reservation so retries may become eligible.` The service independently checks a complete known library/queue observation, grace deadline, unconfirmed unresolved intent, exact current captures, multi-work/series claims, no live worker claim, and no other held coverage or possible active queue conflict. Any unassociated/unknown queue row is a conflict. If the possible jobs cannot be covered by the operator and supplied complete evidence, do not release.

## API boundary

The administrative service surface is deliberately separate from `Runner`:

```ts
prepareReviewAction({ reviewId, operation })
associateQueue({ reviewId, token, proposedAssociation, challengeResponse, note })
releaseIntentHold({ reviewId, token, challengeResponse, note })
```

The state boundary accepts explicit object arguments only:

```ts
issueOperatorObservation({ operation, reviewId, claims: OperatorClaim[], observation: OperatorObservation, now })
peekOperatorObservation({ token, operation, reviewId, now })
commitHumanQueueAssociation({ token, reviewId, claims: ClaimSet, decision, currentObservation, challengeResponse, note, now })
releaseIntentHold({ token, reviewId, claims: ClaimSet, currentObservation, challengeResponse, note, now })
```

`OperatorClaim` binds each private work key to its current content identity and missing fingerprint. `ClaimSet` is the live, atomically acquired State lease; release requires original and projected target keys plus the series coordination lease. MCP inputs intentionally contain none of the observation, claims, source fingerprints, private queue refs, clocks, completeness flags, or intent IDs.

Hashless intents require particular care: Sonarr/Radarr queue reads cannot establish that an untracked qBittorrent job does not exist. The acknowledgement requires manual inspection of all matching download-client jobs and original routing; if that inspection is not possible, refuse the operation. An empty *arr queue alone is not proof. This lane does not query qBittorrent directly.

## Persistence and limits

`manual_review.subject_kind/subject_key` are additive nullable links. Only reviews created by trusted reconciliation with an explicit intent link may offer release; legacy unlinked reviews are never guessed from `workKey`. `grab_intents.released_at/release_note` are additive; released intents remain in history but no longer reserve queue coverage or appear in live hold counts. Other intents and reservations are unaffected. Human overrides stay in private `queue_associations` state and are scoped to exact material/context/prompt signatures.

The persisted observation is a short-lived trusted-service boundary, not cryptographic proof that an external server did not change after the read. The configuration fingerprint is private; no API key is stored in plaintext in the observation. Audit notes are private and should not contain credentials, URLs, download IDs, hashes, or other secrets. Never clear the database to force retries. Ordinary positive library fulfillment and existing receipt reconciliation remain the only way to record completion.
