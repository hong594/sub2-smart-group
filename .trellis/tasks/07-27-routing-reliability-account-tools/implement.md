# Routing Reliability and Account Tools Implementation Plan

## 1. Implement Child Deliverables

- [ ] Start, implement, verify, and finish `07-27-fix-controls-audit`.
- [ ] Start, implement, verify, and finish `07-27-routing-events-ttft`.
- [ ] Start, implement, verify, and finish `07-27-group-aware-model-sync`.
- [ ] Start, implement, verify, and finish `07-27-one-click-account-create` after the shared family helpers exist.
- [ ] Keep the parent in planning/integration ownership while child work is active; do not mix unrelated Trellis/Codex configuration changes into child commits.

## 2. Integrate the Release

- [ ] Run a full regression assertion pass across every exported helper and previously covered balance, routing, audit, capacity, quota, and reliability behavior.
- [ ] Verify that all write boundaries remain reachable only from trusted user actions and that no TTFT path references scheduler writes.
- [ ] Verify that API keys never reach GM storage, page storage, DOM output, logs, diagnostics, errors, clipboard paths, task artifacts, or README examples.
- [ ] Update userscript metadata/runtime fallback to `2.6.0`.
- [ ] Update README current-version notes, feature behavior, API boundaries, security boundaries, evidence limits, and validation coverage.
- [ ] Review the final diff against parent R1-R13 and all child acceptance criteria.

## 3. Validation Commands

- [ ] Create a temporary Node assertion file outside the tracked product surface, execute it, and remove it after success.
- [ ] Run `node --check sub2-smart-group.user.js`.
- [ ] Run the focused Node assertions covering editor transitions, canonical audit rendering data, route scope, TTFT normalization/percentiles, model policy/reconciliation, URL validation, platform detection, group resolution, account payloads, and the established regression baseline.
- [ ] Run static searches proving preview/create/model-sync calls have no timer/startup/visibility path and TTFT has no scheduler-write path.
- [ ] Run secret-pattern and repository-artifact scans.
- [ ] Run `git diff --check` and inspect the complete intended diff.
- [ ] Run `py -3 ./.trellis/scripts/task.py validate` for each active child and the parent as appropriate.

## 4. Publish

- [ ] Run a final full-scope `trellis-check` after all children are integrated.
- [ ] Review whether the editor-state, route-scope, credential-merge, or transient-key contracts should be promoted into `.trellis/spec/`.
- [ ] Present the Trellis commit plan, excluding the nine pre-existing unrelated Trellis/Codex configuration modifications.
- [ ] Commit the reviewed product/task changes in coherent batches and push `main` to the existing remote under the user's standing publication request.
- [ ] Archive completed child tasks and the parent only after the push is verified, then record the session journal.

## Risk and Rollback Points

- Before each child: its PRD/design/implementation artifacts are the rollback boundary.
- Before model persistence: no write occurs until the fetched family is non-empty and any removal is explicitly shown/confirmed.
- Before account creation: request sequence, disabled submit state, and one idempotency key guard duplicate creation.
- Before commit: temporary assertions and external source clones must be absent from the repository diff.
- Before push/archive: the branch and remote diff must contain only intended userscript, README, task, and any approved spec files.
