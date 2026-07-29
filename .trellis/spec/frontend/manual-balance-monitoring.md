# Balance Monitoring Contract

## 1. Scope / Trigger

Use this contract whenever `sub2-smart-group.user.js` changes upstream balance
configuration, single-account credential export, cross-origin requests,
response parsing, or today's-usage evidence.

The balance feature is a userscript-only monitoring path. It must not change
sub2 account validity, routing, health, scheduling, backend APIs, containers, or
database state.

Every same-origin export and external balance request must descend from the
same trusted balance-button click. Startup, timers, visibility events, polling,
filtering, sorting, refresh, and list rendering must not export credentials or
query an upstream.

## 2. Signatures / Reviewable Boundaries

Keep these pure or boundary functions available through CommonJS for focused
Node assertions:

```javascript
sub2NormalizeAutomaticBalanceBaseUrl(rawBaseUrl)
sub2BuildAutomaticBalanceDescriptor(account)
sub2ValidateExportedBalanceAccount(account, exportPayload)
sub2ParseBalanceConfig(rawConfig)
sub2BuildBalanceConfigSummary(rawConfig)
sub2NormalizeBalanceConfigSummary(rawSummary)
sub2BuildBalanceSetupState(account, storedConfigOrSummary)
sub2BuildBalanceSetupSaveConfig(account, storedConfig, draft)
sub2BuildAllApiHubBalanceImportPlan(rawBackup, accounts, existingConfigById)
sub2ResolveBalanceQuery(account, storedConfig)
sub2BuildAutomaticBalanceRequestPlan(descriptor, apiKey)
sub2ExtractNewApiQuotaPerUnit(responsePayload)
sub2BuildBalanceStatusSnapshot(config, state, stats, now, usageContext)
Sub2Controller.handleBalanceQuery(account, userInitiated = false)
```

## 3. Protocol Registry And Destination

- `SUB2_BALANCE_PROTOCOL_BY_HOST` is the runtime source of truth for exact
  allowed hostnames and account-derived protocol selection.
- `SUB2_BALANCE_ALLOWED_HOSTS` is derived from the registry keys. Every key must
  have one exact userscript `@connect` entry, with no duplicate or wildcard.
- An empty registry value grants cross-origin permission only; it never implies
  a balance method and cannot construct a query from an old configuration.
- Balance account URLs must be HTTPS on the standard port. Reject embedded
  credentials, query strings, fragments, unknown hosts, and custom ports.
- The complete normalized account API base URL may retain a path for binding,
  but external balance paths are always appended to its validated origin.
- `GM_xmlhttpRequest` uses `anonymous`, `nocache`, a 15-second timeout, and
  `redirect: 'error'`. A 2xx JSON object is accepted only when `finalUrl` is
  present and literally equals the requested URL.

## 4. Method Resolver And Single-Account Export Binding

`sub2BuildBalanceSetupState()` is the only UI/query/import authority for the
current account. It validates a positive-ID `apikey` account, normalizes its
upstream address, and reads the exact registry hostname before considering any
stored setting. It returns one of:

- `sub2api-key`: no credential fields; the query uses a trusted single-account
  export after the click.
- `newapi-account`: requires an origin-bound Access Token and positive User ID.
- `unsupported`: invalid, unregistered, empty-protocol, or otherwise unsafe;
  show a fixed reason and no credential form.

The internal `auto` / `manual` tags remain storage compatibility details. They
are not user-selectable methods and cannot override the resolver.

Only `sub2api-key` uses single-account export. One trusted click may call:

```text
GET /api/v1/admin/accounts/data?ids=<current-id>&include_proxies=false
```

The sub2 `DataAccount` export format does not contain an account ID. Do not
claim that the response ID was checked. The binding is the conjunction of:

1. one positive current-row ID in the request URL;
2. `include_proxies=false`;
3. exactly one exported account;
4. exact trimmed account name equality;
5. case-normalized platform and type equality; and
6. complete normalized `credentials.base_url` equality.

All metadata checks happen before reading `credentials.api_key`. A missing,
multi-account, malformed, or mismatched response is rejected without reading or
sending the Key.

## 5. Query Contracts

### Direct sub2api

```text
GET <exported-origin>/v1/usage
Authorization: Bearer <exported-api-key>
```

Parse `remaining ?? quota.remaining ?? balance`, preserve a valid explicit
unit, and use `is_active ?? isValid ?? true` with normal JavaScript truthiness.

### New API account balance

The first request carries no credential and uses the account-derived origin:

```text
GET <resolved-origin>/api/status
```

Require `success === true`, a plain `data` object, and a finite positive
`quota_per_unit`. Only then send the complete stored account-balance fields:

