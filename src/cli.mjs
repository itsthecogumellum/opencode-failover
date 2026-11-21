#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { CONFIG_PATH, loadConfig } from "./config.mjs";
import { createGateway } from "./gateway.mjs";

const [command = "serve", ...args] = process.argv.slice(2);

function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

async function serve() {
  const cfg = await loadConfig(flag("config", CONFIG_PATH));
  const server = createGateway(cfg);

  server.listen(cfg.port, cfg.host, () => {
    console.log(`opencode-failover listening on http://${cfg.host}:${cfg.port}/v1`);
    console.log(`config: ${cfg.path}`);
    for (const entry of cfg.chain) {
      console.log(`  - ${entry.id} -> ${entry.model} @ ${entry.baseURL}`);
    }
  });

  const shutdown = () => {
    console.log("\nshutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, headers: res.headers, data };
}

async function status() {
  const cfg = await loadConfig();
  const url = `http://${cfg.host}:${cfg.port}/health`;
  try {
    const { status: code, data } = await fetchJson(url);
    console.log(JSON.stringify(data, null, 2));
    process.exitCode = code === 200 ? 0 : 1;
  } catch {
    console.error(`gateway is not running (${url})`);
    console.error("start it with: failover serve");
    process.exitCode = 2;
  }
}

async function test() {
  const cfg = await loadConfig();
  const url = `http://${cfg.host}:${cfg.port}/v1/chat/completions`;
  const started = Date.now();
  const { status: code, headers, data } = await fetchJson(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.gatewayKey ? { authorization: `Bearer ${cfg.gatewayKey}` } : {}),
    },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "reply with the single word: ok" }],
      max_tokens: 16,
      stream: false,
    }),
  });

  console.log(`status ${code} in ${Date.now() - started}ms`);
  console.log(`provider ${headers.get("x-failover") || "none"}`);
  console.log(JSON.stringify(data, null, 2));
  process.exitCode = code === 200 ? 0 : 1;
}

async function printConfig() {
  const raw = await readFile(flag("config", CONFIG_PATH), "utf8");
  console.log(raw);
}

const commands = {
  serve,
  start: serve,
  status,
  test,
  config: printConfig,
  help: async () => {
    console.log(`failover <command>

  serve            start the gateway
  status           print health of the chain
  test             send one prompt through the chain
  config           print the active config
  help             this text

flags:
  --config <path>  use another gateway.json
`);
  },
};

const run = commands[command] || commands.help;

try {
  await run();
} catch (err) {
  console.error(`failover: ${err.message}`);
  process.exitCode = 1;
}
