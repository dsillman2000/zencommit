import { Command } from "commander";
import { readConfig, writeConfig, getConfigPath } from "../config.js";

const MODELS_URL = "https://opencode.ai/zen/v1/models";

const G = "\x1b[32m";
const R = "\x1b[31m";
const Z = "\x1b[0m";

async function validateApiKey(key: string | undefined): Promise<boolean> {
  if (!key) {
    console.log(`${R}FAIL${Z}  API key — not configured (run: zencommit config set key <your-key>)`);
    return false;
  }
  console.log(`${G}PASS${Z}  API key — configured`);
  return true;
}

async function validateModel(model: string | undefined): Promise<boolean> {
  if (!model) {
    console.log(`${R}FAIL${Z}  Model — not configured (run: zencommit config set model <model-name>)`);
    return false;
  }
  try {
    const response = await fetch(MODELS_URL);
    if (!response.ok) {
      console.log(`${R}FAIL${Z}  Model — unable to fetch model list (HTTP ${response.status})`);
      return false;
    }
    const data = (await response.json()) as { data?: { id: string }[]; models?: { id: string }[] };
    const models: { id: string }[] = data.data ?? data.models ?? [];
    const modelIds = new Set(models.map((m) => m.id));
    if (modelIds.has(model)) {
      console.log(`${G}PASS${Z}  Model "${model}" — available`);
      return true;
    }
    console.log(`${R}FAIL${Z}  Model "${model}" — not found in available models`);
    console.log(`      Available models: ${[...modelIds].join(", ") || "(none)"}`);
    return false;
  } catch {
    console.log(`${R}FAIL${Z}  Model — network error fetching model list`);
    return false;
  }
}

export const configCommand = new Command("config")
  .description("Manage zencommit configuration");

configCommand
  .command("set")
  .description("Set a configuration value")
  .argument("<key>", "Configuration key (e.g. key, model)")
  .argument("<value>", "The value to set")
  .action(async (key: string, value: string) => {
    const config = await readConfig();
    config[key] = value;
    await writeConfig(config);
    if (key === "key") {
      await validateApiKey(value);
    } else if (key === "model") {
      await validateModel(value);
    }
  });

configCommand
  .command("get")
  .description("Get a configuration value")
  .argument("<key>", "Configuration key")
  .action(async (key: string) => {
    const config = await readConfig();
    if (config[key] !== undefined) {
      console.log(config[key]);
    } else {
      console.log(`(not set)`);
    }
  });

configCommand
  .command("show")
  .description("Show the full configuration")
  .action(async () => {
    const config = await readConfig();
    if (Object.keys(config).length === 0) {
      console.log("No configuration set.");
      console.log(`Config file: ${getConfigPath()}`);
    } else {
      console.log(JSON.stringify(config, null, 2));
      console.log(`\nConfig file: ${getConfigPath()}`);
    }
  });

configCommand
  .command("validate")
  .description("Validate API key and model availability")
  .action(async () => {
    const config = await readConfig();
    const keyOk = await validateApiKey(config.key);
    const modelOk = await validateModel(config.model);

    if (keyOk && modelOk) {
      console.log("\nAll checks passed.");
    } else {
      console.log("\nSome checks failed. See above for details.");
      process.exitCode = 1;
    }
  });
