# Routing Events and TTFT Contract

## 1. Scope / Trigger

Use this contract whenever `sub2-smart-group.user.js` changes local
`hit-change` events, request observation snapshots, Admin usage reads,
request-level first-token latency, or account TTFT summaries.

The userscript may observe these signals, but it must not turn TTFT into an
automatic scheduling policy.

## 2. Signatures

The implementation keeps these pure helpers available through CommonJS for
focused Node assertions:

```javascript
sub2NormalizeRouteScope(request) -> {
  complete, groupId, platform, model, key
}
sub2RouteScopesEqual(left, right) -> boolean
sub2BuildObservationSnapshot(accounts, recentRequest, now?, previous?)
sub2BuildObservationTransitionEvents(previous, current, now?) -> event[]
sub2NormalizeTTFTValue(value) -> number | null
sub2NormalizeTTFTUsageRow(row) -> normalizedRow | null
sub2NearestRankPercentile(values, percentile) -> number | null
sub2BuildTTFTSnapshot(payload, now?, fetchedAt?) -> ttftSnapshot
sub2EnrichRequestHistoryWithTTFT(history, snapshot) -> request[]
sub2BuildAccountTTFTEvidence(accountId, snapshot, state?, now?) -> evidence
sub2BuildTTFTUsagePath(now?, timezone?) -> string
```

The read boundary is:

```http
GET /api/v1/admin/usage
  ?page=1
  &page_size=1000
  &sort_by=created_at
  &sort_order=desc
  &start_date=YYYY-MM-DD
  &end_date=YYYY-MM-DD
  &timezone=<browser-zone>
  &stream=true
```

Relevant response fields are `request_id`, `account_id`, `group_id`,
`requested_model` or `model`, `stream`, `created_at`, `duration_ms`, and
nullable `first_token_ms`.

## 3. Contracts

### Route-Scoped Hit Changes

- A comparable route scope is complete only when positive `groupId`, normalized
  lower-case `platform`, and normalized requested `model` are all present.
- Snapshots retain at most 100 latest successful observations, indexed by exact
  scope key. A request updates only its own scope baseline.
- A `hit-change` requires different positive account IDs, different request
  keys, non-decreasing observation time, and equal complete scope keys.
- An interleaved request in another scope neither compares with nor erases the
  previous baseline for the first scope.
- Stored legacy snapshots with incomplete scope cannot seed a transition.
  Stored legacy `hit-change` events without complete scope are discarded during
  normalization because their correctness cannot be proven after upgrade.
- Event metadata carries group ID, platform, model, and request ID. Rendering
  resolves the group display name through `groupsById`.

### TTFT Evidence

- `first_token_ms` is valid only for streaming rows and only when it is a finite,
  non-negative number or numeric string. Zero is valid. Null, missing, negative,
  non-numeric, boolean, and non-streaming values are unavailable.
- Never substitute `duration_ms` for missing TTFT.
- The client reads at most the newest 1000 streaming rows, then applies an exact
  rolling 24-hour timestamp cutoff. Duplicate stable request IDs contribute at
  most once; rows without request IDs may still contribute to account samples.
- Per-account output uses nearest-rank P90 as the primary signal and also
  exposes P50, latest sample, sample count, freshness, and pagination coverage.
- Request history is enriched only by exact request ID. An Ops TTFT value wins
  over usage enrichment; stale usage-derived values are cleared when absent
  from a newer snapshot.
- The TTFT cache is memory-only and refreshed at most once per minute while the
  panel is visible. A failed refresh preserves prior evidence but labels it
  stale; account and routing refreshes continue independently.

### Scheduling Boundary

TTFT code may call only the read path above. It must not call schedulable,
recover-state, priority, capacity, quota, balance, account-update, or model-sync
write boundaries. The operator remains responsible for manual scheduling.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Group, platform, or requested model differs | No hit-change event |
| Any route-scope field is missing | No hit-change event |
| Account or request identity is unchanged | No hit-change event |
| Another scope is observed between two same-scope hits | Preserve the first scope baseline |
| Stored hit-change lacks complete scope | Drop it during local-event normalization |
| `first_token_ms` is zero | Keep it as a valid sample |
| TTFT is null, invalid, negative, or non-streaming | Exclude it; do not use duration |
| More than 1000 matching usage rows exist | Label output as latest-sample/capped evidence |
| Usage fetch fails with an older snapshot | Keep and label stale evidence |
| Usage fetch fails without a snapshot | Show unavailable evidence; keep base refresh working |

## 5. Good / Base / Bad Cases

- Good: group 10/OpenAI/GPT-4o moves from account 1 to account 2 and emits one
  event whose metadata proves that exact scope.
- Base: group 20/Anthropic/Claude traffic occurs between those two observations;
  it creates no cross-route event and does not suppress the later valid event.
- Good: an account card shows `P90`, `P50`, latest, sample count, and whether the
  newest 1000 rows cover the full window.
- Bad: comparing only the globally latest account IDs, which can render an
  unrelated `A -> B` pair as a routing transition.
- Bad: treating total request duration as first-token latency or automatically
  disabling an account because its P90 is high.

## 6. Tests Required

Before release, focused assertions and static checks must cover:

- Cross-group, cross-platform, cross-model, incomplete-scope, same-account,
  same-request, same-scope, out-of-order, and interleaved observations.
- Legacy incomplete snapshots and unscoped stored hit-change events.
- Zero, valid, null, missing, negative, non-numeric, boolean, non-streaming,
  old, duplicate, capped, stale, error, and empty TTFT inputs.
- Nearest-rank P50/P90, latest-sample selection, exact request-ID enrichment,
  and clearing of stale usage-derived request values.
- Card, history, replay, and event metadata rendering projections.
- A source scan proving TTFT fetch/refresh paths contain no scheduling or
  account-write calls.
- `node --check sub2-smart-group.user.js` and `git diff --check`.

## 7. Wrong vs Correct

### Wrong

```javascript
if (previous.latestHit.accountId !== current.latestHit.accountId) {
  emitHitChange(previous.latestHit, current.latestHit);
}

const firstTokenMs = row.first_token_ms ?? row.duration_ms;
```

This compares unrelated traffic and fabricates TTFT when the upstream did not
record a first-token sample.

### Correct

```javascript
const scope = sub2NormalizeRouteScope(current.latestHit);
const previousHit = previous.lastHitsByScope[scope.key];
if (sub2RouteScopesEqual(previousHit.scope, scope)) {
  // Also require distinct accounts and request keys before emitting.
}

const firstTokenMs = row.stream === true
  ? sub2NormalizeTTFTValue(row.first_token_ms)
  : null;
```

Comparable routing evidence shares one exact scope, and TTFT remains a strict
projection of the recorded streaming field.
