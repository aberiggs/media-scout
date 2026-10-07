# General search

General search is for open-ended, natural-language media discovery outside the Sonarr/Radarr work queue. Enter what you are looking for; the LLM turns it into one to three Prowlarr queries, and Prowlarr searches across categories. If the request needs clarification, answer the question and search again. Planning does not choose a release.

## Configure a destination

In **Settings → Integrations → Prowlarr**, configure the Prowlarr URL and API key, then enter the exact name of one enabled download-client entry in **General download client**. There must be exactly one enabled match. General search does not require Sonarr or Radarr configuration, or either of their client names.

Set up the download client and its category/label in Prowlarr itself. Choose a category appropriate for general/manual downloads and verify the destination client uses it; Media Scout does not set a separate category during submission. Avoid a Sonarr/Radarr import category unless you deliberately want those services to process the download. The configured client must have a recognized `usenet` or `torrent` protocol, and a release is selectable only when its protocol matches.

## Review and submit

Search results are available for 15 minutes. Review them, explicitly select up to 10 releases, then confirm the selection. Searching and selecting do not send downloads. Even a single result requires your explicit selection and confirmation. Expired results cannot be submitted; search again to get a fresh result set. LLM planning has a 60-second deadline; each Prowlarr HTTP request has a 15-second timeout.

**Allow operator actions** must be enabled to submit, including a dry run; it is off by default. With **Dry-run mode** enabled (also the default), confirmation returns a dry-run outcome and makes no Prowlarr grab request. A live submission requires both Allow operator actions enabled and Dry-run mode disabled. Dry-run still performs AI planning and Prowlarr searches, which may use API credits.

“Submitted” means Prowlarr accepted the request, not that the download completed. A timeout, server error, or invalid success response can leave the outcome **uncertain**. Uncertain submissions are not automatically retried; verify the download client before taking further action. A submission in progress or a prior receipt is also not sent again. Search activity does not fulfill or track library work.

## MCP clients

The stdio MCP server provides `ma_general_search` for planning and showing candidates, and `ma_general_grab` for the selected IDs. The grab tool is mutating. The calling MCP host is responsible for presenting the candidates and obtaining explicit human approval before calling it. Its `confirmed: true` field and confirmation token are not proof of user approval. Operator-action and dry-run safeguards still apply.

The HTTP API exposes the same workflow at `POST /api/search` and `POST /api/search/:id/grab`. It has no authentication; keep the UI/API on loopback or a trusted private network as described in [operations and safety](operations.md).
