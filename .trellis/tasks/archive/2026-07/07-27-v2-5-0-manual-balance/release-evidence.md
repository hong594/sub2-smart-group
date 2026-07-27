# v2.5.0 Release Evidence Snapshot

Captured during Trellis planning on 2026-07-27. This file contains no credentials.

## Confirmed Implementation State

- `sub2-smart-group.user.js:5` identifies v2.5.0, and the runtime fallback is also reported as v2.5.0.
- Tampermonkey grants and explicit `@connect` hosts are present; wildcard connectivity is not used.
- Balance configuration is stored under keys scoped by current sub2 origin and account ID.
- Saved secrets are not prefilled into balance editor input values.
- Newly typed credentials are bound to the provider and canonical upstream origin active at input time. Provider changes clear all typed credential fields, and origin changes clear mismatched drafts.
- Upstream balance requests are routed through the manual query handler with trusted-event and explicit capability checks.
- A JavaScript timeout watchdog, anonymous request mode, fixed endpoint construction, and exact final-URL comparison are present.
- `sub2api` validity follows `is_active ?? isValid ?? true` with normal JavaScript truthiness, while monetary values remain strictly finite.
- Today's evidence requires an explicit same-day fetch timestamp no older than 30 seconds. Evidence expires in place before editor interaction blocks polling or list reconstruction.
- README already contains the intended v2.5.0 behavior and security documentation.

## Verification Results

- Two temporary Node assertion harnesses passed and were deleted. They covered URL and storage isolation, fixed request contracts, credential draft binding, validity fallback, strict numeric parsing, newapi conversion, evidence freshness, runway boundaries, and existing exported-function regressions.
- Static review confirmed one privileged `GM_xmlhttpRequest` call path and only trusted-click callers with the explicit user-initiated capability guard.
- Secret-output, credential-pattern, userscript metadata/allowlist, and temporary-artifact scans passed.
- `node --check sub2-smart-group.user.js` and full staged-shape `git diff --check` passed.
- Trellis-generated Python, JSON, and TOML artifacts passed syntax parsing.
- Quality review fixed missing/future evidence handling, fetch-time runway calculation, non-finite usage normalization, literal final-URL validation, fixed synchronous request errors, and locale-independent hostname normalization.

## Verification Limits

- The local sub2 browser page was reachable but had no authenticated administrator session.
- No admin token or upstream balance credential was requested, stored, or synthesized for testing.
- Final confidence therefore distinguishes the completed pure/static verification from an authenticated live upstream-query test, which remains unperformed by design.

## Release Authorization

The standing project rule authorizes committing and pushing verified changes to the `hong594/sub2-smart-group` userscript so Tampermonkey can update. That authorization does not extend to backend account settings, scheduler settings, containers, credentials, or other infrastructure.

## Publication

- Feature commit: `7d4f1e3` (`feat(v2.5.0): add manual upstream balance monitoring`)
- Trellis initialization commit: `ccf90a1` (`chore: initialize Trellis project workflow`)
- Published branch: `origin/main`
- Push result: `771b9c7..ccf90a1  main -> main`
