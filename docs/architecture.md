# Architecture

## Why a gateway and not an OpenCode plugin

OpenCode already supports several providers and lets you switch models, but a
switch is manual and a session is bound to one model. The failure we care about
is mid-session: the model starts answering, then the provider returns 429 and
every subsequent step fails. A plugin could catch that, but it would need to
rewrite provider initialization per release. A local OpenAI-compatible endpoint
is stable, testable with plain HTTP, and works for any client that speaks the
format.

## Request lifecycle

```
client
  |
  | POST /v1/chat/completions  { model: "auto", stream: true }
  v
gateway
  |
  +-- parse model
  |     "auto"        -> chain[0..n]
  |     "deepseek"    -> chain[indexOf("deepseek")..n]
  |     unknown       -> 404 model_not_found
  |
  +-- for each entry
        |
        +-- key missing and not optional -> skip (missing-key)
        +-- cooling down                -> skip (cooldown:<reason>)
        +-- POST <baseURL>/chat/completions
              |
              +-- non-2xx -> classify, cool down, continue
              +-- 2xx     -> reset entry, forward body (or pipe SSE), return
  |
  +-- chain exhausted -> 503 failover_exhausted + attempts[]
```

The model field in the outgoing body is replaced with `entry.model` on every
attempt. The rest of the body is forwarded byte-for-byte after parsing and
re-serializing. No message rewriting, no tool-call translation.

## Cooldown state

State is process memory: `Map<id, { until, reason, hits }>`.

| Trigger | Duration | Reason |
| --- | --- | --- |
| 429 | `cooldownSeconds` (90s) | `rate-limit` |
| 401, 403 | `authCooldownSeconds` (600s) | `auth` |
| 5xx | min(`cooldownSeconds`, 30) | `upstream` |
| network error | min(`cooldownSeconds`, 30) | `network` |
| success | entry removed | — |

`hits` counts consecutive failures and is exposed in `/health` so a flapping
provider is visible without reading logs. Restarting the gateway clears all
cooldowns; that is intentional, because a restart usually follows a config fix.

Client errors (`400`, `404`, `422`) return immediately and do not cool anything
down. Burning a healthy provider because the caller sent malformed JSON would be
worse than failing fast.

## Streaming

Streaming is decided before headers are sent, so failover stays possible: the
gateway opens the upstream request, checks `response.ok`, and only then writes
`200` to the client. If the upstream returns 429, nothing has been flushed yet
and the next provider is tried. Once piping starts, a mid-stream failure ends
the response; retrying would duplicate tokens.

`Readable.fromWeb(upstream.body).pipe(res)` keeps backpressure. `x-failover`
identifies the provider even on streams.

## Why abort signals are combined

`AbortSignal.any([clientAbort, timeout])` covers both cases:

- the client disconnects, so the upstream request should stop paying for tokens;
- the upstream stalls, so the chain should move on.

The client abort handler is attached to `res.on("close")`, which fires on normal
completion too; aborting an already-finished request is a no-op.

## Config shape

```jsonc
{
  "host": "127.0.0.1",
  "port": 8787,
  "cooldownSeconds": 90,
  "authCooldownSeconds": 600,
  "timeoutMs": 120000,
  "gatewayKey": "",
  "chain": [
    {
      "id": "unique-id",
      "label": "human label",
      "baseURL": "https://host/v1",
      "model": "upstream-model-id",
      "apiKeyEnv": "ENV_VAR_NAME",
      "apiKeyOptional": false,
      "headers": { "x-extra": "value" }
    }
  ]
}
```

`id`, `baseURL` and `model` are required. Duplicate ids are rejected at load
time, not at request time. `baseURL` is normalized by stripping trailing
slashes.

## OpenCode integration

`scripts/register.mjs` adds a provider entry to
`~/.config/opencode/opencode.json` and writes a `.bak` first. It uses the same
shape already present in the user's file (`provider` + `npm`), so it does not
mix V1 and V2 syntax in one document. The entry exposes a single model, `auto`,
because the chain is the product; pinning a chain id is still possible from any
other client.

## Testing

`test/smoke.mjs` runs two mock upstreams, one always `429`, one always `200`,
and asserts:

1. 429 falls through to the next provider;
2. the failed provider is skipped on the next request;
3. `/health` reports `cooldown` with reason `rate-limit`;
4. SSE passes through with the terminator intact;
5. an explicit chain id starts at that provider;
6. an unknown model returns 404 instead of silently falling back;
7. an exhausted chain returns 503 `failover_exhausted`.

No network access, no keys, deterministic.
