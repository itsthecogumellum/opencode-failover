import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 18787;
const upstreamPort = 18788;

const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: `pong from ${parsed.model}` } }],
      }),
    );
  });
});
await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));

const dir = await mkdtemp(join(tmpdir(), "failover-cli-"));
const configPath = join(dir, "gateway.json");
await writeFile(
  configPath,
  JSON.stringify({
    host: "127.0.0.1",
    port,
    chain: [
      {
        id: "mock",
        baseURL: `http://127.0.0.1:${upstreamPort}`,
        model: "mock-model",
        apiKey: "test",
      },
    ],
  }),
);

const child = spawn(process.execPath, ["src/cli.mjs", "serve", "--config", configPath], {
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return res.json();
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gateway did not start. output:\n${output}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

try {
  const health = await waitForHealth();
  assert(health.ok === true, "health ok");
  assert(health.chain[0].state === "ready", "chain ready");

  const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
  assert(models.data.some((entry) => entry.id === "auto"), "models lists auto");

  const completion = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "ping" }] }),
  });
  assert(completion.status === 200, "completion 200");
  const payload = await completion.json();
  assert(payload.choices[0].message.content === "pong from mock-model", "model rewritten");

  console.log("cli smoke passed");
} finally {
  child.kill();
  upstream.close();
}
