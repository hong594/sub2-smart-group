# Manual Balance Monitoring Contract

## 1. Scope / Trigger

Use this contract whenever `sub2-smart-group.user.js` changes upstream balance configuration, credential handling, cross-origin balance requests, response parsing, or today's-usage evidence.

The balance feature is a userscript-only monitoring path. It must not change sub2 account validity, routing, health, scheduling, backend APIs, or containers.

## 2. Signatures

The implementation keeps these pure or boundary functions available for review and Node assertions:

```javascript
sub2BuildBalanceCredentialContext(providerType, baseUrl) -> string
sub2BuildBalanceConfigStorageKey(accountId, sub2Origin?) -> string
sub2BuildBalanceRequest(rawConfig) -> { request, config, error }
sub2ExtractBalanceResult(providerType, responsePayload) -> balanceResult
sub2IsTodayUsageAvailable({ available, fetchedAt }, now) -> boolean
Sub2Panel.handleBalanceQuery(account, userInitiated = false) -> Promise<void>
```

The only supported upstream HTTP signatures are:

```text
sub2api: GET <approved-origin>/v1/usage
         Authorization: Bearer <apiKey>

newapi:  GET <approved-origin>/api/user/self
         Authorization: Bearer <accessToken>
         New-Api-User: <positive-integer-user-id>
```

## 3. Contracts

### Destination and Request

- The configured address is an HTTPS root URL on `SUB2_BALANCE_ALLOWED_HOSTS`.
- Reject credentials in the URL, non-root paths, query strings, fragments, and custom ports.
- Every allowed hostname must have an exact userscript `@connect` entry; wildcard connectivity is forbidden.
- `GM_xmlhttpRequest` is called only through the balance-query boundary, with anonymous and no-cache modes, a 15-second timeout, and redirects rejected.
- `response.finalUrl` must be present and literally equal to the requested endpoint. Do not canonicalize a different returned string into equality.
- Query execution requires both a trusted click handler and `userInitiated === true`. Startup, timers, visibility events, polling, and refreshes cannot query an upstream balance.

### Credential Storage and Drafts

- The GM storage key is scoped by the current sub2 origin and positive account ID.
- Saved secrets never enter DOM input values, `localStorage`, logs, diagnostics, exports, or clipboard content.
- A typed secret is bound to the provider plus canonical upstream origin at input time.
- Changing provider always clears typed credential fields, including when the URL is currently invalid.
- Changing origin clears typed credentials whose recorded context no longer matches.
- A saved credential may be reused only when its provider and canonical origin exactly match the final editor context.

### Response and Evidence

- `sub2api` validity uses `is_active ?? isValid ?? true`, followed by normal JavaScript truthiness. Do not impose a boolean-only schema.
- `newapi` requires a successful object payload and converts `quota` and `used_quota` by dividing by `500000`.
- Monetary and usage inputs must be finite numbers; null, booleans, arrays, empty strings, `NaN`, and infinities are invalid.
- Today's evidence requires an explicit successful fetch timestamp from the same local day and no more than 30 seconds old.
- USD runway additionally requires positive cost and at least one elapsed hour. Calculate elapsed time from the evidence fetch timestamp, not render time.
- Evidence expiry updates existing summary nodes before interaction guards prevent polling or list reconstruction. Open editors, focus, drafts, and scroll position must survive expiry.

## 4. Validation & Error Matrix

| Condition | Required Result |
|---|---|
| Unsupported provider | Reject configuration before storage or request |
| Non-HTTPS or non-root URL | Reject configuration |
| Host absent from `SUB2_BALANCE_ALLOWED_HOSTS` | Reject configuration |
| Missing or different `finalUrl` | Reject response as unverifiable or redirected |
| Missing provider credential | Reject save; do not query |
| Provider changes after typing | Clear every typed credential field |
| Origin changes after typing | Clear mismatched typed credentials |
| Persisted context differs | Do not reuse the persisted secret |
| `sub2api` validity is `0` | Treat account as inactive |
| `sub2api` validity is `1` | Accept if the balance is otherwise valid |
| Malformed monetary or usage value | Reject or suppress derived evidence |
| Missing, stale, future, or cross-day fetch timestamp | Hide today's evidence and runway |
| Request startup throws synchronously | Show a fixed failure message without reflecting implementation details |

## 5. Good / Base / Bad Cases

- Good: a trusted click queries an allowlisted HTTPS origin with an exact-match saved credential, receives finite USD data, and uses fresh same-day evidence for runway.
- Base: balance is valid but today's evidence is unavailable or stale; show the balance and suppress today's summaries and runway.
- Bad: a user types a token, changes provider or origin, and clicks save-and-query; the old token must be cleared or discarded and must never reach the new destination.
- Bad: a response redirects to a URL that canonicalizes to the same endpoint; reject it unless the returned string is literally the expected URL.

## 6. Tests Required

Before release, Node assertions and static checks must cover:

- URL allowlist, root-only rules, storage-key origin/account isolation, and exact `@connect` parity.
- Fixed endpoints, fixed headers, anonymous mode, timeout, redirect rejection, and literal final-URL comparison.
- Draft binding for API Key, Access Token, and User ID across provider/origin changes, including invalid URL contexts and exact persisted fallback.
- `is_active ?? isValid ?? true`, strict numeric parsing, and newapi `/500000` conversion.
- Fresh, stale, future, missing, cross-day, short-window, zero-rate, non-finite, and non-USD evidence.
- In-place expiry while an editor is open and the absence of automatic query call paths.
- Existing exported-function regressions, `node --check sub2-smart-group.user.js`, `git diff --check`, secret-pattern scans, and temporary-file cleanup.

An authenticated live upstream query is optional evidence and must never be obtained by synthesizing or requesting credentials solely for a test.

## 7. Wrong vs Correct

### Wrong

```javascript
providerSelect.addEventListener('change', () => {
  clearMismatchedCredentialDrafts();
});
```

When the URL is invalid, both old and new contexts can be empty, leaving a hidden typed credential behind.

### Correct

```javascript
providerSelect.addEventListener('change', () => {
  clearMismatchedCredentialDrafts(true);
  updateProviderFields();
});
```

Provider changes invalidate all typed credentials independently of URL validity. Save-time context checks remain the second enforcement layer.
