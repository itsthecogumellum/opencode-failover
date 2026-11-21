import http from "node:http";
import { Readable } from "node:stream";
import { entryHeaders, keyFor, redact } from "./config.mjs";

const MAX_BODY = 32 * 1024 * 1024;

function sendJson(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    ...extra,
  });
  res.end(body);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

export function createGateway(cfg) {
  const startedAt = Date.now();
  const cooldowns = new Map();

  const now = () => Date.now();

  function ready(entry) {
    const until = cooldowns.get(entry.id);
    return !until || until.until <= now();
  }

  function cool(entry, seconds, reason) {
    const prev = cooldowns.get(entry.id);
    cooldowns.set(entry.id, {
      until: now() + seconds * 1000,
      reason,
      hits: (prev?.hits || 0) + 1,
    });
  }

  function reset(entry) {
    cooldowns.delete(entry.id);
  }

  function chainFor(model) {
    const ids = cfg.chain.map((e) => e.id);
    if (!model || model === "auto" || model === "failover") return cfg.chain.slice();
    const index = ids.indexOf(model);
    if (index === -1) return null;
    return cfg.chain.slice(index);
  }

  function authorize(req) {
    if (!cfg.gatewayKey) return true;
    const header = req.headers.authorization || "";
    return header === `Bearer ${cfg.gatewayKey}`;
  }

  function health() {
    return {
      ok: true,
      version: "0.1.0",
      uptimeSeconds: Math.round((now() - startedAt) / 1000),
      config: cfg.path,
      listen: `http://${cfg.host}:${cfg.port}`,
      chain: cfg.chain.map((entry) => {
        const cooldown = cooldowns.get(entry.id);
        const state = !ready(entry) ? "cooldown" : keyFor(entry) || entry.apiKeyOptional ? "ready" : "no-key";
        return {
          ...redact(entry),
          state,
          cooldownUntil: state === "cooldown" ? new Date(cooldown.until).toISOString() : null,
          cooldownReason: state === "cooldown" ? cooldown.reason : null,
          failures: cooldown?.hits || 0,
        };
      }),
    };
  }

  function models() {
    const created = Math.floor(startedAt / 1000);
    return {
      object: "list",
      data: [
        { id: "auto", object: "model", created, owned_by: "opencode-failover" },
        ...cfg.chain.map((entry) => ({
          id: entry.id,
          object: "model",
          created,
          owned_by: "opencode-failover",
        })),
      ],
    };
  }

  async function proxy(req, res) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        sendJson(res, 413, { error: { message: "request body too large", type: "payload_too_large" } });
        return;
      }
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    const body = parseJson(raw);
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: { message: "body must be a JSON object", type: "invalid_request" } });
      return;
    }

    const chain = chainFor(body.model);
    if (!chain) {
      sendJson(res, 404, {
        error: {
          message: `unknown model "${body.model}"`,
          type: "model_not_found",
          available: ["auto", ...cfg.chain.map((e) => e.id)],
        },
      });
      return;
    }

    const abort = new AbortController();
    res.on("close", () => abort.abort());

    const attempts = [];
    for (const entry of chain) {
      if (!keyFor(entry) && !entry.apiKeyOptional) {
        attempts.push({ id: entry.id, skipped: "missing-key" });
        continue;
      }
      if (!ready(entry)) {
        const until = cooldowns.get(entry.id);
        attempts.push({
          id: entry.id,
          skipped: `cooldown:${until.reason}`,
          until: new Date(until.until).toISOString(),
        });
        continue;
      }

      const started = now();
      let upstream;
      try {
        upstream = await fetch(`${entry.baseURL}/chat/completions`, {
          method: "POST",
          headers: entryHeaders(entry),
          body: JSON.stringify({ ...body, model: entry.model }),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(cfg.timeoutMs)]),
        });
      } catch (err) {
        if (abort.signal.aborted) return;
        attempts.push({ id: entry.id, error: err.name });
        cool(entry, Math.min(cfg.cooldownSeconds, 30), "network");
        console.log(`[${stamp()}] ${entry.id} network ${err.name}`);
        continue;
      }

      const elapsed = now() - started;

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        attempts.push({ id: entry.id, status: upstream.status });

        if (upstream.status === 429) {
          cool(entry, cfg.cooldownSeconds, "rate-limit");
          console.log(`[${stamp()}] ${entry.id} 429 cooldown ${cfg.cooldownSeconds}s`);
          continue;
        }
        if (upstream.status === 401 || upstream.status === 403) {
          cool(entry, cfg.authCooldownSeconds, "auth");
          console.log(`[${stamp()}] ${entry.id} ${upstream.status} auth cooldown ${cfg.authCooldownSeconds}s`);
          continue;
        }
        if (upstream.status >= 500) {
          cool(entry, Math.min(cfg.cooldownSeconds, 30), "upstream");
          console.log(`[${stamp()}] ${entry.id} ${upstream.status} cooldown`);
          continue;
        }

        const parsed = parseJson(text);
        console.log(`[${stamp()}] ${entry.id} ${upstream.status} client-error`);
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || "application/json",
          "access-control-allow-origin": "*",
          "x-failover": entry.id,
        });
        res.end(text);
        return;
      }

      reset(entry);
      console.log(`[${stamp()}] ${entry.id} 200 ${elapsed}ms${body.stream ? " stream" : ""}`);

      if (body.stream) {
        res.writeHead(200, {
          "content-type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
          "x-failover": entry.id,
        });
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }

      const text = await upstream.text();
      res.writeHead(200, {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "access-control-allow-origin": "*",
        "x-failover": entry.id,
      });
      res.end(text);
      return;
    }

    console.log(`[${stamp()}] exhausted after ${attempts.length} attempt(s)`);
    sendJson(res, 503, {
      error: {
        message: "all providers are unavailable",
        type: "failover_exhausted",
        attempts,
      },
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
      });
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      sendJson(res, 200, health());
      return;
    }

    if (url.pathname === "/" || url.pathname === "/status") {
      sendJson(res, 200, health());
      return;
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      sendJson(res, 200, models());
      return;
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      if (!authorize(req)) {
        sendJson(res, 401, { error: { message: "bad gateway key", type: "unauthorized" } });
        return;
      }
      proxy(req, res).catch((err) => {
        console.error(`[${stamp()}] fatal ${err.stack || err.message}`);
        if (!res.headersSent) {
          sendJson(res, 500, { error: { message: err.message, type: "gateway_error" } });
        } else {
          res.end();
        }
      });
      return;
    }

    sendJson(res, 404, { error: { message: `no route ${req.method} ${url.pathname}`, type: "not_found" } });
  });

  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return server;
}
