# Group-Aware Model Synchronization Design

## Platform Resolution

Resolve canonical membership IDs with `sub2GetGroupMemberships(account, groupsById)`, then obtain each platform strictly from the indexed group or an inline group object. Do not trust the helper's account-platform fallback when real group platform data is absent. Normalize the strict values and require the distinct set to contain exactly one supported value:

- `openai` -> GPT/OpenAI text family
- `anthropic` -> Claude family

No membership, missing platform, unsupported platform, conflicting platforms, or disagreement with the normalized account platform stops before the upstream request or write. Account/group names are never classification inputs.

## Shared Model-Family Policy

Classify the final slash-delimited model segment while preserving the original full ID for mapping:

- Claude: `claude-*`.
- OpenAI text: `gpt-*`, `chatgpt-*`, exact or hyphenated `o1`, `o3`, `o4`, and `codex-*`.
- OpenAI exclusions: identifiers containing endpoint-specific image, audio, realtime, transcription, speech/TTS, or embedding markers.

The helper returns a policy result (`allowed`, `family`, `reason`) rather than a bare regular-expression match. One-click account creation reuses this exact policy so detection and later synchronization cannot drift.

## Reconciliation

Normalize the fetched list into unique, non-empty original model IDs, then filter by the resolved policy.

Treat a stored entry as system-owned only when both key and value are strings and their trimmed values are exactly equal. Reconciliation:

1. Copy every non-identity or non-string entry unchanged as manual configuration.
2. Remove identity entries not present in the current allowed fetched set, including stale and wrong-family entries.
3. Add each allowed fetched ID as an identity entry only when that source key is not already occupied by a preserved manual entry.
4. Sort newly generated identity keys for deterministic payloads while preserving manual values.

If no allowed model is returned, do not build or send an update. A failed/incomplete fetch never removes configuration.

## Persistence Boundary

The sync flow is:

1. Read the latest account detail for current visible `model_mapping` and membership evidence.
2. Call `POST /admin/accounts/:id/models/sync-upstream` from the trusted drawer button and consume its `{ models }` response.
3. Build a reconciliation preview with fetched, allowed, excluded, added, removed, preserved, and conflict counts.
4. If identity entries will be removed, show the exact counts and require confirmation. Add-only/no-op flows do not add a destructive prompt.
5. For changes, call `POST /admin/accounts/bulk-update` with one `account_ids` element and only `credentials.model_mapping`.
6. Reread saved models/account evidence and render the result.

Using bulk top-level merge avoids sending redacted credentials and leaves `api_key`, `base_url`, headers, pool mode, capability flags, compact settings, and every other credential key untouched.

## UI and Errors

The existing drawer remains the surface. During sync, disable the button and guard late responses with `modelRequestSequence`. Status text reports the reconciliation counts. Unsupported/conflicting membership and empty-family results are explicit no-write errors.

## Verification

Test family case normalization, slash-prefixed IDs, near-matches, endpoint-specific exclusions, duplicate models, manual conflicts, unknown values, stale identities, add-only, removal, no-op, empty allowed results, missing/conflicting/account-mismatched group platforms, and exact bulk payload shape.
