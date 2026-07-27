# Account Creation Contract

## 1. Scope / Trigger

Use this contract whenever `sub2-smart-group.user.js` previews an upstream
API-key account, resolves its platform/group, builds the create payload,
handles idempotent retries, or renders the created account after readback.

The userscript consumes existing same-origin Admin APIs only. It does not
change backend schemas, containers, databases, or account-group priority
semantics.

## 2. Signatures

The implementation keeps these pure helpers available through CommonJS:

```javascript
sub2NormalizeAccountBaseUrl(value)
  -> { ok, baseUrl, hostname, reason }
sub2EvaluateAccountPreviewCandidates(settledResults)
  -> { ok, candidate, candidates, reason }
sub2CollectCompatibleAccountGroups(groups, platform) -> group[]
sub2ResolveAccountCreateGroupSelection(groups, activeFilter)
  -> { blocked, selectedGroupId, requiresSelection, reason }
sub2BuildUniqueAccountName(baseUrl, platform, accounts) -> string
sub2ComputeAccountCreatePriority(accounts, groupId, groupsById) -> number
sub2BuildCreateAccountPayload(input) -> CreateAccountRequest
sub2BuildAccountCreateAttemptFingerprint(payload) -> string
sub2IsRetryableAccountCreateError(error) -> boolean
```

The API boundaries are:

```http
POST /api/v1/admin/accounts/models/sync-upstream-preview
     body: { platform, type: "apikey", base_url, api_key }
     response data: { models: string[] }

POST /api/v1/admin/accounts
     header: Idempotency-Key: <transient attempt identifier>
     body: {
       name,
       platform,
       type: "apikey",
       credentials: { base_url, api_key, model_mapping },
       concurrency: 1,
       priority,
       rate_multiplier: 1,
       group_ids: [groupId]
     }

GET /api/v1/admin/accounts/:id
GET /api/v1/admin/accounts
GET /api/v1/admin/groups/all
```

## 3. Contracts

### URL and Detection

- Accept HTTPS, plus HTTP only for `localhost`, `127.0.0.1`, and `[::1]`.
- Reject embedded credentials, query strings, fragments, empty hosts, and
  non-HTTP protocols. Preserve a meaningful base path and remove trailing
  slashes.
- One trusted detect click previews exactly the OpenAI and Anthropic API-key
  candidates through the same-origin backend. The browser never calls the
  upstream URL directly.
- A candidate is valid only when the preview succeeds and the shared model
  policy leaves at least one model for that family. Exactly one valid candidate
  may advance; zero or two valid candidates fail closed.

### Group and Payload

- Compatible groups come from positive-ID, active `group.platform` evidence.
  Never infer platform from a group or account display name.
- Prefer a compatible concrete active filter, otherwise auto-select the sole
  compatible group, require a choice among several, and block when none exist.
  Creation never submits an empty `group_ids` array.
- Page through the complete current account collection before generating a
  unique name or computing priority; the dashboard's first account page is not
  a complete decision snapshot.
- Include only filtered identity model mappings. Use concurrency `1`, rate
  multiplier `1`, and an account priority one step less preferred than the
  largest account priority among current compatible members (or `1` when the
  group is empty).
- When group selection is still required, render priority as unresolved rather
  than showing the empty-group fallback `P1` before a group is chosen.
- The review labels this value as account-level priority. The backend assigns
  membership priority during group binding, so readback is the only source of
  truth for the displayed group priority.

### Secret, Idempotency, and Retry Boundary

- The API key exists only in one password input and transient preview/create
  payloads. It never enters GM storage, page storage, rendered messages, logs,
  diagnostics, clipboard output, or attempt fingerprints.
- Bind a typed key to the normalized base URL. Any destination change clears
  the key, preview, and attempt state.
- Generate one idempotency key per unchanged confirmed payload. Reuse it only
  for retryable uncertainty: network failures, HTTP 408/425/429/5xx, and the
  explicitly supported 409 idempotency in-progress/backoff reasons.
- While the create POST is in flight, block cancel, close, minimize, and
  competing-overlay transitions so they cannot discard its retry identity. A
  bounded request timeout is retryable uncertainty and retains that same key;
  only the internal success path may force-close the pending modal.
