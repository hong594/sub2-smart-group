# v2.5.0 Manual Balance Monitoring Implementation Plan

## 1. Close Release Blockers

- [x] Add a small canonical provider/origin context helper suitable for pure-function testing.
- [x] Bind newly typed API Key, Access Token, and User ID values to their input-time context.
- [x] Clear or discard typed credentials when provider or canonical origin changes; preserve exact-match reuse of persisted credentials.
- [x] Move in-place evidence expiry ahead of the account-interaction early return in the one-second timer.
- [x] Align `sub2api` validity handling with `is_active ?? isValid ?? true` without boolean-only rejection.
- [x] Export the today-stat availability helper and any new pure helper needed by focused assertions.

## 2. Verify Security and Behavior

- [x] Recreate a temporary Node assertion file covering URL restrictions, storage-key isolation, fixed requests, strict numeric parsing, newapi conversion, validity truthiness, credential context changes, low-balance behavior, and evidence freshness.
- [x] Include the established regression baseline for request history, reliability snapshots, event pruning, restrictions, config audit, and capacity advice.
- [x] Run the assertions and delete the temporary file.
- [x] Search for all calls to the privileged balance-query function and confirm there is no startup, timer, visibility, or automatic refresh path.
- [x] Confirm saved secrets are never assigned to DOM input values or written to localStorage, diagnostics, logs, or exports.
- [x] Run `node --check sub2-smart-group.user.js`.
- [x] Run `git diff --check` and review line-ending warnings separately from actual whitespace errors.

## 3. Documentation and Diff Review

- [x] Reconcile README claims with final implementation behavior, especially the 30-second evidence expiry and credential destination binding.
- [x] Confirm `@version` and fallback version are both `2.5.0`.
- [x] Review all tracked and untracked files; retain Trellis initialization/task artifacts and remove temporary artifacts.
- [x] Confirm no real tokens, API keys, admin credentials, or environment files appear in the diff.

## 4. Publish

- [x] Run a final Trellis check against PRD acceptance criteria.
- [x] Record relevant reusable conventions in Trellis specs if this task establishes them.
- [x] Commit the reviewed Trellis initialization and v2.5.0 iteration using repository-style commit messages.
- [x] Push the normal branch to the existing GitHub remote under the standing userscript publication authorization.
- [x] Archive the task only after push succeeds and record the final commit in task/session metadata.

## Rollback Points

- Before product-code edits: task artifacts capture the current release gaps.
- Before commit: the working tree remains locally reviewable and no remote state has changed.
- Before task archive: a failed push leaves the task active with verification evidence intact.
