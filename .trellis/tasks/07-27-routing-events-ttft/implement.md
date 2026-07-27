# Routing Events and TTFT Implementation Plan

## 1. Scope Hit-Change Events

- [x] Add/export route-scope normalization and equality helpers.
- [x] Extend observation snapshot normalization/building with a bounded per-scope last-hit map containing group, platform, model, and scope key.
- [x] Require complete equal scopes before emitting hit-change events and include scope in event IDs/metadata.
- [x] Render group/platform/model metadata with hit-change events.
- [x] Preserve legacy snapshot loading, discard unverifiable unscoped legacy hit events, and retain independent baselines for interleaved scopes.

## 2. TTFT Evidence

- [x] Add/export strict TTFT row normalization, percentile, aggregation, and request-enrichment helpers.
- [x] Add a bounded `/admin/usage` fetch for the rolling 24-hour streaming window.
- [x] Add controller TTFT snapshot/loading/error/freshness/request-sequence state with a one-minute refresh interval.
- [x] Trigger stale TTFT refreshes after successful visible-panel reads without blocking the base refresh.
- [x] Enrich request history by request ID and render request-level TTFT.
- [x] Render compact per-account P90/P50/latest/count evidence with freshness and coverage titles.
- [x] Keep stale prior evidence labeled on read failure and show no-data state for accounts without valid samples.

## 3. Verify

- [x] Prove cross-group, cross-platform, cross-model, missing-scope, same-account, and same-request observations emit no hit-change event.
- [x] Prove a same-scope account transition emits one deduplicated event.
- [x] Prove interleaved different-scope traffic neither emits a false transition nor suppresses a later same-scope transition.
- [x] Test valid zero/nonzero TTFT, null, missing, negative, non-numeric, old, duplicate, capped, stale, and empty inputs.
- [x] Static-search every TTFT call path and prove no scheduler write is reachable.
- [x] Run established event retention, request normalization, reliability, route history, and model lookup regressions.
- [x] Run `node --check sub2-smart-group.user.js` and `git diff --check`.

## Rollback Points

- Route-scope snapshot fields are backward-compatible additions.
- TTFT state is memory-only; rollback leaves no user storage or server data behind.
