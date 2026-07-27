# One-Click Account Creation Implementation Plan

## Dependency

- [x] Start only after `07-27-group-aware-model-sync` has landed the shared model-family helpers.

## 1. Pure Input and Resolution Helpers

- [x] Add/export base-URL normalization with HTTPS plus loopback-HTTP policy.
- [x] Add/export candidate preview evaluation using the shared model-family policy.
- [x] Add/export compatible group collection and selection resolution.
- [x] Add/export stable unique-name, conservative account-priority, identity-mapping, and create-payload builders.

## 2. Modal and API Boundaries

- [x] Add the compact header action, overlay, stable responsive controls, and input/review states.
- [x] Keep the API key in one password input/controller reference only and bind it to normalized destination context.
- [x] Add preview helpers for OpenAI and Anthropic candidates through `/admin/accounts/models/sync-upstream-preview`.
- [x] Require exactly one valid candidate and one selected compatible group before enabling create.
- [x] Add optional request headers to the same-origin API helper without changing existing call behavior, then send `Idempotency-Key` on create.
- [x] Disable duplicate submits and guard late preview/create responses with request sequences.
- [x] Clear all key/preview/idempotency state on success, cancel, close, or terminal reset; refresh after success.
- [x] Label priority as account-level in review and show the backend-assigned group membership priority after the success refresh.

## 3. Verify

- [x] Test supported HTTPS and loopback HTTP URLs plus credential/query/fragment/protocol rejection.
- [x] Test key destination binding and prove no key reaches GM/local storage, text, errors, diagnostics, logs, clipboard, README, or task files.
- [x] Test OpenAI-only, Anthropic-only, zero, dual, mixed-family, and failed preview outcomes.
- [x] Test compatible-filter preselection, sole-group auto-selection, multi-group required choice, inactive/no-group blocking, and no ungrouped payload.
- [x] Test name suffixes, conservative account priority, post-create membership display, filtered model mappings, exact create payload, idempotency, and double-click protection.
- [x] Test retryable HTTP statuses with the backend's nonzero response `code`; preserve `408`, `425`, `429`, `5xx`, network failures, and only the two idempotency retry reasons on `409`.
- [x] Static-search to prove preview/create are reachable only from trusted click handlers.
- [x] Run all shared model-policy, API wrapper, overlay, `node --check`, and `git diff --check` regressions.

## Rollback Points

- Pure validators/resolvers can be verified before the modal is connected.
- Preview is read-only; creation is the only server mutation and is idempotency guarded.
- No userscript storage schema or backend schema changes.
