# Scope Routing Events and Expose TTFT

## Goal

Prevent unrelated routes from being presented as account hit changes and expose first-token latency as bounded evidence for manual scheduling decisions.

## Requirements

- Define a complete route scope from group ID, platform, and normalized requested model.
- Keep a bounded last-success observation per complete route scope and emit hit-change events only for distinct accounts in the same scope and for distinct request observations.
- Interleaved observations from other scopes neither compare with this scope nor replace its last-success observation.
- Do not invent scope from account names, last-used timestamps, or incomplete records.
- Normalize `first_token_ms` from admin usage records without confusing it with total duration.
- Read at most the newest 1000 streaming usage rows on a one-minute cache, apply an exact rolling 24-hour cutoff, and retain explicit freshness/pagination coverage.
- Show request-level TTFT plus rolling 24-hour per-account P90 as the primary card signal, with P50, latest sample, sample count, and explicit coverage text.
- Treat null TTFT as unavailable, including non-streaming records that do not produce a first-token sample.
- Keep schedulable changes strictly manual; add no threshold action or background automation.

## Acceptance Criteria

- [x] Cross-group, cross-platform, cross-model, incomplete-scope, same-account, and same-request pairs emit no hit-change event.
- [x] A same-scope change between two accounts emits one deduplicated event with correct account names.
- [x] A different-scope request interleaved between those accounts creates no false event and does not suppress the later same-scope event.
- [x] Valid TTFT samples are rendered and aggregated; invalid, negative, null, and non-streaming samples are excluded.
- [x] Aggregate output includes rolling 24-hour P90, P50, latest sample, sample count, and evidence coverage instead of presenting partial samples as complete account truth.
- [x] TTFT fetch failure retains only clearly stale prior evidence or an unavailable state and does not block the base account refresh.
- [x] No TTFT path calls schedulable, priority, capacity, quota, or recover-state write endpoints.

## Out of Scope

- Automatic account disable/enable, alert-triggered actions, or scheduler policy changes.
- Backend TTFT aggregation endpoints or schema changes.

## Parent Requirements

Implements parent requirements R4-R5 and the no-automation portion of R11.
