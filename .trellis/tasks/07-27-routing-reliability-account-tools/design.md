# Routing Reliability and Account Tools Design

## Boundaries

The product implementation remains inside `sub2-smart-group.user.js`. `README.md` and Trellis artifacts document and verify the release. No sub2api, database, container, CC Switch configuration, or runtime state is modified.

The userscript continues to use the current same-origin Admin API wrapper. Cross-origin network access remains exclusive to the existing manual balance feature; account creation and model discovery send credentials only to the logged-in sub2api origin, which performs upstream calls server-side.

## Architecture

The script keeps its current factory/controller shape:

- Pure helpers own normalization, state transitions, filtering, aggregation, payload construction, and reconciliation.
- `Sub2Controller` owns transient UI state, request sequencing, rendering, and calls to boundary helpers.
- CommonJS exports expose all new pure helpers for focused Node assertions.
- No new package, framework, storage backend, or userscript permission is introduced.

The four child deliverables execute in this order:

1. `07-27-fix-controls-audit` establishes exclusive editor state and canonical audit rendering.
2. `07-27-routing-events-ttft` fixes route scope and adds read-only TTFT evidence.
3. `07-27-group-aware-model-sync` introduces the shared GPT/Claude model-family and mapping-reconciliation helpers.
4. `07-27-one-click-account-create` reuses those model helpers for safe platform detection and initial mappings.

The parent then performs integration regression coverage, documentation/version updates, and publication checks.

## Data Flows

### Read-Only Refresh

```text
accounts + groups + today stats + Ops history
                  |
                  +--> normalized account/routing state --> cards, audit, events

admin usage (bounded 24h TTFT read, memory only)
                  |
                  +--> request-id TTFT index + account percentiles --> history/cards
```

TTFT refreshes independently from the 10-second account loop and never blocks the base account render. It retains explicit freshness and pagination coverage so a capped sample is not presented as a complete distribution.

### One-Click Account Creation

```text
trusted Add click --> transient URL/key modal
  --> validate URL
  --> same-origin OpenAI + Anthropic preview candidates
  --> exactly one family succeeds
  --> resolve mandatory compatible group
  --> review name/group/defaults/model count
  --> idempotent same-origin account create
  --> clear key state and refresh accounts
```

No candidate result, ambiguous candidate result, or missing compatible group can reach the create boundary.

### Group-Aware Model Synchronization

```text
trusted model-sync click
  --> resolve one platform from canonical memberships
  --> fetch upstream models
  --> keep approved family
  --> reconcile identity mappings, preserve manual mappings
  --> one-account bulk credentials merge for model_mapping only
  --> reread saved model evidence
```

An empty allowed result, conflicting membership platform, or failed fetch performs no write.

## State and Credential Safety

- One controller-level active editor state identifies account, editor kind, draft, credential contexts, and focus metadata. Filters may rebuild the list while preserving a still-visible editor draft.
- Leaving or switching away from a balance editor clears its unsaved secret fields. Draft credentials remain bound to account plus provider/origin context.
- TTFT, preview results, and API-key creation state are memory-only. They never use GM storage or page `localStorage`.
- The account API key is a password input value and transient request payload only. Completion, cancellation, terminal failure, or modal teardown clears the field and controller references.
- Model mapping writes use the backend's top-level JSONB merge endpoint, never a full credentials `PUT`.

## Compatibility and Release

- Preserve existing storage keys and serialized event compatibility. Replace the single global latest-hit comparison with a bounded per-scope last-hit map. Old observation snapshots without complete route scope are accepted for migration but cannot generate hit-change events; complete legacy hits may seed only their exact scope.
- Preserve current account, group, Ops, quota, capacity, balance, and scheduler API behavior.
- Account creation can set only account-level priority. The backend assigns membership priority `1` for a single `group_ids` binding and exposes no Admin endpoint for changing that membership priority, so the review distinguishes both values and the refreshed account is the source of truth after creation.
- Keep automatic activity read-only. The only new upstream work is caused by explicit preview, create, or model-sync actions. The official backend may perform its built-in OpenAI capability probe after creation; the userscript does not call probe endpoints.
- Release as `2.6.0` because this adds user-facing features without changing installation or persisted-storage compatibility.

## Rollback

There is no schema or backend migration. Rollback is the userscript/README commit set. Existing account mappings changed by an operator-confirmed model reconciliation are server data and are not reverted by downgrading the script, so the UI must show additions/removals before destructive reconciliation and never write on ambiguous or empty evidence.
