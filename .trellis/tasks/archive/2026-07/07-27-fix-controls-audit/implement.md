# Account Controls and Audit Implementation Plan

## 1. Editor State

- [x] Add pure editor-key/transition helpers and export them.
- [x] Add controller-level `activeEditor` state and draft/focus capture helpers.
- [x] Replace `hasOpenQuotaEditor()`, `hasOpenCapacityEditor()`, and `hasOpenBalanceEditor()` as state authorities; keep DOM checks only if needed as assertions/compatibility guards.
- [x] Route balance, capacity, quota, audit-suggestion, cancel, save-success, and save-failure actions through the unified state.
- [x] Remove the balance-editor early return from `renderList()` and preserve a still-visible active draft across rebuilds.
- [x] Clear the editor and sensitive draft when filtering hides its account or the user switches/closes it.

## 2. Audit Rendering

- [x] Replace drawer-local finding construction with `sub2BuildConfigAudit()` output.
- [x] Render canonical categories, severity labels/counts, titles, details, and evidence.
- [x] Render `sub2BuildCapacityAdvice()` separately and connect any action to the unified capacity editor.
- [x] Preserve drawer scroll and overlay close behavior.

## 3. Verify

- [x] Run focused editor transition/draft assertions, including account/provider/origin credential isolation.
- [x] Confirm invalid account IDs or editor kinds leave the current editor and draft untouched.
- [x] Run canonical membership/audit fixtures proving no `[object Object]` or object-identity duplication.
- [x] Reject non-primitive group labels and cover malformed or blank group metadata with readable fallbacks.
- [x] Confirm group/platform/health/text/sort/view changes rebuild while an editor is open.
- [x] Confirm a late capacity/quota save cannot close or erase a newer editor draft, including a same-key reopen.
- [x] Run the existing balance, quota, capacity, audit, scroll, and refresh-pause regression assertions.
- [x] Run `node --check sub2-smart-group.user.js` and `git diff --check`.

## Rollback Points

- The editor reducer/state can be reverted independently from audit rendering.
- No server schema or persisted userscript storage is changed.
