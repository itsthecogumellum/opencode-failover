import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const configPath =
  process.env.OPENCODE_CONFIG || join(homedir(), ".config", "opencode", "opencode.json");
const port = process.env.FAILOVER_PORT || "8787";

let config = { $schema: "https://opencode.ai/config.json" };

try {
  config = JSON.parse(await readFile(configPath, "utf8"));
  await copyFile(configPath, `${configPath}.bak`);
  console.log(`backup: ${configPath}.bak`);
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  console.log(`creating: ${configPath}`);
}

if (!config.provider || typeof config.provider !== "object") config.provider = {};

config.provider.failover = {
  npm: "@ai-sdk/openai-compatible",
  name: "Failover (local)",
  options: {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "local",
  },
  models: {
    auto: {
      name: "Auto (failover chain)",
      limit: { context: 200000, output: 64000 },
    },
  },
};

await mkdir(dirname(configPath), { recursive: true });
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`provider "failover" registered in ${configPath}`);
console.log(`model: failover/auto`);
