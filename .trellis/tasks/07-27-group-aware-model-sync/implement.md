# Group-Aware Model Synchronization Implementation Plan

## 1. Pure Policy and Reconciliation

- [x] Add/export strict real-group-platform resolution with missing/conflict/account-mismatch states.
- [x] Add/export shared GPT/OpenAI and Claude model-family classification with explicit exclusions/reasons.
- [x] Add/export fetched-model normalization and mapping reconciliation helpers.
- [x] Return deterministic counts/lists for allowed, excluded, added, removed, preserved, conflicts, and final mapping.

## 2. Boundary and Drawer Flow

- [x] Change `sub2SyncAccountModels()` to return the upstream `{ models }` list rather than rereading unchanged saved data.
- [x] Add the one-account `/admin/accounts/bulk-update` mapping boundary.
- [x] Read current account detail, resolve platform, fetch, filter, reconcile, and stop on ambiguous/empty evidence.
- [x] Require confirmation before any identity removals, then persist only `credentials.model_mapping`.
- [x] Reread saved models/account state after success and show reconciliation counts in the drawer.
- [x] Preserve request-sequence and disabled-button guards.

## 3. Verify

- [x] Test GPT/OpenAI allowed families and image/audio/realtime/transcription/embedding/vendor exclusions.
- [x] Test Claude allowed family and GPT/Gemini/vendor exclusions.
- [x] Test manual-mapping preservation, source-key conflicts, stale/wrong-family identity removal, deterministic additions, no-op, empty results, and missing/conflicting/account-mismatched group platforms.
- [x] Assert the update path uses one explicit account ID and only the `model_mapping` credential key.
- [x] Static-search to prove no timer/background path reaches upstream sync or mapping writes.
- [x] Run saved-model, routing eligibility, audit, request helper, `node --check`, and `git diff --check` regressions.

## Rollback Points

- The family/reconciliation helpers can land before the boundary switch and are reused by account creation.
- No write occurs on fetch errors, ambiguity, empty allowed lists, rejected removal confirmation, or no-op mappings.
