# Account Controls and Audit Design

## Exclusive Editor State

Replace DOM discovery as the source of truth with one controller state:

```javascript
activeEditor = null
// or
{
  accountId,
  kind: 'balance' | 'capacity' | 'quota',
  draft,
  focusField,
  selectionStart,
  selectionEnd,
}
```

A pure transition helper receives the current key and a requested account/kind. Requesting the active key returns `null`; every other valid request returns the new key. The controller wrapper owns draft creation/cleanup, refresh invalidation, and rendering.

The active editor is included in `isAccountInteractionActive()` so background refresh remains paused. `renderList()` no longer aborts for balance editing, allowing all filters and sorting to work.

## Draft and Render Behavior

- Every editor input updates the active in-memory draft before any list rebuild.
- Balance draft fields retain the v2.5 provider/origin credential-context binding and add account ID as an invariant.
- Sort/filter rebuilds restore the editor, values, focus field, and selection when the active account remains visible.
- If a filter removes the active account, or the user closes/switches editors, clear the active state. Unsaved balance secrets are discarded rather than retained invisibly.
- Save failure leaves the same editor/draft active. Save success clears state before refresh.
- Querying an already configured balance remains a direct action; only configuration/settings toggles editor state.
- Audit capacity actions open the same unified capacity state with the suggested value rather than searching for a local DOM node.

## Canonical Audit Rendering

`renderAuditDrawer()` obtains exactly one audit snapshot from:

```javascript
sub2BuildConfigAudit({ accounts, groupsById }, now)
```

It renders `severityCounts` and each finding's canonical `category`, `title`, `detail`, and `evidence`. Categories are human-readable section headings; no raw object becomes a key or text label. `sub2GetGroupMemberships()` remains the sole membership normalizer inside audit helpers.

Capacity advice remains a separate section built from `sub2BuildCapacityAdvice()` and may offer a capacity-editor action. It is not duplicated into audit findings or severity counts.

## Compatibility

- No balance storage format changes.
- No account write payload changes.
- Existing scroll preservation, background refresh pause, and credential destination binding remain intact.
- New pure editor-transition/draft helpers are CommonJS-exported for Node assertions.

## Verification

Test same-control close, cross-control switch, cross-account switch, filter-keeps-editor, filter-hides-editor, sort rebuild, save failure, and credential-context isolation. Audit fixtures must cover `account_groups`, object-form `groups`, ID-form `groups`, duplicate memberships, missing names, and readable category/severity output.
