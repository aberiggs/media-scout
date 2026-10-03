# Operations dashboard

The dashboard's **Queue** shows Media Scout's tracked work items, scheduling, observations, and held coverage. It is not a view of live download-client jobs. Refreshing Queue, Reviews, or Search history reads the local SQLite projection; it does not trigger a cycle or search.

**Search history** records bounded search activity for seven days, up to 2,000 entries. Query terms can reveal what you are looking for; this is an operational view, not raw server logs.

## Retry and Reset

Actions are offered only when the work is safe to change. Live worker/group claims, open reservations, persisted queue coverage, unsafe review reasons, unknown or stale observations, and an active rate-limit deadline keep actions unavailable. TV actions also require the same-series group lease.

- **Retry** clears ordinary cooldown/backoff scheduling and eligible ordinary reviews while preserving the last search time. It makes work eligible for a later processing pass; it does not start a cycle or promise when the scheduler will process it.
- **Reset tracking** also clears the last search time and records a pending reset. The work item is hidden from Queue until a later known library observation; that observation allows normal reconciliation to rediscover eligible missing media. Reset does not search, grab, or clear queue coverage, reservations, receipts, dedupe markers, decisions, associations, or audit history.

Retry and Reset are gated by **Safety → Allow operator actions**, which is off by default. This is an opt-in, not user authentication.

## Review recovery

Association and reservation release use a separate prepare/commit flow. Prepare reads the current library and complete Sonarr/Radarr queues and returns a short-lived preview, explicit choices, and an exact challenge. Review the affected targets and queue evidence before committing; changed or stale evidence requires a fresh preview. Association commits only the explicit supplied selection.

Reservation release requires confirmation that all relevant download clients and the original submission routing were inspected, followed by the exact challenge text. An empty *arr queue by itself is not proof that a download is inactive. The recovery lane does not search, grab, invoke the LLM, or mutate a download client.

## Network and startup

The HTTP UI/API has no authentication. Keep it on loopback or a trusted private network; do not expose it to untrusted networks. See [operations and safety](operations.md), [setup and configuration](setup.md), and [operator recovery](operator-recovery.md) for broader guidance.

From a checkout, the documented Compose startup is:

```sh
mkdir -p data
docker compose up -d --build
```

Open <http://127.0.0.1:7877/>. For local source development and the existing web build/run commands, follow [setup and configuration](setup.md).

Chat is deferred; the current operations dashboard covers Queue, Reviews, and Search history.
