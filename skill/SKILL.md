---
name: model-failover
description: Route around a rate-limited, quota-exhausted or offline model provider with the local failover gateway. Use when a request fails with 429, quota, auth or provider outage, or when the user asks to switch models quickly. Covers starting the gateway, reading chain health, adding a provider you own, and testing the chain.
---

# Model failover

A local OpenAI-compatible gateway that tries a chain of providers you already
have credentials for. When one returns 429, 5xx, auth failure or times out, it
cools down and the next one answers. State lives in memory; nothing is written
to disk except the config.

## When to use

- A request failed with 429, quota, `rate_limit`, or a provider outage.
- The user asks "why is the model down", "switch provider", "fallback".
- The user wants one stable endpoint while working across several providers.

## Check state first

```bash
failover status
```

Read `chain[]`. Each entry reports `state`:

- `ready` — key present, not cooling down.
- `cooldown` — skip until `cooldownUntil`; `cooldownReason` says why.
- `no-key` — the environment variable named in `apiKeyEnv` is empty.

Never guess the state. If the gateway is not running, `status` exits 2.

## Start it

```bash
failover serve
```

Listens on `http://127.0.0.1:8787/v1`. Leave it running in its own terminal or
register the logon task:

```bash
schtasks /create /tn opencode-failover /tr "node %USERPROFILE%\.config\opencode-failover\src\cli.mjs serve" /sc onlogon
```

## Test the chain

```bash
failover test
```

Prints the status code, the provider that answered (`x-failover` header) and the
body. One passing call means the whole chain is usable.

## Use from OpenCode

The installer registers a provider called `failover` with a single model,
`auto`. Pick `failover/auto` in `/models`. The gateway walks the whole chain
under that one model id, so the session survives a provider dying mid-task.

## Add a provider

Edit `~/.config/opencode-failover/gateway.json`, append to `chain`, restart the
gateway. Order is priority order.

```json
{
  "id": "openrouter-sonnet",
  "label": "OpenRouter Sonnet",
  "baseURL": "https://openrouter.ai/api/v1",
  "model": "anthropic/claude-sonnet-5.5",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

Rules:

- `id` is unique and is also a selectable model id.
- `baseURL` must expose `POST /chat/completions` (OpenAI format).
- `model` is the upstream model id, not the label.
- `apiKeyEnv` names an environment variable. Never paste the key in the file.
- `apiKeyOptional: true` for local runtimes such as Ollama.
- `headers` adds static headers if the provider needs them.

## What this does not do

- It does not create quotas, reset quotas, rotate IPs, or register accounts.
- It does not proxy around a ban or a regional block.
- It only moves work between providers the user is already entitled to use.

If the user asks for any of the first three, say no and offer the failover
chain instead.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `status` exits 2 | gateway not running: `failover serve` |
| Every entry `no-key` | environment variables are not set in the gateway's shell |
| 503 `failover_exhausted` | read `attempts[]`; usually all cooling down at once |
| 404 `model_not_found` | use `auto` or an exact `chain[].id` |
| Streaming stalls | the upstream does not implement SSE; test it with `failover test` |
| Wrong model answers | `chain[].model` is the upstream id; `label` is cosmetic |
