# Routing Reliability and Account Tools

## Goal

Make the userscript reliable enough for daily account operations: account controls must behave predictably, audit and event evidence must stay within the correct group scope, operators must be able to judge account TTFT manually, and API-key accounts/models must be added without accidentally mixing GPT and Claude routing domains.

## Background and Confirmed Facts

- The current balance editor always opens from `buildBalanceControls()` and the list renderer suppresses filter-driven reconstruction while an editor is active. Capacity, quota, and balance editors use separate state, so they can stack instead of switching (`sub2-smart-group.user.js:4211`, `sub2-smart-group.user.js:4591`).
- The audit drawer directly treats objects in `account.groups` as map keys and labels. This creates duplicate object-identity groups and renders `[object Object]`, despite canonical membership and audit helpers already existing (`sub2-smart-group.user.js:2456`, `sub2-smart-group.user.js:1672`, `sub2-smart-group.user.js:5391`).
- Hit-change events compare only successive account IDs and request keys. They do not compare group, platform, or model, so requests from unrelated groups such as `百倍` and `Ark-GPT` can produce a false transition (`sub2-smart-group.user.js:1350`).
- Installed sub2api `0.1.165` exposes request-level `first_token_ms` through `GET /api/v1/admin/usage`, with account/group/date/stream filters. The userscript currently normalizes only `duration_ms` (`sub2-smart-group.user.js:945`).
- Official sub2api revision `e9a58c1cb8b5ef626a75c93b4d953fde5e67aa29` supports `POST /admin/accounts`, `POST /admin/accounts/models/sync-upstream-preview`, and `POST /admin/accounts/:id/models/sync-upstream`.
- Account creation accepts account-level `priority` and `group_ids`, but no group-membership priority. Binding one selected group assigns membership priority `1`, so an account-level fallback value must not be described as a guaranteed last position inside that group.
- Both model-sync endpoints only fetch and return `{ models: string[] }`. Persistence occurs only when an account create/update payload writes `credentials.model_mapping`; the userscript's current helper discards the returned list and then rereads saved models (`sub2-smart-group.user.js:3204`).
- In the pinned backend revision, single-account `PUT` treats the submitted object as the complete set of non-sensitive credentials, while preserving omitted sensitive keys only (`backend/internal/service/account_credentials_redact.go:29`, `backend/internal/service/admin_account.go:659`). `POST /admin/accounts/bulk-update` performs a JSONB top-level merge (`backend/internal/service/admin_account.go:875`, `backend/internal/repository/account_repo.go:2766`), so a one-account bulk update containing only `credentials.model_mapping` is the credential-preserving persistence path.
- Group platform is a stable API field. Model-family decisions must use `group.platform`, never a display-name substring.

## Requirements

- **R1 - Exclusive editor state:** Balance, capacity, and quota controls share one active editor state. Clicking the active control closes it; clicking another control or account switches to that editor rather than stacking another panel.
- **R2 - Filters remain operational:** Group, platform, health, text, and sort changes continue to update the account list while an editor is open. Typed balance credentials remain bound to their original provider/origin/account context and are not leaked or silently reused after a switch.
- **R3 - Canonical audit rendering:** The audit drawer renders the result of the canonical audit builder and canonical group memberships. It shows readable group names, categories, severities, and evidence without object-identity duplicates or `[object Object]` text.
- **R4 - Route-scoped hit events:** Keep a bounded last-success observation per complete route scope and compare a new success only with the previous success in that same scope: group ID, platform, and normalized requested model. Missing or different scope fields must not produce a hit-change event, and interleaved requests from other scopes must neither create false transitions nor hide a later same-scope transition.
- **R5 - TTFT observation only:** Show request-level TTFT and a rolling 24-hour account summary. The card uses P90 as the primary decision signal and also shows P50, the latest sample, and sample count. TTFT is evidence for the operator's existing manual schedulable toggle; it must not automatically disable, enable, reprioritize, or otherwise alter scheduling.
- **R6 - Explicit one-click creation:** The first release supports only OpenAI-compatible/GPT and Anthropic-compatible/Claude API-key accounts. From an explicit user action, accept an upstream base URL and API key, validate/detect one of those two platforms through sub2api's preview endpoint, show the detected result before the write, and create the account through the same-origin admin API.
- **R7 - Creation credential boundary:** The API key exists only in the transient password input and same-origin request payloads needed for preview/create. It is never written to Tampermonkey storage, page localStorage, logs, diagnostics, task artifacts, README, clipboard output, or GitHub, and is cleared from UI state after completion/cancel.
- **R8 - Safe group assignment:** Group assignment is mandatory and based on `group.platform`. A compatible concrete group filter is preselected; otherwise the only compatible group is auto-selected, while multiple compatible groups require an explicit choice in the confirmation UI. With no compatible group, creation is blocked. The flow never silently creates an ungrouped or misclassified account.
- **R8a - Honest creation priority:** New accounts use concurrency `1` and an account-level priority one step less preferred than the current compatible members' account priorities. The review labels it as account-level, and the post-create refresh shows the backend-assigned group priority; the UI must not claim that the create endpoint can place the account last in every group-priority tier.
- **R9 - Group-aware model persistence:** A manual model pull fetches upstream IDs, classifies the account's target group platform, filters to that platform's approved family, and reconciles system-owned identity mappings. Add current allowed upstream IDs, remove stale or wrong-family identity mappings, and preserve manual non-identity mappings without overwriting them. Persist only the complete reconciled `model_mapping` value through the one-account bulk-update merge path so every unrelated credential field remains untouched.
- **R10 - GPT and Claude isolation:** OpenAI/GPT groups never acquire Claude model IDs from sync; Anthropic/Claude groups never acquire GPT/OpenAI model IDs. Accounts with missing/conflicting real group platforms, or whose account platform disagrees with the resolved group platform, must not be updated until the ambiguity is resolved.
- **R11 - Manual and bounded network activity:** Creation preview, account creation, and model pull run only from explicit user clicks. Existing periodic refresh remains read-only and does not probe upstreams.
- **R12 - Release contract:** Release as `2.6.0`; update userscript metadata/runtime version and README behavior/security documentation consistently, validate the complete userscript, then commit and push only the intended feature/task changes under the standing release authorization.
- **R13 - Userscript ownership boundary:** Implement the requested controls, audit, event, TTFT, account-creation, and model-sync behavior in `sub2-smart-group.user.js`. Repository-local test/docs changes may support the release, but no CC Switch configuration or runtime state may be changed.

