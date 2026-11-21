import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { createGateway } from "../src/gateway.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function mock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

const seen = [];

const rateLimited = await mock(async (req, res) => {
  seen.push(JSON.parse(await readBody(req)));
  res.writeHead(429, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "rate limited" } }));
});

const healthy = await mock(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  seen.push(body);

  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    res.end("data: [DONE]\n\n");
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "cmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: `from ${body.model}` } }],
    }),
  );
});

const cfg = {
  host: "127.0.0.1",
  port: 0,
  cooldownSeconds: 60,
  authCooldownSeconds: 600,
  timeoutMs: 5000,
  gatewayKey: "",
  path: "test",
  chain: [
    { id: "first", baseURL: `http://127.0.0.1:${rateLimited.address().port}`, model: "model-a", apiKey: "k" },
    { id: "second", baseURL: `http://127.0.0.1:${healthy.address().port}`, model: "model-b", apiKey: "k" },
  ],
};

const gateway = createGateway(cfg);
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${gateway.address().port}`;

// 1. 429 on the first provider falls through to the second.
const first = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
});
assert(first.status === 200, "first request returns 200");
assert(first.headers.get("x-failover") === "second", "served by second provider");
const firstJson = await first.json();
assert(firstJson.choices[0].message.content === "from model-b", "model remapped to model-b");
assert(seen[0].model === "model-a", "first provider received model-a");

// 2. The first provider is now cooling down and is skipped.
const second = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "again" }] }),
});
assert(second.status === 200, "second request returns 200");
assert(second.headers.get("x-failover") === "second", "still served by second provider");

const health = await (await fetch(`${base}/health`)).json();
const firstState = health.chain.find((entry) => entry.id === "first");
assert(firstState.state === "cooldown", "first provider is cooling down");
assert(firstState.cooldownReason === "rate-limit", "cooldown reason is rate-limit");

// 3. Streaming passes through untouched.
const stream = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
});
assert(stream.status === 200, "stream returns 200");
const streamText = await stream.text();
assert(streamText.includes("[DONE]"), "stream terminator forwarded");
assert(stream.headers.get("x-failover") === "second", "stream served by second provider");

// 4. Explicit model id starts at that entry.
const direct = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "second", messages: [{ role: "user", content: "hi" }] }),
});
assert(direct.headers.get("x-failover") === "second", "explicit model id honored");

// 5. Unknown model is a 404, not a silent fallback.
const unknown = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "nope", messages: [] }),
});
assert(unknown.status === 404, "unknown model returns 404");

// 6. Models endpoint lists auto plus every chain id.
const list = await (await fetch(`${base}/v1/models`)).json();
const ids = list.data.map((entry) => entry.id);
assert(ids.includes("auto") && ids.includes("first") && ids.includes("second"), "models list complete");

// 7. Everything cooling down returns 503 with attempts.
const all = createGateway({
  ...cfg,
  path: "test-all",
  chain: [cfg.chain[0]],
});
await new Promise((resolve) => all.listen(0, "127.0.0.1", resolve));
const allBase = `http://127.0.0.1:${all.address().port}`;
await fetch(`${allBase}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
});
const exhausted = await fetch(`${allBase}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
});
assert(exhausted.status === 503, "exhausted chain returns 503");
const exhaustedJson = await exhausted.json();
assert(exhaustedJson.error.type === "failover_exhausted", "error type is failover_exhausted");

// 8. A UTF-8 BOM from Notepad does not break config loading.
const dir = await mkdtemp(join(tmpdir(), "failover-bom-"));
const bomPath = join(dir, "gateway.json");
await writeFile(
  bomPath,
  `\ufeff${JSON.stringify({
    chain: [{ id: "x", baseURL: "http://127.0.0.1:1/", model: "m", apiKey: "k" }],
  })}`,
);
const loaded = await loadConfig(bomPath);
assert(loaded.chain[0].baseURL === "http://127.0.0.1:1", "BOM tolerated, trailing slash stripped");

console.log("8 checks passed");
gateway.close();
all.close();
rateLimited.close();
healthy.close();