```text
GET <resolved-origin>/api/user/self
Authorization: Bearer <access-token>
New-Api-User: <positive-user-id>
```

Require `success === true`, a plain `data` object, and finite `quota` plus
finite `used_quota`. Divide both values by the status response's
`quota_per_unit` and label the result USD. A negative `quota` remains valid
overdraft evidence; no fixed divisor is permitted.

The model-Key quota endpoint is not an account balance and has no request,
fallback, or extractor consumer. Missing account credentials or any query
failure must not export a model Key or switch protocols.

### Stored-data compatibility

Legacy New API Access Token + positive User ID configs remain valid only when
their normalized origin equals the resolver origin. Legacy sub2api API Keys are
parsed and preserved for rollback, but are never request consumers. Query
failure never retries, switches protocols, or falls back to another credential.

## 6. Configuration And Secret Lifetime

The existing GM key remains scoped by current sub2 origin plus positive account
ID. Stored configs are a tagged union:

```javascript
{ mode: 'auto', lowBalanceThreshold: number | null }
{ mode: 'manual', type, baseUrl, lowBalanceThreshold, ...credentialFields }
```

- A legacy config without `mode` normalizes to `manual` without silent deletion
  or mutation.
- A resolved sub2api account needs no stored config. With no prior value, saving
  a threshold writes only internal `mode: 'auto'` plus the threshold.
- A resolved New API account is complete only when an existing manual-compatible
  config has provider `newapi`, the exact resolved origin, a valid Access Token,
  and a positive User ID. Otherwise it is `missing` or `conflict`.
- Method, provider, and origin are derived and never editable. Saved credentials
  never populate DOM input values; only missing New API fields enter the draft.
- Threshold-only save locally reloads the full config and replaces only the
  threshold. It preserves complete New API credentials and any legacy manual
  sub2api credential object. It must not rebuild storage from visible fields.
- Legacy manual sub2api credentials are not migrated or deleted automatically;
  only explicit clear removes them.
- Export payload, exported account, request-plan authorization header, and Key
  stay local to one query. `finally` clears the copied Key/header/property and
  drops references. This is a reference-lifetime guarantee, not a physical
  JavaScript memory-zeroing claim.
- Controller state, errors, diagnostics, clipboard content, files, tests, and
  logs must never contain a real exported Key or raw credential response.
- `balanceConfigsById` stores only a display summary for stored credentials:
  provider, normalized origin, threshold, and `hasStoredCredentials=true`.
  The full configuration is reloaded from GM storage only inside a trusted
  save or query boundary and is cleared after use.

### Local All API Hub Import

The “导入余额” control is a local configuration-fill path, not a query mode
and not an upstream API. A trusted file selection reads a JSON backup in
memory only when no account editor/query/save is active, then
`sub2BuildAllApiHubBalanceImportPlan()` applies these rules:

1. Require the root `accounts.accounts[]` schema and validate each candidate's
   enabled flag, HTTPS URL, site type, name, and New API `account_info`.
   Unknown fields are not coerced: names, URLs, types, and tokens must be
   strings, while User ID must be a safe positive integer or decimal string.
   A valid backup row on an unrelated hostname is simply unused; registry and
   protocol authority are enforced on the current sub2 account before matching.
2. Match current positive-ID `apikey` accounts by normalized hostname. A single
   candidate is accepted; multiple candidates require exactly one trimmed exact
   account/site name match. No array order, username, balance, or fuzzy match is
   allowed.
3. A New API match is classified against the current summary. Exact complete
   credentials are `complete` and never overwritten; no setting is `missing`;
   an auto tag or provider/origin mismatch is `conflict`. Only `missing` and
   `conflict` create writes with origin, Access Token, positive User ID, and the
   existing low-balance threshold.
4. A sub2api match creates no config and never reads the backup Access Token;
   the account keeps the existing sub2 Key query path.
5. The summary contains only `missing`, `conflict`, `complete`,
   `directSub2api`, `ambiguous`, `unmatched`, and `skipped` counts.
   Confirmation is required before any GM write, and the result reports counts
   without account names, IDs, tokens, raw JSON, or response text. Import does
   not call a network endpoint.

The raw file, parsed backup, credential-bearing write plan, and file input are
released in `finally`; only the sanitized summary and display configuration may
remain in controller state.

## 7. Evidence And Failure State

- Monetary and usage inputs accept only finite numbers or non-empty numeric
  strings. Reject null, booleans, arrays, empty strings, NaN, infinities, and
  negative finite quota values where the protocol requires non-negative data.
- Successful output identifies the protocol, finite balance or unlimited
  state, currency, and query time.
- A new loading or error state retains the prior normalized successful result
  as stale evidence. It never retains a raw response or secret.
- Today's evidence requires an explicit successful fetch timestamp from the
  same local day and no more than 30 seconds old.
