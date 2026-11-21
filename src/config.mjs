import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.FAILOVER_HOME || join(homedir(), ".config", "opencode-failover");
export const CONFIG_PATH = process.env.FAILOVER_CONFIG || join(HOME, "gateway.json");

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  cooldownSeconds: 90,
  authCooldownSeconds: 600,
  timeoutMs: 120_000,
  gatewayKey: "",
};

export async function loadConfig(path = CONFIG_PATH) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`no config at ${path} — run the installer or copy gateway.config.example.json`);
    }
    throw err;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(cfg.chain) || cfg.chain.length === 0) {
    throw new Error(`${path}: chain must be a non-empty array`);
  }
  const seen = new Set();
  for (const entry of cfg.chain) {
    for (const field of ["id", "baseURL", "model"]) {
      if (!entry[field]) throw new Error(`${path}: every chain entry needs "${field}"`);
    }
    if (seen.has(entry.id)) throw new Error(`${path}: duplicate chain id "${entry.id}"`);
    seen.add(entry.id);
    entry.baseURL = entry.baseURL.replace(/\/+$/, "");
  }
  return { ...DEFAULTS, ...cfg, path };
}

export function keyFor(entry) {
  if (entry.apiKey) return entry.apiKey;
  if (entry.apiKeyEnv) return process.env[entry.apiKeyEnv] || "";
  return "";
}

export function entryHeaders(entry) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };
  const key = keyFor(entry);
  if (key) headers.authorization = `Bearer ${key}`;
  for (const [k, v] of Object.entries(entry.headers || {})) headers[k.toLowerCase()] = v;
  return headers;
}

export function redact(entry) {
  return {
    id: entry.id,
    label: entry.label || entry.id,
    model: entry.model,
    baseURL: entry.baseURL,
    key: keyFor(entry) ? "present" : entry.apiKeyOptional ? "optional" : "missing",
  };
}
