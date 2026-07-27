# Add Group-Aware Model Synchronization

## Goal

Persist only the upstream model family that can belong to the account's target group platform.

## Requirements

- Resolve model policy from canonical memberships plus the indexed or inline group's real `group.platform`, never group/account display names or an `account.platform` fallback standing in for missing group data.
- Fetch the upstream list only after an explicit user click and consume the returned `{ models }` payload directly.
- OpenAI groups allow the approved GPT/OpenAI chat and reasoning family; Anthropic groups allow the Claude family.
- Reject updates when memberships have missing/conflicting platforms, no unambiguous supported platform, or a resolved group platform that disagrees with the account platform used by the upstream endpoint.
- Reconcile only system-owned identity entries in `credentials.model_mapping`: add current allowed upstream IDs, remove identity entries that are stale or outside the target family, and preserve manual non-identity mappings without overwriting them.
- Read the latest account first to obtain the current visible `model_mapping`; sensitive credentials remain redacted and must never be reconstructed or sent back.
- Persist only the complete reconciled `model_mapping` value through `POST /admin/accounts/bulk-update` with one explicit account ID. The backend's JSONB top-level merge preserves base URL, API key, header overrides, pool mode, endpoint capabilities, compact mappings, and every unrelated credential field.
- Do not use the single-account full-credentials `PUT` path for model persistence because omitted non-sensitive keys are deletion-significant there.
- Report fetched, allowed, excluded, and persisted counts so filtering is visible to the operator.

## Acceptance Criteria

- [x] GPT/OpenAI synchronization persists no Claude/Gemini/other-family IDs.
- [x] Claude/Anthropic synchronization persists no GPT/OpenAI/Gemini/other-family IDs.
- [x] Missing, conflicting, unsupported, or account-mismatched group platforms produce an explanation and no upstream or update request.
- [x] Stale and wrong-family identity mappings are removed, current allowed identity mappings are added, and existing manual non-identity mappings remain unchanged even when their source key conflicts with a fetched model.
- [x] A successful update preserves every unrelated credential field and rereads the saved model state.
- [x] Empty allowed results require explicit handling and never silently erase configuration.
- [x] Pure-function tests cover case normalization, accepted model families, excluded near-matches, conflicting groups, and credential-preserving payload construction.

## Out of Scope

- Group-name heuristics, backend model-sync changes, automatic polling, or model request probes.
- Gemini, Grok, and Antigravity model-family policy.

## Parent Requirements

Implements parent requirements R9-R10 and the sync portion of R11.