- Finite USD runway additionally requires positive cost and at least one
  elapsed hour. Calculate elapsed time from evidence fetch time, not render
  time.
- Evidence expiry updates existing summary nodes before interaction guards
  block polling or list reconstruction. Editors, focus, drafts, and scroll
  position must survive expiry.

## 8. Validation Matrix

| Condition | Required result |
|---|---|
| Untrusted or non-click call | No export and no external request |
| Non-`apikey`, invalid URL, unregistered host, or empty protocol | Unsupported; no credential form or query |
| Export has zero, multiple, or malformed accounts | Reject before Key read |
| Name/platform/type/full base URL mismatch | Reject before Key read |
| Missing or newline-containing exported Key | Reject before external request |
| New API status invalid | Do not send Access Token/User ID or issue account request |
| Missing/different `finalUrl` | Reject as unverifiable or redirected |
| Any query fails | Preserve prior success; do not retry, switch protocol, or use another credential |
| Legacy config without `mode` | Normalize, then let the account-derived method decide whether it participates |
| Threshold-only save with hidden credentials | Preserve the full existing config and replace only threshold |
| Import preview is cancelled | Perform zero GM writes |
| Import host has duplicate candidates | Require one exact name match or skip |
| Import candidate is sub2api | Do not import backup Access Token |
| Import match already has exact complete New API config | Count complete; do not overwrite |
| Import summary or result is rendered | Render counts only, never raw backup data |

## 9. Good / Base / Bad Cases

- Good: a resolved sub2api row receives a trusted click, exports exactly that
  row, validates all metadata before reading the Key, then calls `/v1/usage`
  without storing raw export data in controller state.
- Base: a resolved New API row with exact complete credentials reads public
  `quota_per_unit`, then calls `/api/user/self` with its saved Access Token and
  User ID; it never exports the sub2 account model Key.
- Bad: a timer, refresh, render path, or failed metadata check reads
  `credentials.api_key`, or a missing/failed New API account query exports a
  model Key or invokes another balance endpoint.

## 10. Tests Required

Before release, fake-secret Node assertions and static checks must cover:

- exact 29-host registry / `@connect` parity, no wildcard, known mappings, and
  unsupported unknown/empty protocol;
- HTTPS, standard-port, full-base-URL normalization, fixed endpoint, anonymous
  mode, timeout, redirect rejection, and literal final-URL comparison;
- single-ID export URL and zero/one/many response cases;
- name, platform, type, and base URL binding while proving `api_key` is not read
  on validation failure;
- method resolution for sub2api direct, New API complete/missing/conflict,
  unknown/empty protocol, non-`apikey`, and invalid URL;
- New API status-before-account-request order, invalid-status short circuit,
  dynamic conversion, malformed quotas, and absence of model-Key fallback;
- sub2api parsing, New API account conversion, low balance, stale-success
  preservation, today's evidence, and runway behavior;
- threshold merge preserving complete New API and legacy sub2api credentials,
  plus secret-free storage for a new sub2api threshold;
- static call-path proof that export and external query functions are absent
  from startup, timer, refresh, filter, sort, and render paths;
- local import schema, hostname matching, exact-name disambiguation, threshold
  preservation, missing/conflict/complete/direct classification, sub2api
  non-import, cancellation, and secret-free summary/controller state;
- authenticated browser evidence from the same tab that performed the import;
  GM storage is shared across tabs, but each page keeps its own
  `balanceConfigsById` summary cache, so another open tab must reload before
  its buttons or counts are treated as post-import evidence;
- `node --check sub2-smart-group.user.js`, focused CommonJS assertions,
  `git diff --check`, secret-pattern review, and temporary-test cleanup.

Authenticated live upstream calls are optional evidence and must never be made
with synthesized, copied, or user-exposed credentials solely for a test.

## 11. Wrong vs Correct

### Wrong

```javascript
const exportedAccount = exportPayload.accounts[0];
const apiKey = exportedAccount.credentials.api_key;
this.balanceStateById.set(accountId, { exportPayload });
return sub2QueryAutomaticUpstreamBalance(descriptor, apiKey);
```

This reads the Key before account binding and retains the raw export in
controller state.

### Correct

```javascript
const validated = sub2ValidateExportedBalanceAccount(account, exportPayload);
if (validated.error) throw new Error(validated.error);

let apiKey = '';
try {
  apiKey = validated.exportedAccount.credentials.api_key;
  return await sub2QueryAutomaticUpstreamBalance(validated.descriptor, apiKey);
} finally {
  validated.exportedAccount.credentials.api_key = '';
  apiKey = '';
  exportPayload = null;
}
```

Binding precedes Key access, only the normalized result may enter controller
state, and transient references are discarded in `finally`.
