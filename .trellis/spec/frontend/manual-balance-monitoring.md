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
sub2ResolveBalanceQuery(account, storedConfig)
sub2BuildAutomaticBalanceRequestPlan(descriptor, apiKey)
sub2ExtractNewApiQuotaPerUnit(responsePayload)
sub2ExtractNewApiTokenBalance(responsePayload, quotaPerUnit)
sub2BuildBalanceStatusSnapshot(config, state, stats, now, usageContext)
Sub2Controller.handleBalanceQuery(account, userInitiated = false)
```

## 3. Protocol Registry And Destination

- `SUB2_BALANCE_PROTOCOL_BY_HOST` is the runtime source of truth for exact
  allowed hostnames and automatic protocol selection.
- `SUB2_BALANCE_ALLOWED_HOSTS` is derived from the registry keys. Every key must
  have one exact userscript `@connect` entry, with no duplicate or wildcard.
- An empty registry value grants only the exact cross-origin permission needed
  by an existing explicit manual configuration; it never implies an automatic
  protocol.
- Automatic balance URLs must be HTTPS on the standard port. Reject embedded
  credentials, query strings, fragments, unknown hosts, and custom ports.
- The complete normalized account API base URL may retain a path for binding,
  but external balance paths are always appended to its validated origin.
- `GM_xmlhttpRequest` uses `anonymous`, `nocache`, a 15-second timeout, and
  `redirect: 'error'`. A 2xx JSON object is accepted only when `finalUrl` is
  present and literally equals the requested URL.

## 4. Single-Account Export Binding

Automatic mode is limited to positive-ID `apikey` accounts on a registry host
with a known protocol. One trusted click may call only:

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

### Automatic sub2api

```text
GET <exported-origin>/v1/usage
Authorization: Bearer <exported-api-key>
```

Parse `remaining ?? quota.remaining ?? balance`, preserve a valid explicit
unit, and use `is_active ?? isValid ?? true` with normal JavaScript truthiness.

### Automatic New API

The first request carries no credential:

```text
GET <exported-origin>/api/status
```

Require `success === true`, a plain `data` object, and a finite positive
`quota_per_unit`. Only then send the exported model Key:

```text
GET <exported-origin>/api/usage/token/
Authorization: Bearer <exported-api-key>
```

Require `code === true`, a plain `data` object, and finite non-negative
`total_available`, `total_used`, and `total_granted`. Divide all finite quota
values by the status response's `quota_per_unit` and label the result USD. No
fixed divisor is permitted.

When `unlimited_quota === true`, return an explicit unlimited result with no
finite remaining amount. The UI must suppress low-balance and runway decisions
while still allowing today's spend and returned used quota to display.

### Manual Compatibility

Legacy `sub2api` API Key and New API Access Token + positive User ID configs are
normalized to `mode: 'manual'` and keep their existing destination binding.
Manual New API still requests `/api/user/self`, but first obtains the same
public dynamic `quota_per_unit`; it must not use a fixed conversion constant.

An automatic failure never retries, switches protocols, or silently falls back
to manual credentials.

## 6. Configuration And Secret Lifetime

The existing GM key remains scoped by current sub2 origin plus positive account
ID. Stored configs are a tagged union:

```javascript
{ mode: 'auto', lowBalanceThreshold: number | null }
{ mode: 'manual', type, baseUrl, lowBalanceThreshold, ...credentialFields }
```

- A legacy config without `mode` normalizes to `manual` without silent deletion
  or mutation.
- An eligible account with no stored config has an implicit auto config.
- Auto storage contains only mode and threshold. It never contains exported
  Key, base URL, hostname, or protocol copies.
- Explicitly saving manual as auto overwrites the stored value and therefore
  drops the old manual secrets.
- Saved manual secrets never populate DOM input values. Values typed in the
  current editor remain bound to provider plus canonical origin and are
  cleared on mode, provider, or origin changes.
- Export payload, exported account, request-plan authorization header, and Key
  stay local to one query. `finally` clears the copied Key/header/property and
  drops references. This is a reference-lifetime guarantee, not a physical
  JavaScript memory-zeroing claim.
- Controller state, errors, diagnostics, clipboard content, files, tests, and
  logs must never contain a real exported Key or raw credential response.

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
| Non-`apikey` or unknown automatic protocol | Open/manual configuration path only |
| Export has zero, multiple, or malformed accounts | Reject before Key read |
| Name/platform/type/full base URL mismatch | Reject before Key read |
| Missing or newline-containing exported Key | Reject before external request |
| New API status invalid | Do not send Key or issue usage request |
| Missing/different `finalUrl` | Reject as unverifiable or redirected |
| Automatic query fails | Preserve prior success; do not retry or use manual fallback |
| `unlimited_quota === true` | Show unlimited; no low warning or runway |
| Legacy config without `mode` | Normalize and execute as manual |
| Auto config is saved | Persist mode and threshold only |

## 9. Good / Base / Bad Cases

- Good: an eligible `apikey` row receives a trusted click, exports exactly that
  row, validates all metadata before reading the Key, then runs the registered
  fixed protocol without storing raw export data in controller state.
- Base: a valid legacy manual New API config remains manual, reads public
  `quota_per_unit`, then calls `/api/user/self` with its saved Access Token and
  User ID; it never exports the sub2 account Key.
- Bad: a timer, refresh, render path, or failed metadata check reads
  `credentials.api_key`, or an automatic New API failure silently invokes a
  second manual request.

## 10. Tests Required

Before release, fake-secret Node assertions and static checks must cover:

- exact 29-host registry / `@connect` parity, no wildcard, known mappings, and
  manual-only unknown protocol;
- HTTPS, standard-port, full-base-URL normalization, fixed endpoint, anonymous
  mode, timeout, redirect rejection, and literal final-URL comparison;
- single-ID export URL and zero/one/many response cases;
- name, platform, type, and base URL binding while proving `api_key` is not read
  on validation failure;
- legacy manual parsing, implicit/explicit auto, and auto storage dropping all
  secret fields;
- New API status-before-Key request order, invalid-status short circuit, dynamic
  conversion, malformed quotas, and unlimited rendering;
- sub2api parsing, manual New API dynamic conversion, low balance, stale-success
  preservation, today's evidence, and runway suppression;
- static call-path proof that export and external query functions are absent
  from startup, timer, refresh, filter, sort, and render paths;
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
