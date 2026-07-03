#!/usr/bin/env node

import { Command } from "commander";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const program = new Command();

program
  .name("zencommit")
  .description("AI-powered commit message generator")
  .version("0.1.0");

program
  .command("greet")
  .description("Test the CLI is working")
  .argument("[name]", "Name to greet", "World")
  .action((name: string) => {
    console.log(`Hello, ${name}!`);
  });

program.parse();
