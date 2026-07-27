# Release v2.5.0 manual upstream balance monitoring

## Goal

Release a safe, user-initiated upstream balance view for each sub2 account so the operator can inspect remaining balance, today's observed cost, and a bounded runway estimate without adding backend behavior or active probes.

## Background

- The userscript is already partially updated from v2.4.1 to v2.5.0.
- The operator approved Tampermonkey `GM_*Value` storage after being told that it is persistent but not an encrypted vault.
- Upstream credentials are account-specific and must also be isolated by the current sub2 origin.
- The remaining work is a release-hardening iteration, not a redesign of sub2 or its routing behavior.

## Requirements

- **R1 - Explicit user action:** A balance request may run only after a trusted user click on query or save-and-query. Startup, refresh timers, visibility changes, and account polling must never initiate an upstream balance request.
- **R2 - Supported contracts:**
  - `sub2api` uses `GET <baseUrl>/v1/usage` with `Authorization: Bearer <apiKey>`.
  - `newapi` uses `GET <baseUrl>/api/user/self` with the approved headers and converts `quota` and `used_quota` by dividing each value by `500000`.
- **R3 - Destination restrictions:** The base URL must be an approved HTTPS root URL on the explicit userscript `@connect` allowlist, without credentials, path, query, fragment, or custom port. Redirected responses must be rejected.
- **R4 - Credential isolation:** Persistent balance configuration must be scoped by current sub2 origin and account ID. Saved secrets must not be copied into page DOM, localStorage, logs, diagnostics, exports, or clipboard output.
- **R5 - Draft credential binding:** A credential typed in the editor must be usable only with the provider and canonical upstream origin that were active when it was typed. Changing provider or origin must invalidate the typed credential and require re-entry. Reuse of a saved credential requires an exact provider and origin match.
- **R6 - Response compatibility:** `sub2api` validity must follow the approved nullish fallback contract `is_active ?? isValid ?? true`; the implementation must not impose a new boolean-only schema. Malformed monetary values must still be rejected.
- **R7 - Evidence boundaries:** Today's request and cost data may be described only as today's statistics. Runway may be estimated only for USD balance when same-local-day statistics are available, no older than 30 seconds, cover at least one elapsed hour, and show positive cost.
- **R8 - Live evidence expiry:** When today's statistics become stale, balance and request summaries must be updated in place even while an account editor is open. The list must not be rebuilt solely for this expiry because that would discard drafts or move the scroll position.
- **R9 - Failure isolation:** Balance failures may update only balance UI state; they must not alter sub2 account validity, routing, health, or scheduler settings.
- **R10 - Documentation and release:** README behavior and security documentation, metadata version, and runtime fallback version must all describe v2.5.0 consistently. After verification, publish the userscript repository according to the standing release authorization.

## Acceptance Criteria

- [ ] Both userscript version locations and README current-version text identify v2.5.0.
- [ ] Static call-path review shows exactly one privileged balance-query entry path, gated by a trusted click and an explicit user-initiated capability.
- [ ] Provider/origin changes cannot send a previously typed or persisted credential to the new destination.
- [ ] Stored secrets remain absent from input values and all non-GM storage/output paths.
- [ ] URL, endpoint, header, anonymous-request, redirect, timeout, and response parsing behavior match R2-R6.
- [ ] `is_active: 1` is accepted and `is_active: 0` is treated as inactive under the approved fallback contract.
- [ ] Fresh USD evidence can produce a runway estimate; stale, cross-day, unavailable, short-window, zero-rate, and non-USD evidence cannot.
- [ ] Evidence summaries expire in place after 30 seconds while editors remain open, without rebuilding account rows.
- [ ] Focused balance assertions and existing exported-function regression assertions pass after the final edits.
- [ ] `node --check sub2-smart-group.user.js` and `git diff --check` pass, and no temporary test or credential file remains.
- [ ] The final reviewed diff contains only the intended userscript, README, and Trellis initialization/task artifacts, then is committed and pushed to the repository's normal remote branch.

## Out of Scope

- Key-by-account cost matrices, which remain deferred to v2.6.0 and require real HTTP evidence.
- sub2 backend changes, new backend endpoints, database inference, container rebuilds, scheduler changes, or credential/infrastructure changes.
- Model requests, account test/probe calls, balance polling, startup queries, and synthetic health checks.
- Additional upstream hosts, custom endpoint paths, custom ports, or user-configurable request headers.