## Child Task Map

- `07-27-fix-controls-audit`: R1-R3.
- `07-27-routing-events-ttft`: R4-R5 and the no-automation portion of R11.
- `07-27-one-click-account-create`: R6-R8a and the creation portion of R11.
- `07-27-group-aware-model-sync`: R9-R10 and the sync portion of R11.
- The parent owns R12-R13, cross-child regression coverage, documentation consistency, and final integration review.

## Acceptance Criteria

- [ ] Clicking Balance, Capacity, or Quota on the same account opens, closes, and switches exactly one editor; switching accounts also leaves only one editor visible.
- [ ] All filters and sorting continue to change the rendered account set while an editor is open, without credential-context reuse or draft loss for the still-active editor.
- [ ] Audit output contains canonical readable group names and no `[object Object]` or duplicate object-identity groups.
- [ ] `百倍 -> Ark-GPT` and every other cross-group/cross-model pair produce no hit-change event; a same-scope account change still produces one.
- [ ] Interleaving a different route between two observations of one route neither creates a cross-route event nor suppresses the legitimate later same-route account change.
- [ ] Request history displays available `first_token_ms`; account summaries show rolling 24-hour P90, P50, latest value, and sample count, and never imply TTFT exists for non-streaming or missing samples.
- [ ] No TTFT code path writes scheduler state. Manual schedulable controls continue to work unchanged.
- [ ] A supported URL/key can be previewed and created once with the detected API-key platform and a platform-compatible group: a compatible concrete filter is preselected, a sole compatible group is automatic, multiple groups require an explicit selection, and zero compatible groups creates nothing.
- [ ] Creation uses concurrency `1`, shows the proposed account-level priority before submission, and shows the actual group membership after refresh without claiming an unsupported guaranteed group-level fallback position.
- [ ] A GPT/OpenAI model pull reconciles identity mappings to the approved OpenAI family, and a Claude/Anthropic pull reconciles identity mappings to the approved Claude family; stale/wrong-family identity entries are removed while manual non-identity mappings, base URL, API key, header overrides, and all unrelated credentials are preserved.
- [ ] Focused pure-function assertions cover editor transitions, audit group normalization, route-scope comparison, TTFT aggregation/evidence states, platform detection, group resolution, model-family filtering, and credential-preserving update construction.
- [ ] `node --check sub2-smart-group.user.js`, focused Node assertions, and `git diff --check` pass; no real credentials, external source clones, or temporary assertion artifacts enter the repository diff.
- [ ] README, metadata version, runtime fallback version, and user-visible release notes agree before commit and push.

## Out of Scope

- Automatic TTFT-based schedulable enable/disable, threshold-triggered actions, automatic priority changes, or any other scheduler automation.
- sub2api backend, database, container, image, or infrastructure changes.
- CC Switch configuration, database, provider health policy, circuit-breaker settings, or runtime changes; its screenshot is reference material only.
- Gemini, Grok, Antigravity, OAuth, setup-token, Bedrock, and service-account account creation.
- Userscript-initiated synthetic chat/model requests for health testing. Model-list preview/pull is the only explicit upstream-read mechanism added by the script; the official backend's existing post-create OpenAI capability probe remains unchanged.
- Inferring a platform or group from its display name alone.
- Bulk account creation, credential export, or displaying saved API keys.
