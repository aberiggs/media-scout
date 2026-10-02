# Public repository and dev-image publishing

Media Scout uses the public repository [github.com/aberiggs/media-scout](https://github.com/aberiggs/media-scout) and is intended to publish a **development-only** GHCR image at `ghcr.io/aberiggs/media-scout`. There is no stable-release promise, semver release policy, automatic homelab deployment, or `latest` image tag. The registry image is an alternative to building from source with `docker-compose.yml`.

The public repository was initialized with an MIT license commit (`1ae5e5d8e46b9093e5bd9829fa508c00c8ef2cf5`). Preserve that history and add reviewed snapshot changes as ordinary commits; do not replace or rewrite the branch history.

## 1. Export a clean snapshot onto the initialized repository

1. Clone the public repository into a fresh checkout using `git clone https://github.com/aberiggs/media-scout.git`, then enter the `media-scout` directory. Confirm its `main` branch contains the existing initial MIT commit above. Keep the clone's `.git` directory and remote history intact.
2. Copy the **reviewed public snapshot** into this clean clone using an explicit publication allowlist. Do not copy another repository's `.git` directory, credentials, `.env`, `data/` databases/backups, or unapproved internal planning/review material. This creates a new ordinary commit on top of the remote license commit without importing unrelated history.
3. Keep the remote initial MIT commit in history. The reviewed snapshot's `LICENSE` should state the desired current attribution, `Copyright (c) 2026 Abe Riggs IV`; this may update the license file from the remote seed commit without deleting or rewriting that initial commit.
4. Before any push, audit the exact staged snapshot and all history in the clean clone that would become public for API keys, tokens, private URLs, `.env` content, databases, backups, and other private material. Review tracked paths and relevant history locally (for example, `git ls-files`, `git status`, and `git log --all -p`); use an approved secret scanner if available. Do not paste any discovered secret into logs, chat, or an issue. If a secret was ever committed, revoke/rotate it and clean the export before proceeding.
5. Confirm `.env`, `data/`, and database/backup files are not tracked. `.env.example` is safe only while it contains names and non-secret examples, never actual credentials.
6. Only after the exact snapshot passes review, commit it in the clean clone and push normally to `main`. Do not force-push, orphan the branch, or import unrelated development history.

## 2. Protect `main`

Configure the repository's `main` branch so changes arrive through pull requests, force pushes are blocked, and branch deletion is blocked. Enable required status checks only after the workflow owner has created the workflows and a successful run has exposed their exact GitHub check-context names. The expected contexts are **`checks`** and **`container-build`**; confirm these names against the actual Actions UI rather than requiring guessed or nonexistent checks.

For a single-maintainer repository, do not require an approving review that the author cannot supply. Require the PR/check workflow and perform the maintainer's review before merge instead. If another contributor joins, revisit the approval rule deliberately.

## 3. Dev image publication contract

Coordinate with the GitHub Actions/workflow owner before relying on registry behavior. The dev-only publication contract is:

- Validate pull requests, but do not publish a runnable image from an unmerged PR.
- On an approved push to `main`, publish `ghcr.io/aberiggs/media-scout:dev` and a commit-addressed tag prefixed with `sha-`, for example `ghcr.io/aberiggs/media-scout:sha-<full-commit-sha>`. Replace the placeholder with the exact full-SHA tag produced by the workflow. Do not publish `latest`; do not publish on version-tag creation until a separate release policy exists.
- Do not deploy to a homelab or trigger deployment from the workflow. Publishing an image is not authorization to run it.
- Use the repository-scoped `GITHUB_TOKEN` and least-privilege package permissions for Actions. Never add runtime API keys to Actions secrets for this image build; image building must not need the operator's Sonarr, Radarr, Prowlarr, download-client, or LLM credentials.

Both `dev` and `sha-<full-commit-sha>` are mutable tags and can be overwritten by later builds or reruns. The SHA-shaped tag identifies a source commit, not an immutable image artifact; use an image digest to identify the exact immutable artifact tested or selected for rollback. The `dev` tag means the latest qualifying main-branch build, not a reviewed stable version. There is no automatic update behavior in `docker-compose.ghcr.yml`; an operator explicitly chooses and pulls an image.

## 4. First GHCR package and visibility

The first successful publication creates the package. GitHub Container Registry packages are **private by default**, even if the source repository is public. If anonymous image pulls are intended, the maintainer must open the package settings in GitHub and explicitly change package visibility to public, then verify anonymous pull access. Otherwise, users must authenticate to `ghcr.io` using an appropriately scoped token; do not put that token in `.env`, Compose YAML, or shell history.

The published-image Compose file requires `MEDIA_AGENT_IMAGE`, supplied either in the shell environment or an optional `.env` file. `.env` is optional for bootstrap defaults; when present, it can contain bootstrap overrides and the Compose image reference. Integration, monitoring, and safety values are stored in SQLite instead. Compose v2.24 or later supports the optional env-file declaration used by these Compose files. For example, an operator may select the currently published dev image in `.env`:

```dotenv
MEDIA_AGENT_IMAGE=ghcr.io/aberiggs/media-scout:dev
```

To use a commit-addressed tag instead, set `MEDIA_AGENT_IMAGE=ghcr.io/aberiggs/media-scout:sha-<full-commit-sha>` to the exact tag created by the workflow. For example, a **format-only, non-published** SHA-shaped tag is `ghcr.io/aberiggs/media-scout:sha-0123456789abcdef0123456789abcdef01234567`. To pin the exact immutable artifact by registry digest, use `ghcr.io/aberiggs/media-scout@sha256:<digest>`. Then:

```sh
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

This is a standalone alternative to `docker-compose.yml`; it accepts the same optional bootstrap `.env` overrides, loopback-only port binding, persistent `./data` mount, and runtime defaults, but does not build an image. The image must exist locally or be pullable. It runs the normal daemon service (Compose service name `media-agent`), so scheduled cycles can call the LLM and Prowlarr when monitoring is enabled, even in dry-run mode; dry-run prevents grabs, not searches or model calls.

Integration, monitoring, and safety settings—including **Safety → Dry-run mode** and whether monitoring is enabled—are stored in the SQLite database under `./data`. They survive container and image replacement; setting `DRY_RUN=true` in a shell or `.env` does not override an existing database setting. Before upgrading or testing an image, explicitly check the UI settings. Keep monitoring disabled during the rollout, and confirm **Dry-run mode** is enabled before any test that could perform searches or grabs. Do not assume an image upgrade resets saved settings.

## 5. Maintainer publish checklist

Before merging a publishing change or using the published image:

1. Confirm the secret/history audit is complete and the checked-out commit is the intended reviewed revision.
2. Run the project-required tests, typecheck, and Docker build. Confirm the PR workflows pass and use their actual check-context names in branch protection.
3. Merge through the protected PR path. Check that the main-branch image workflow publishes only `dev` and the `sha-<full-commit-sha>` tag, with no `latest`, release-tag trigger, or deployment step.
4. Confirm both image tags refer to the expected commit. If anonymous pulls are desired, explicitly set and verify public GHCR visibility.
5. Record the full commit and/or image digest used for the controlled rollout. Before testing the upgraded image, check the persisted UI settings, keep monitoring disabled, and confirm **Safety → Dry-run mode** is enabled. Only disable dry-run in the UI after an operator separately authorizes a reviewed live-grab transition; a `DRY_RUN=true` environment value does not replace this check.

The Node package version is not, by itself, a published-release signal. No semver/version-bump policy is defined yet; maintainers may decide one separately before creating formal releases.

## 6. Database backup and rollback

The image uses the persistent SQLite database under `./data`. Before upgrading or changing image references, create a consistent backup. For a filesystem backup, stop the Compose service `media-agent` and **all separate MCP servers, operator CLI processes, and any other SQLite writer**, then archive/copy the entire `data/` directory, including any `-wal` or `-shm` sidecars that exist. Never copy only the main database file while a writer may be open. Alternatively, use SQLite's online backup API with a deliberate consistent snapshot.

To roll the application image back, set `MEDIA_AGENT_IMAGE` to the prior full-commit tag or digest and explicitly pull/recreate with `docker-compose.ghcr.yml`. Image rollback does not roll back SQLite. Newer code may have changed or migrated the schema; an older image may not be compatible with a newer database. Before restoring a database backup, stop all writers and confirm the backup's schema is compatible with the selected image. Do not assume migrations have a downgrade path, and do not clear the database to force work to retry.

No automated deployment or database restore is configured by this project. Keep a known-good compatible backup before each change and validate the selected image/database pair under the operator's own rollout procedure.
