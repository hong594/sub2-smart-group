# Add One-Click Account Creation

## Goal

Create a supported API-key account from an upstream URL and key with minimal operator input and no silent platform/group misclassification.

## Requirements

- Provide an explicit add-account command and modal with base URL and password-style API key input.
- Support only OpenAI-compatible/GPT and Anthropic-compatible/Claude accounts with `apikey` type in the first release.
- Normalize the base URL without accepting embedded credentials, query, or fragment.
- Use the same-origin `sync-upstream-preview` endpoint to validate candidate API-key platforms; do not send direct cross-origin requests from the userscript.
- Accept HTTPS base URLs plus loopback HTTP for local upstreams; reject embedded credentials, query, fragments, and other protocols while preserving a meaningful base path.
- Present the detected platform, target group, generated account name, and filtered model count before the create write.
- Preselect the active concrete group filter only when its `group.platform` matches detection. Otherwise auto-select the sole compatible group, require an explicit choice when several compatible groups exist, and block creation when none exists.
- Generate a stable readable default name from the upstream host and avoid duplicating an existing account name without a visible suffix.
- Submit an official `CreateAccountRequest` with platform, `apikey` type, credentials, conservative defaults, and resolved group IDs.
- Include only the detected family's filtered identity model mappings, use concurrency `1`, set an account-level priority one step less preferred than current compatible members' account priorities, and guard submission with one transient idempotency key.
- Label the proposed priority as account-level. The backend assigns group-membership priority during `group_ids` binding, so reread and show the actual membership after creation without promising that the account is last in every group-priority tier.
- Clear the API key from UI state after success, cancel, or terminal failure; never persist or log it outside sub2's account credential store.
- Fail closed when platform detection is ambiguous and never create an ungrouped account implicitly or explicitly in this release.

## Acceptance Criteria

- [x] A supported URL/key produces a preview and one account only after explicit confirmation.
- [x] Invalid URLs, failed authentication, unsupported protocols, mixed/ambiguous model results, and ambiguous group resolution create no account.
- [x] A compatible concrete filter is preselected, one compatible group is automatic, multiple compatible groups require a user selection, and zero compatible groups blocks confirmation.
- [x] The key is absent from userscript storage, localStorage, messages, logs, task files, README, and rendered post-operation state.
- [x] The created account has the detected platform, `apikey` type, normalized base URL, compatible group, and documented defaults.
- [x] Review shows concurrency `1` and the proposed account-level priority; the refreshed result shows the backend-assigned group priority and makes no unsupported group-fallback guarantee.
- [x] Refresh after creation shows the new account and no duplicate submission occurs while the request is pending.
- [x] The userscript never calls a test/probe endpoint; the backend's existing post-create OpenAI capability probe is documented as an official create-endpoint side effect.

## Out of Scope

- Gemini, Grok, Antigravity, bulk creation, ungrouped creation, OAuth/setup-token import, service accounts, Bedrock, credential export, and backend changes.

## Parent Requirements

Implements parent requirements R6-R8a and the creation portion of R11.
