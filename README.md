# opencode-failover

A local OpenAI-compatible gateway that keeps your coding session alive when a
model provider hits a rate limit, runs out of quota, loses auth or goes down.

You give it a chain of providers you already pay for or already run locally. It
tries them in order, cools down whatever fails, and answers from the next one.
One endpoint, one model id, `auto`.

```
OpenCode  ->  http://127.0.0.1:8787/v1  ->  deepseek  ->  openai  ->  ollama
                        |
                        +-- 429? cooldown 90s, try next
                        +-- 401? cooldown 10m, try next
                        +-- 5xx? cooldown 30s, try next
                        +-- 200? stream it back with x-failover: <id>
```

It does not create quotas. It moves the work to another quota you already own.

## Install

Windows, one command:

```powershell
irm https://raw.githubusercontent.com/itsthecogumellum/opencode-failover/main/install.ps1 | iex
```

Windows, with autostart at logon:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/itsthecogumellum/opencode-failover/main/install.ps1))) -Autostart
```

Linux and macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/itsthecogumellum/opencode-failover/main/install.sh | bash
```

The installer:

1. checks Node.js 20+;
2. copies the gateway to `~/.config/opencode-failover`;
3. creates `gateway.json` from the example;
4. writes the `failover` command and adds it to your PATH;
5. registers the `failover` provider in `~/.config/opencode/opencode.json`
   (backup written to `opencode.json.bak`);
6. optionally registers a logon task.

## Configure

```jsonc
// ~/.config/opencode-failover/gateway.json
{
  "port": 8787,
  "cooldownSeconds": 90,
  "authCooldownSeconds": 600,
  "timeoutMs": 120000,
  "chain": [
    {
      "id": "deepseek-flash",
      "label": "DeepSeek Chat",
      "baseURL": "https://api.deepseek.com/v1",
      "model": "deepseek-flash",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    },
    {
      "id": "openai-mini",
      "label": "OpenAI mini",
      "baseURL": "https://api.openai.com/v1",
      "model": "gpt-4.1-mini",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    {
      "id": "ollama-qwen",
      "label": "Ollama local",
      "baseURL": "http://127.0.0.1:11434/v1",
      "model": "qwen2.5:7b-instruct",
      "apiKeyOptional": true
    }
  ]
}
```

Order is priority order. `apiKeyEnv` names an environment variable; the key is
never stored in the file. `id` is also a selectable model id, so you can pin one
request to one provider when you want to.

## Run

```bash
failover serve      # start
failover status     # chain health, cooldowns, which keys are missing
failover test       # one prompt through the chain
failover config     # print the active config
```

Then, in OpenCode, choose `failover/auto`. Every request walks the chain, so a
provider dying mid-session does not kill the session.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | chain state, reasons, cooldown timestamps |
| `GET` | `/v1/models` | `auto` plus every `chain[].id` |
| `POST` | `/v1/chat/completions` | OpenAI format, streaming and non-streaming |
| `GET` | `/` or `/status` | same payload as `/health` |

Responses carry `x-failover: <chain id>`, so you always know who answered.

## Failover rules

| Upstream result | Action |
| --- | --- |
| `429` | cooldown `cooldownSeconds`, next provider |
| `401` / `403` | cooldown `authCooldownSeconds`, next provider |
| `5xx` | cooldown 30s, next provider |
| network error | cooldown 30s, next provider |
| timeout | cooldown 30s, next provider |
| `400` / `422` | returned as-is, chain not burned |
| `404 model` | returned as-is, chain not burned |

A client error is your request's fault, not the provider's, so it never triggers
a cooldown. When everything is cooling down the gateway returns `503` with
`error.type = "failover_exhausted"` and an `attempts[]` list explaining each
skip.

## Add a provider

Any endpoint that speaks `POST /chat/completions` works.

```json
{
  "id": "openrouter-sonnet",
  "baseURL": "https://openrouter.ai/api/v1",
  "model": "anthropic/claude-sonnet-5.5",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

```json
{
  "id": "groq-llama",
  "baseURL": "https://api.groq.com/openai/v1",
  "model": "llama-3.3-70b-versatile",
  "apiKeyEnv": "GROQ_API_KEY"
}
```

```json
{
  "id": "gemini-flash",
  "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai",
  "model": "gemini-2.5-flash",
  "apiKeyEnv": "GEMINI_API_KEY"
}
```

Local runtimes need no key:

```json
{ "id": "lmstudio", "baseURL": "http://127.0.0.1:1234/v1", "model": "qwen3-coder", "apiKeyOptional": true }
```

## What it deliberately does not do

- No IP rotation, no proxy pools, no account creation.
- No quota resets, no billing tricks, no re-registration.
- No bypass of a regional block or a ban.

Those are evasion of the provider's controls. This tool solves the normal
problem â€” one provider is temporarily unavailable and you have another one â€”
by moving the request. If a provider offers no quota you own, the honest answer
is another provider, a paid plan, or a local model.

## Security

- Binds `127.0.0.1` by default.
- Keys stay in environment variables; the config only names them.
- Optional `gatewayKey` requires `Authorization: Bearer <key>` on requests.
- Logs one line per attempt, no prompt bodies, no keys.

## Development

```bash
node test/smoke.mjs
```

Seven checks: rate-limit fallthrough, cooldown skip, health state, streaming
passthrough, explicit model pinning, unknown model, exhausted chain.

## Layout

```
src/config.mjs     config load, key lookup, header building
src/gateway.mjs    router, cooldown state, HTTP server
src/cli.mjs        serve / status / test / config
scripts/register.mjs  merges the provider into opencode.json
skill/SKILL.md     OpenCode skill for agents
test/smoke.mjs     end-to-end checks with mock upstreams
install.ps1        Windows installer
install.sh         POSIX installer
```

MIT.
