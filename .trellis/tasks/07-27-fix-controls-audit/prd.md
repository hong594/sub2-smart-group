# Fix Account Controls and Audit

## Goal

Restore predictable account-card editing and make configuration audit findings readable and canonical.

## Requirements

- Use one exclusive active-editor state for balance, capacity, and quota editors across all accounts.
- The active control toggles closed; another control switches the editor rather than adding a second one.
- Filters and sorting remain effective while an editor is open without weakening the v2.5 credential-context rules. A still-visible active editor preserves its draft; filtering its account out closes it and clears any unsaved sensitive draft.
- Render canonical findings from `sub2BuildConfigAudit()` and group data from `sub2GetGroupMemberships()` instead of rebuilding group maps from raw `account.groups` objects.
- Present canonical human-readable audit categories, titles, details, evidence, severities, and counts; keep capacity advice in a separate canonical section.
- Preserve current list scroll, focus, polling pause, and save-failure draft behavior where applicable.

## Acceptance Criteria

- [x] Same-control close, cross-control switch, and cross-account switch each leave zero or one visible editor as intended.
- [x] Group/platform/health/text/sort changes update the visible list with an editor open.
- [x] Balance provider/origin/account draft isolation remains covered by regression assertions.
- [x] Audit findings use readable canonical group names and contain no object-string labels or duplicate object-identity groups.
- [x] Existing audit severity/count behavior is derived from the canonical builder.
- [x] Capacity advice remains available without being counted twice as audit findings.

## Out of Scope

- New audit categories unrelated to the reported duplicate/object rendering defect.
- Layout redesign or backend changes.

## Parent Requirements

Implements parent requirements R1-R3.
