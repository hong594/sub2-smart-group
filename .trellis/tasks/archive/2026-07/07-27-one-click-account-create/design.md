# One-Click Account Creation Design

## Surface and State Machine

Add a compact `+` header action with `title`/`aria-label` set to `添加账号`, plus one sibling modal overlay. The modal has two functional states:

1. **Input:** upstream base URL and password-style API key, with a trusted `识别` command.
2. **Review:** detected platform, editable generated name, mandatory group selection, account-level priority, concurrency, and allowed model count, with a trusted `创建` command.

The controller stores a request sequence, pending flag, transient idempotency key, and preview result. Opening another full-panel overlay closes this modal and vice versa. Pending commands are disabled to prevent double submission.

## URL and Key Validation

A pure URL helper:

- trims input and parses it with `URL`;
- accepts HTTPS, plus HTTP only for loopback hosts (`localhost`, `127.0.0.1`, or `[::1]`);
- rejects embedded username/password, query, fragment, non-HTTP protocols, and empty host;
- preserves a meaningful base path such as `/v1`; and
- removes redundant trailing slashes for a stable base URL.

The API-key draft is bound in memory to the normalized base URL at input time. Changing to a different valid destination clears the typed key and all preview state. The key is never copied into text output or persistent storage.

## Platform Detection

On one trusted click, run both candidate previews through the same-origin endpoint with the same transient input:

- `{ platform: 'openai', type: 'apikey', base_url, api_key }`
- `{ platform: 'anthropic', type: 'apikey', base_url, api_key }`

Use `Promise.allSettled` so one expected protocol failure does not mask the other. A candidate is valid only when the request succeeds and the shared model-family policy finds at least one allowed model. Exactly one valid candidate advances to review. Zero or two valid candidates display a non-secret error and create nothing.

Preview results are normalized, deduplicated, filtered, and converted into sorted identity mappings. Foreign-family models are counted but never included in the create payload.

## Group Resolution

Build compatible choices from the latest group index using exact normalized `group.platform`; exclude explicitly inactive groups and require a positive ID.

Resolution order:

1. If the active filter is a concrete `id:<n>` group and it is compatible, preselect it.
2. Otherwise, if exactly one compatible group exists, select it automatically.
3. Otherwise, require the operator to choose one compatible group in review.
4. If none exists, block review/creation.

There is no ungrouped option and no group-name inference.

## Name and Conservative Defaults

Generate `host | GPT` or `host | Claude`, then append ` (2)`, ` (3)`, and so on to avoid current account-name collisions. The review state allows editing but requires a non-empty final name.

The visible defaults are:

- `concurrency: 1` to bound immediate load;
- `priority`: one step less preferred than the largest account-level priority among current compatible group members, or `1` for an empty group;
- `rate_multiplier: 1`;
- `platform`: detected value;
- `type: 'apikey'`;
- `group_ids: [selectedGroupId]`; and
- credentials containing only normalized `base_url`, transient `api_key`, and filtered identity `model_mapping`.

The review labels this as account-level priority. The official create endpoint accepts only `group_ids`; binding one selected group assigns membership priority `1`, and the installed Admin API exposes no membership-priority mutation. Therefore this flow does not claim a guaranteed group-level fallback position. After creation it rereads the account and shows the actual group membership priority so the operator sees the effective result.

## Create Boundary and Cleanup

Generate one UUID-like idempotency key for a confirmed create attempt and pass it as `Idempotency-Key`. Reuse it only when retrying that exact unchanged review payload. Any URL/platform/group/name change invalidates the key.

On success, cancel, modal close, or terminal reset:

- blank the password element;
- drop all key/destination/idempotency references;
- invalidate pending response sequences; and
- clear preview model data.

After success, close the modal and refresh accounts/groups. The official backend may asynchronously probe OpenAI Responses capability after creation; this is not a userscript probe call.

## Verification

Test URL normalization/rejection, destination-bound key clearing, one/two/zero candidate outcomes, mixed model lists, group preselection/auto-selection/required selection/no-group failure, inactive groups, duplicate names, conservative account priority, post-create membership display, deterministic create payloads, idempotency reuse/invalidation, double-click suppression, and cleanup.
