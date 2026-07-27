# Userscript Evidence

## Repository Shape

- The product is a single Tampermonkey userscript, `sub2-smart-group.user.js`, plus `README.md`.
- The script uses a factory that exposes pure helpers through CommonJS when loaded in Node. Focused regression assertions can import those exports without a browser test framework (`sub2-smart-group.user.js:6397`).
- There is no `package.json` or permanent test runner. The established release checks are a temporary Node assertion file, `node --check sub2-smart-group.user.js`, and `git diff --check`.
- The current release is `2.5.0`; this feature set is a backward-compatible minor release and should become `2.6.0` in both metadata and runtime fallback (`sub2-smart-group.user.js:5`, `sub2-smart-group.user.js:115`).

## Account Editor Defect

- Interaction detection queries three independent DOM editor classes (`sub2-smart-group.user.js:3936`).
- `renderList()` returns whenever a balance editor is visible, which prevents text, group, platform, health, and sort changes from rebuilding the list (`sub2-smart-group.user.js:4208`).
- The balance opener closes only other balance editors and always reopens itself (`sub2-smart-group.user.js:4591`). Capacity and quota each toggle their own local DOM node and do not close the other editor types (`sub2-smart-group.user.js:4975`, `sub2-smart-group.user.js:5031`).
- Balance drafts already bind typed credentials to provider plus canonical origin. The unified editor state must retain that destination binding while adding account identity and render-survival semantics (`sub2-smart-group.user.js:4566`).

## Audit Defect

- Canonical group membership normalization already handles `account_groups`, object-form `groups`, ID-only `groups`, group indexing, and duplicate suppression (`sub2-smart-group.user.js:2456`).
- Canonical audit generation already returns sorted findings and severity counts (`sub2-smart-group.user.js:1672`).
- The drawer bypasses both helpers and treats each raw `account.groups` value as a map key and label. Object values therefore become identity keys and render as `[object Object]` (`sub2-smart-group.user.js:5379`).
- The drawer should render canonical `title`, `detail`, `category`, `evidence`, and severity fields. Capacity advice can remain a separate canonical section rather than being rebuilt as audit findings.

## Routing Event Defect

- Request normalization already exposes account ID, group ID, model, platform, request ID, and creation time (`sub2-smart-group.user.js:945`).
- Observation snapshots currently persist only account ID, request key, and timestamp for the latest hit (`sub2-smart-group.user.js:1277`).
- Hit-change events compare only account ID and request key, so consecutive requests from unrelated groups or models can produce a false transition (`sub2-smart-group.user.js:1350`).
- A complete scope must be present on both observations before comparison: positive group ID, normalized platform, and normalized requested model. Old persisted snapshots without this scope must fail closed.

## TTFT and Model Surfaces

- The Ops request normalizer currently reads `duration_ms` but not TTFT (`sub2-smart-group.user.js:945`).
- Reliability fetches are cached for one minute and limited to the latest 1000 rows; the UI already distinguishes complete coverage from samples (`sub2-smart-group.user.js:3131`, `sub2-smart-group.user.js:5118`). TTFT should use the same bounded-evidence vocabulary.
- The model drawer first reads saved models and performs upstream work only after an explicit click (`sub2-smart-group.user.js:6055`).
- `sub2SyncAccountModels()` discards the upstream `{ models }` response and then rereads saved models, even though the backend endpoint does not persist mappings (`sub2-smart-group.user.js:3204`).

## UI Integration Points

- Header actions are mounted in one template and currently contain audit, events, diagnostics, and minimize controls (`sub2-smart-group.user.js:3707`). A compact add-account icon/button and a sibling overlay can be added without changing the account list layout.
- Drawer openers already close competing overlays. The account modal should follow the same single-overlay convention and use request-sequence guards for late responses.
- The controller stores all view state in memory and Tampermonkey storage wrappers. API-key creation state must stay memory-only and must never use the storage wrappers.
