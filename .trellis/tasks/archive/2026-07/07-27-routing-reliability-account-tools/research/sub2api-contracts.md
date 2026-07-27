# sub2api Contracts

## Evidence Baseline

- Installed backend version inspected during planning: `0.1.165`.
- Official source revision used for contract verification: `e9a58c1cb8b5ef626a75c93b4d953fde5e67aa29`.
- This task consumes existing Admin APIs only. It does not modify the backend, image, database, or container.

## Usage and TTFT

- `GET /api/v1/admin/usage` supports pagination plus `account_id`, `group_id`, `start_date`, `end_date`, `timezone`, and `stream` filters (`backend/internal/handler/admin/usage_handler.go:60`).
- Admin usage rows expose `request_id`, `account_id`, `group_id`, `model`, `stream`, `created_at`, `duration_ms`, and nullable `first_token_ms` (`backend/internal/handler/dto/types.go:482`, `backend/internal/handler/dto/types.go:502`).
- `first_token_ms` is real recorded request evidence. It is nullable and is primarily populated for streaming requests; missing values must remain unavailable rather than being inferred from duration.
- The pagination parser accepts at most 1000 rows per page. The userscript can fetch the newest 1000 streaming rows over yesterday-through-today dates, apply an exact client-side rolling 24-hour cutoff, and use pagination totals to mark incomplete coverage.

## Account Creation and Detection

- `POST /api/v1/admin/accounts/models/sync-upstream-preview` accepts `platform`, `type`, `base_url`, and `api_key`, then returns `{ models: string[] }` without creating an account (`backend/internal/handler/admin/account_handler.go:2592`).
- Detection can preview only the two approved candidates: `platform=openai,type=apikey` and `platform=anthropic,type=apikey`. A candidate is valid only when the request succeeds and the returned list contains at least one allowed model for that candidate family. Zero or multiple valid candidates are ambiguous and must not create anything.
- `POST /api/v1/admin/accounts` accepts name, platform, type, credentials, concurrency, priority, rate multiplier, and group IDs (`backend/internal/handler/admin/account_handler.go:113`). The userscript must always submit one chosen compatible group ID so the backend's default-group fallback is never relied upon.
- The create request has no account-group priority field. `CreateAccount()` binds `group_ids` through `BindGroups()`, which assigns priorities by request position; one selected group therefore receives membership priority `1` (`backend/internal/service/admin_account.go:563`, `backend/internal/repository/account_repo.go:1707`). The request-level `priority` remains the account priority and cannot guarantee that the new account is behind members in higher numeric group-priority tiers. The userscript must label this distinction accurately and reread the created membership instead of promising a group-level fallback position.
- Account creation supports `Idempotency-Key`. The UI should also disable duplicate submission and reuse one transient key for retries of the same confirmed attempt.
- The official create handler performs its own asynchronous OpenAI Responses capability probe for a newly created OpenAI API-key account (`backend/internal/handler/admin/account_handler.go:897`). This is a backend-owned side effect of the required official create endpoint; the userscript must not call probe/test endpoints itself.

## Model Fetch and Persistence

- `POST /api/v1/admin/accounts/:id/models/sync-upstream` fetches live upstream models and returns `{ models: string[] }`; it does not write `credentials.model_mapping` (`backend/internal/handler/admin/account_handler.go:2550`).
- Admin account responses redact sensitive credential keys including `api_key`, while preserving visible configuration such as `base_url` and `model_mapping` (`backend/internal/service/account_credentials_redact.go:3`, `backend/internal/handler/dto/mappers.go:218`).
- Single-account `PUT` treats the submitted credentials object as the complete non-sensitive credential set. Omitted sensitive keys are preserved, but omitted non-sensitive keys are deleted (`backend/internal/service/account_credentials_redact.go:29`, `backend/internal/service/admin_account.go:659`).
- `POST /api/v1/admin/accounts/bulk-update` performs a top-level JSONB merge for credentials (`backend/internal/service/admin_account.go:875`, `backend/internal/repository/account_repo.go:2766`). A one-account request containing only `{ credentials: { model_mapping: ... } }` replaces that mapping while leaving every unrelated credential key untouched.

## Group and Model Policy

- Group objects expose a stable `platform` field. Platform decisions must compare normalized `group.platform` values, not group names.
- The existing canonical membership helper may fall back to `account.platform` when group data is absent. Destructive model synchronization must use a strict group-platform resolver backed by the indexed or inline group object, treat a missing group platform as ambiguous, and require it to agree with the account platform.
- A target account is syncable only when all canonical memberships resolve to exactly one supported platform, `openai` or `anthropic`.
- OpenAI text-family filtering should classify the final model path segment and allow GPT/chat/reasoning/Codex identifiers while excluding image, audio, realtime, transcription, speech, embedding, and unrelated vendor families. Anthropic filtering allows `claude-*` identifiers only.
- Reconciliation owns only exact identity mappings where the trimmed source and target strings are equal. Every non-identity or non-string entry is treated as manual and preserved. If a manual entry uses a fetched source key, it wins and must not be overwritten by an identity entry.
- A successful fetch with zero allowed models performs no update. An incomplete/failed fetch never removes existing mappings.