- Terminal rejection clears the secret and returns to detection. Success,
  cancel, close, or teardown clears every secret/preview/idempotency reference
  and invalidates late response sequences.

### Readback and Layout

- After success, reread accounts, groups, and the created account when its ID
  is available. Show both actual group membership priority and account-level
  priority without claiming a guaranteed group fallback position.
- The account list owns scrolling. Direct group sections must be non-shrinking
  flex items (`flex: 0 0 auto`); otherwise a newly added row can extend beyond
  a compressed group and be clipped by `overflow: hidden` under the next group.

## 4. Validation & Error Matrix

| Condition | Required Result |
|---|---|
| Invalid or unsafe URL | Clear mismatched secret; do not preview |
| Preview request fails for one candidate | Evaluate the other candidate independently |
| Zero valid candidates | Show a non-secret failure; create nothing |
| Two valid candidates | Report ambiguous platform; create nothing |
| No compatible active group | Clear secret and block creation |
| Several compatible groups | Require explicit operator selection |
| Blank or duplicate account name | Keep review open and disable creation |
| Duplicate click while pending | Issue one create request only |
| Retryable uncertain result | Keep review/key and reuse the attempt key |
| Terminal create rejection | Clear key and require a new preview |
| Successful create, failed readback | Report readback uncertainty without resubmitting |
| Group content exceeds list viewport | Scroll the list; never shrink or overlap groups |

## 5. Good / Base / Bad Cases

- Good: one OpenAI preview yields allowed GPT models, one compatible group is
  selected, and one idempotent create is followed by a membership readback.
- Base: several compatible groups exist; detection succeeds but creation stays
  disabled until the operator chooses one.
- Good: changing the base URL after typing clears the password value before any
  request can target the new destination.
- Bad: treat a successful HTTP response with no allowed family models as valid,
  infer a group from its name, or create an ungrouped account.
- Bad: compress group sections to the list viewport and rely on hidden overflow;
  this leaves the created account in the DOM but not visibly actionable.

## 6. Tests Required

Before release, focused assertions and browser evidence must cover:

- HTTPS and loopback HTTP normalization plus credential/query/fragment/protocol
  rejection.
- OpenAI-only, Anthropic-only, zero, dual, mixed-family, and failed preview
  outcomes.
- Compatible-filter, sole-group, multi-group, inactive-group, and no-group
  resolution without an ungrouped payload.
- Unique names, conservative account priority, exact filtered create payload,
  complete account pagination, idempotency reuse/invalidation, timeout retry
  classification, pending-dismissal locking, and duplicate-submit suppression.
- Destination-bound secret clearing and absence from storage, output, logs,
  diagnostics, clipboard paths, fingerprints, and post-operation DOM text.
- Post-create account/membership readback and grouped-list geometry at desktop
  and mobile widths: each group contains its rows, adjacent groups do not
  overlap, and excess content increases list `scrollHeight`.
- Trusted-click reachability, request-sequence guards, `node --check`, focused
  Node assertions, and `git diff --check`.

## 7. Wrong vs Correct

### Wrong

```javascript
const groupId = groups.find((group) => group.name.includes('GPT'))?.id;
await createAccount({ base_url: rawUrl, api_key: key, group_ids: groupId ? [groupId] : [] });
```

This guesses platform from display text, skips backend preview, and can create
an ungrouped or misclassified account.

### Correct

```javascript
const detection = sub2EvaluateAccountPreviewCandidates(settledCandidates);
const groups = sub2CollectCompatibleAccountGroups(groupsById, detection.candidate.platform);
const selection = sub2ResolveAccountCreateGroupSelection(groups, activeGroupFilter);
const payload = sub2BuildCreateAccountPayload({
  name,
  platform: detection.candidate.platform,
  baseUrl: normalizedUrl.baseUrl,
  apiKey,
  groupId: selection.selectedGroupId,
  priority,
  allowedModelIds: detection.candidate.allowedModels,
});
```

Preview establishes one model family, real group metadata supplies mandatory
membership, and the payload builder enforces the conservative defaults.
