#!/usr/bin/env node

/**
 * zencommit CLI entry point.
 *
 * Sets up the Commander program with options and subcommands, then
 * delegates to {@link run} for the core commit-generation flow.
 *
 * @module zencommit
 */
import { Command } from "commander";
import { configCommand } from "./commands/config.js";
import { run } from "./zencommit.js";
import { listModels } from "./models.js";

const program = new Command();

program
  .name("zencommit")
  .description("AI-powered commit message generator")
  .version("0.1.0")
  .option("-m, --model <model>", "Override the model from config")
  .option("-y, --yes", "Auto-accept commit suggestions without prompting")
  .option("-v, --verbose", "Stream agent thoughts, tool calls, and responses")
  .option("-p, --prompt <prompt>", "Inject a custom instruction into the user prompt");

program.addCommand(configCommand);

program
  .command("models")
  .description("List available OpenCode Zen models and their per-1M-token pricing")
  .action(async () => {
    try {
      await listModels();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.action(async (options) => {
  await run({
    modelOverride: options.model as string | undefined,
    yes: options.yes as boolean,
    verbose: options.verbose as boolean,
    promptOverride: options.prompt as string | undefined,
  });
});

program.parse();
