#!/usr/bin/env node

import { Command } from "commander";
import { configCommand } from "./commands/config.js";
import { run } from "./zencommit.js";

const program = new Command();

program
  .name("zencommit")
  .description("AI-powered commit message generator")
  .version("0.1.0")
  .option("-m, --model <model>", "Override the model from config")
  .option("-y, --yes", "Auto-accept commit suggestions without prompting")
  .option("-v, --verbose", "Stream agent thoughts, tool calls, and responses");

program.addCommand(configCommand);

program.action(async (options) => {
  await run({ modelOverride: options.model as string | undefined, yes: options.yes as boolean, verbose: options.verbose as boolean });
});

program.parse();
