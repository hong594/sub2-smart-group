# v2.5.0 Manual Balance Monitoring Design

## Boundaries

The feature remains entirely inside `sub2-smart-group.user.js`. It reads existing sub2 account and today-stat responses, stores only per-account upstream balance configuration through Tampermonkey APIs, and sends a fixed cross-origin request only after an explicit user gesture. No sub2 backend, container, scheduler, or routing behavior changes.

`README.md` documents the user-visible behavior, security boundary, and evidence limitations. Trellis files record the task and verification evidence but must never contain credentials.

## Credential Storage and Editing

Persistent configuration uses one GM storage key per current sub2 origin and account ID. Saved secrets stay in the userscript sandbox and are represented in the page only by an empty password field with a non-secret placeholder.

The editor needs a second, transient isolation layer for newly typed values:

1. Derive a canonical credential context from provider type plus a validated upstream origin.
2. Record that context in closure state when a credential field receives a non-empty value.
3. On provider or base-URL changes, clear any typed credential whose recorded context no longer matches.
4. At save time, accept a typed value only when its recorded context still matches the final canonical context.
5. Fall back to persisted credentials only when persisted provider and origin exactly match the final context.

This defense-in-depth design prevents both persisted and newly typed credentials from crossing destination boundaries. `newapi` Access Token and User ID are treated as one credential set for this purpose.

## Request and Response Contracts

The existing request builder owns endpoint and header construction. User input supplies only an allowlisted root origin and the provider-specific credential set. `GM_xmlhttpRequest` remains anonymous, no-cache, fixed-timeout, and redirect-rejecting; the final URL must equal the expected endpoint exactly.

`sub2api` selects remaining amount, unit, and validity using the approved nullish precedence. Validity is interpreted by normal JavaScript truthiness after fallback, rather than introducing a boolean-only upstream schema. Numeric amount parsing remains strict and rejects null, booleans, arrays, non-finite values, and empty values.

`newapi` requires a successful object response and applies the fixed `500000` divisor to quota values.

## Evidence Freshness and Rendering

Today-stat availability is a pure decision based on response availability, local calendar day, fetch timestamp, and the 30-second freshness limit. The once-per-second timer must update existing balance-summary and request-count nodes before checking whether an editor interaction blocks full list rendering.

Interaction still blocks polling and full row reconstruction. Only text, tone class, and title attributes of evidence nodes change in place, preserving editor drafts, focus, and scroll position.

## Compatibility

- Keep the userscript factory and CommonJS export shape so focused Node assertions can import pure functions.
- Export the today-stat availability helper used by tests.
- Preserve all existing account health, routing, quota, event, and protected-control behavior.
- Keep the existing explicit host allowlist; no wildcard `@connect` permission.

## Verification and Rollback

Verification combines pure-function assertions, static call-path checks, JavaScript syntax validation, diff whitespace validation, and final manual review. A logged-out local browser session is not sufficient evidence for a successful live upstream query; no real credential will be introduced merely to obtain runtime coverage.

If a release blocker cannot be resolved safely, keep the task unarchived and do not publish. Rollback is limited to the v2.5.0 userscript/README changes; no backend or infrastructure migration exists.
