# Account Editors and Audit Contract

## 1. Scope / Trigger

Use this contract whenever `sub2-smart-group.user.js` changes balance, capacity,
or daily-quota editors; list filtering or sorting while an editor is open;
group-membership normalization; configuration audit rendering; or capacity
advice shown from the audit drawer.

The userscript owns transient editor state and rendering. The backend remains
the source of account, group, quota, and concurrency data.

## 2. Signatures

The implementation keeps these pure helpers available through CommonJS for
Node assertions:

```javascript
sub2BuildAccountEditorKey(accountId, kind) -> string
sub2TransitionAccountEditor(currentEditor, accountId, kind)
  -> { accountId, kind, key } | null
sub2GetGroupMemberships(account, groupsById?) -> membership[]
sub2BuildConfigAudit({ accounts, groupsById }, now?) -> auditSnapshot
sub2BuildCapacityAdvice(context, now?) -> capacitySnapshot
```

The controller owns these state boundaries:

```javascript
Sub2Controller.activeEditor -> null | {
  accountId,
  kind: 'balance' | 'capacity' | 'quota',
  key,
  draft,
  message,
  focusField,
  selectionStart,
  selectionEnd,
}

Sub2Controller.toggleAccountEditor(account, kind, options?) -> boolean
Sub2Controller.renderList(options?) -> void
```

## 3. Contracts

### Exclusive Editor State

- `activeEditor` is the only state authority. DOM visibility is a rendering
  result and must not be queried to decide which editor is open.
- Requesting the active account/kind closes it. Requesting another kind or
  account replaces it. At most one editor is visible across the list.
- An open editor pauses background account refresh. A close or successful save
  releases that pause; a failed save retains the same state and draft.
- An asynchronous save captures the submitted editor object. Its completion may
  close an editor only when that exact instance is still active. Comparing only
  `accountId + kind` is insufficient because the user can close and reopen the
  same editor before the old request returns.
- Filter, sort, and view changes rebuild the list. A still-visible account keeps
  its draft and focus metadata. A hidden or non-renderable account clears the
  state and every unsaved credential value.

### Balance Draft Boundary

- A balance draft includes its positive account ID and an `auto` or `manual`
  mode. Automatic mode contains no secret value; manual mode follows the
  provider and canonical-origin binding in `manual-balance-monitoring.md`.
- Switching, closing, filtering out the account, or losing the capability must
  blank password/token/user-ID DOM values and in-memory draft fields.
- Saved credentials are never copied into the editor DOM. A draft can reuse a
  saved credential only through the existing exact provider/origin check.
- Switching modes clears all typed secrets. Saving automatic mode persists only
  mode plus threshold and overwrites any prior manual secret fields.

### Canonical Membership and Audit Data

- `sub2GetGroupMemberships()` is the only normalizer for `account_groups` and
  `groups`. It accepts inline objects and primitive IDs, indexes names and
  platforms through `groupsById`, and deduplicates stable group keys.
- Audit rendering consumes one `sub2BuildConfigAudit()` snapshot and displays
  its severity counts plus canonical `category`, `title`, `detail`, and
  `evidence` fields. Raw group objects are never map keys or text labels.
- Capacity advice comes only from `sub2BuildCapacityAdvice()`. It is rendered in
  a separate section and is not included in audit finding counts.

## 4. Validation & Error Matrix

| Condition | Required Result |
|---|---|
| Invalid account ID or editor kind | Return no new key; do not create a new editor |
| Active account/kind requested again | Close the editor and discard its draft |
| Different account or kind requested | Discard the old draft and render only the new editor |
| Filter keeps the active account | Rebuild the list and retain draft/focus state |
| Filter removes the active account | Clear the editor and unsaved sensitive values |
| Save fails | Keep the editor, draft, message, and retry path active |
| Save succeeds or value is unchanged | Close the editor, then refresh server evidence |
| Old save succeeds after switch or same-key reopen | Refresh evidence without closing the new editor instance |
| Group exists as object or numeric ID | Resolve one canonical membership |
| Duplicate membership representations | Emit one membership and one audit scope |
| Audit has capacity advice | Keep advice outside findings and severity counts |

## 5. Good / Base / Bad Cases

- Good: a user types a balance key, changes sorting, and the same account remains
  visible with the same bound draft and focus location.
- Base: a capacity editor is open and a filter hides the account; the editor
  closes and normal background refresh can resume.
- Bad: three local DOM toggles independently show balance, capacity, and quota
  editors, or `renderList()` returns early merely because balance is open.
- Bad: audit code loops over raw `account.groups` and renders an object as
  `[object Object]`, or counts capacity recommendations as audit findings.

## 6. Tests Required

Before release, Node assertions and static checks must cover:

- Same-control close, cross-kind switch, and cross-account switch.
- Filter/sort/view rebuild with a visible draft and filter removal with secret
  clearing.
- Balance draft account/mode/provider/origin isolation, automatic secret
  exclusion, and failed-save retention.
- Late capacity/quota save completion after a switch or close-and-reopen of the
  same key; assert the newer editor instance remains active.
- Object-form, primitive-ID, `account_groups`, duplicate, missing-name, and
  indexed membership fixtures.
- Canonical audit categories, titles, details, evidence, severity counts, and
  absence of `[object Object]` output.
- Capacity advice separation and its unified capacity-editor action.
- `node --check sub2-smart-group.user.js`, focused CommonJS assertions, and
  `git diff --check`.

## 7. Wrong vs Correct

### Wrong

```javascript
if (root.querySelector('.sub2-balance-editor:not([hidden])')) return;

for (const group of account.groups) {
  findingsByGroup.set(group, buildFinding(group));
}
```

This blocks filters while editing and treats object identity as group identity.

### Correct

```javascript
const next = sub2TransitionAccountEditor(activeEditor, account.id, kind);
const memberships = sub2GetGroupMemberships(account, groupsById);
const audit = sub2BuildConfigAudit({ accounts, groupsById });
```

One controller state owns editor transitions, and canonical helpers own group
identity and audit output.
