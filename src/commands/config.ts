import { Command } from "commander";
import { readConfig, writeConfig, getConfigPath } from "../config.js";

const MODELS_URL = "https://opencode.ai/zen/v1/models";

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
    console.log(`Set ${key} = ${value}`);
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
    let allPassed = true;

    if (!config.key) {
      console.log("FAIL  API key — not configured (run: zencommit config set key <your-key>)");
      allPassed = false;
    } else {
      console.log("PASS  API key — configured");
    }

    if (!config.model) {
      console.log("FAIL  Model — not configured (run: zencommit config set model <model-name>)");
      allPassed = false;
    } else {
      try {
        const response = await fetch(MODELS_URL);
        if (!response.ok) {
          console.log(`FAIL  Model — unable to fetch model list (HTTP ${response.status})`);
          allPassed = false;
        } else {
          const data = (await response.json()) as { data?: { id: string }[]; models?: { id: string }[] };
          const models: { id: string }[] = data.data ?? data.models ?? [];
          const modelIds = new Set(models.map((m) => m.id));

          if (modelIds.has(config.model!)) {
            console.log(`PASS  Model "${config.model}" — available`);
          } else {
            console.log(`FAIL  Model "${config.model}" — not found in available models`);
            console.log(`      Available models: ${[...modelIds].join(", ") || "(none)"}`);
            allPassed = false;
          }
        }
      } catch {
        console.log("FAIL  Model — network error fetching model list");
        allPassed = false;
      }
    }

    if (allPassed) {
      console.log("\nAll checks passed.");
    } else {
      console.log("\nSome checks failed. See above for details.");
      process.exitCode = 1;
    }
  });
