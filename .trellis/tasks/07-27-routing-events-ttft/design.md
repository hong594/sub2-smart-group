# Routing Events and TTFT Design

## Route-Scoped Hit Changes

Add pure route-scope helpers that normalize a request into:

```javascript
{
  groupId,          // positive integer
  platform,         // trimmed lower-case string
  model,            // canonical requested-model string
  key,              // groupId + platform + model
  complete,         // true only when every field is present
}
```

Model normalization reuses the script's requested-model canonicalization and then applies stable case normalization for comparison. It never derives scope from account names, display labels, or timestamps.

Observation snapshots persist a bounded map of the latest successful hit per complete scope. A new observation updates only its own scope, so unrelated interleaved traffic cannot be compared with it or erase its comparison baseline. Snapshot normalization accepts older stored objects; a complete legacy hit may seed its exact scope, while incomplete legacy state cannot emit a change. A hit-change event requires:

- two different positive account IDs;
- two distinct request keys;
- complete scopes on both observations; and
- identical route-scope keys.

Event IDs and metadata include scope. Event rendering resolves the group name from `groupsById` and shows group/platform/model evidence so an operator can see why the transition is considered comparable.

## TTFT Read Path

Add a dedicated, read-only `GET /admin/usage` fetch with:

- `page=1&page_size=1000`;
- newest-first ordering;
- `stream=true`;
- yesterday-through-today date bounds plus browser timezone; and
- an exact client-side `now - 24h` cutoff.

The broad date bounds make the backend query timezone-safe; the client cutoff makes the displayed window rolling rather than calendar-day based. A one-minute memory cache and independent request-sequence guard prevent the 10-second base refresh from repeatedly issuing the heavier query.

The fetch runs only while the panel is visible and never blocks account/route rendering. On failure, retain the last snapshot as stale evidence and expose the read error without fabricating samples.

## Normalization and Aggregation

Pure helpers normalize usage rows into request ID, account ID, group ID, model, stream flag, timestamp, duration, and TTFT. `first_token_ms` is valid only when it is finite and non-negative; `null`, missing, negative, and non-numeric values are excluded.

The snapshot contains:

- a request-ID index for enriching recent request history;
- per-account sorted samples within the rolling window;
- nearest-rank P50 and P90;
- latest TTFT and latest timestamp;
- sample count;
- generated/fetched timestamps; and
- pagination coverage (`complete` or capped latest-sample evidence).

Duplicate usage rows with the same stable request ID contribute once. Rows without a request ID may still contribute to account aggregates but cannot enrich request history.

## Rendering

- Request history rows display `首字` when a direct Ops field or usage request-ID match provides TTFT; otherwise the field is omitted.
- Account cards render one compact, stable-height TTFT line: P90 primary, then P50, latest, and sample count. A title exposes the exact 24-hour window, freshness, and coverage.
- Accounts with no valid sample show `首字暂无样本` without treating total duration as TTFT.
- Capped or stale snapshots are labeled as sample evidence. No percentile threshold maps to health tone or scheduler state.

## Scheduling Boundary

TTFT helpers are data-only and rendering-only. They receive no controller methods and cannot call schedulable, priority, capacity, quota, recover-state, or balance boundaries. The existing manual scheduling button remains unchanged.

## Verification

Cover scope equality/inequality/incompleteness, legacy snapshots, event IDs, valid/invalid TTFT values, exact 24-hour filtering, duplicate requests, nearest-rank percentiles, latest selection, pagination coverage, request-history enrichment, and empty/stale/error evidence.
