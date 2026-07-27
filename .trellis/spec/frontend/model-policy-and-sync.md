# Model Policy and Synchronization Contract

## 1. Scope / Trigger

Use this contract whenever `sub2-smart-group.user.js` classifies upstream
model IDs, resolves an account's group platform, reconciles
`credentials.model_mapping`, or persists model mappings after a trusted user
action. The same family policy must be reused by account creation so preview
and later synchronization cannot disagree.

The userscript consumes existing Admin APIs only. It does not modify backend
model discovery, account schemas, containers, or databases.

## 2. Signatures

The implementation keeps these pure helpers available through CommonJS:

```javascript
sub2NormalizeFetchedModelIds(models) -> string[]
sub2ClassifyModelForPlatform(modelId, platform)
  -> { allowed, family, reason }
sub2FilterModelsForPlatform(models, platform)
  -> { platform, fetched, allowed, excluded, counts }
sub2ResolveModelSyncPlatform(account, groupsById?)
  -> { ok, platform, accountPlatform, platforms, memberships, reason, message }
sub2ReconcileModelMapping(currentMapping, allowedModelIds)
  -> { blocked, modelMapping, added, removed, preserved, conflicts, counts }
sub2BuildModelSyncPlan(currentMapping, fetchedModels, platform) -> syncPlan
sub2BuildModelMappingBulkUpdatePayload(accountId, modelMapping) -> object
```

The API boundaries are:

```http
GET  /api/v1/admin/accounts/:id
POST /api/v1/admin/accounts/:id/models/sync-upstream
     response data: { "models": ["model-id"] }
POST /api/v1/admin/accounts/bulk-update
     body: {
       "account_ids": [123],
       "credentials": {
         "model_mapping": { "model-id": "model-id" }
       }
     }
GET  /api/v1/admin/accounts/:id/models
```

## 3. Contracts

### Strict Platform Evidence

- Resolve canonical membership through `sub2GetGroupMemberships()`.
- Strict evidence comes only from indexed groups or an inline group object's
  real `platform`. Never infer from account/group names or substitute
  `account.platform` for missing group data.
- Every canonical membership must resolve to one platform. The distinct set
  must contain exactly one supported value: `openai` or `anthropic`.
- The resolved group platform must equal normalized `account.platform`.
- Missing, conflicting, unsupported, or mismatched evidence stops before the
  upstream fetch and before any write.

### Shared Family Policy

- Classify the final slash-delimited segment while preserving the complete
  original model ID in mappings.
- Anthropic permits `claude-*` only.
- OpenAI permits `gpt-*`, `chatgpt-*`, `codex-*`, and exact or hyphenated
  `o1`, `o3`, and `o4`.
- OpenAI image, audio, realtime, transcription, speech/TTS, and embedding
  endpoint variants are excluded even when their prefix is otherwise valid.
- Normalize, trim, deduplicate, and sort fetched IDs before filtering.

### Mapping Ownership

- A system-owned entry has string source and target values whose trimmed text
  is equal. All other values are manual and must be preserved unchanged.
- Remove system-owned entries absent from the current allowed set, including
  stale and wrong-family identities.
- Add allowed identities in deterministic order only when a manual entry does
  not already own the same source key. Manual source-key conflicts win.
- An empty allowed result is blocked and never erases existing configuration.
- Any identity removal requires a visible count and explicit confirmation.

### Persistence Boundary

- `sync-upstream` fetches only. Do not treat it as a persistence endpoint.
- Read the latest account detail before fetching to obtain visible mapping and
  membership evidence. Sensitive credentials are redacted and must never be
  reconstructed.
- Persist the complete reconciled mapping through one-account `bulk-update`
  with only `credentials.model_mapping`. Its top-level JSONB merge preserves
  every unrelated credential key.
- Do not use the single-account full-credentials `PUT` path for mapping
  persistence; omitted non-sensitive credential keys are deletion-significant.
- Reread the account and saved models after a write and verify the mapping.
- Fetch and write boundaries require an explicit click plus request-sequence
  guards. Timers, visibility handlers, and background refreshes cannot reach
  them.

## 4. Validation & Error Matrix

| Condition | Required Result |
|---|---|
| No canonical membership | Stop before upstream fetch |
| Any membership lacks real group platform | Stop before upstream fetch |
| Inline and indexed platform disagree | Treat as conflict and stop |
| Multiple group platforms | Stop as ambiguous |
| Unsupported group platform | Stop; do not guess a family |
| Account and group platform disagree | Stop before upstream fetch |
| Upstream response lacks `models` array | Fail without mapping write |
| No allowed family model remains | Keep current mapping unchanged |
| Manual entry conflicts with fetched source | Preserve manual entry |
| Identity entries will be removed | Require explicit confirmation |
| Operator rejects confirmation | Keep current mapping unchanged |
| Reconciled mapping is unchanged | Reread evidence without writing |
| Bulk update succeeds but reread differs | Report verification failure |

## 5. Good / Base / Bad Cases

- Good: an OpenAI account in OpenAI groups fetches mixed upstream IDs; only
  GPT/chat/reasoning/Codex text IDs become identity mappings, while manual
  aliases remain unchanged.
- Base: the allowed identity mapping already matches the fetched list; report
  counts and reread without issuing `bulk-update`.
- Good: a stale Claude identity exists on an OpenAI account; show its removal,
  require confirmation, then update only `model_mapping`.
- Bad: use `account.platform` because a group has no platform, or infer Claude
  from a group name.
- Bad: send the redacted account credential object through `PUT`, which can
  delete omitted non-sensitive fields.

## 6. Tests Required

Before release, focused assertions and static checks must cover:

- Case normalization, slash-prefixed IDs, all allowed families, excluded
  near-matches, and endpoint-specific OpenAI variants.
- Missing, duplicate, inline, indexed, conflicting, unsupported, and
  account-mismatched membership evidence.
- Duplicate/blank fetched IDs, add-only, removal, no-op, empty-family, stale
  identity, wrong-family identity, manual conflicts, and non-string values.
- Exact one-account bulk payload shape with no credential key except
  `model_mapping`.
- Trusted-click reachability, request-sequence guards, confirmation on removal,
  and absence of timer/background write paths.
- Existing membership, audit, routing eligibility, saved-model, and request
  normalization regressions.
- `node --check sub2-smart-group.user.js` and `git diff --check`.

## 7. Wrong vs Correct

### Wrong

```javascript
await syncUpstream(account.id);
await updateAccount(account.id, {
  credentials: { ...account.credentials, model_mapping: fetchedModels },
});
```

This assumes fetch implies filtering, trusts a redacted credential snapshot,
and uses a deletion-significant full update.

### Correct

```javascript
const platform = sub2ResolveModelSyncPlatform(latestAccount, groupsById);
const plan = sub2BuildModelSyncPlan(currentMapping, fetchedModels, platform.platform);
const payload = sub2BuildModelMappingBulkUpdatePayload(account.id, plan.modelMapping);
await sub2ApiRequest('POST', '/admin/accounts/bulk-update', payload);
```

Strict evidence selects the shared family policy, reconciliation preserves
manual ownership, and the bulk merge changes only the complete mapping value.
