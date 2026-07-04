import { generateText, Output, NoObjectGeneratedError } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { readConfig } from "./config.js";
import { tools } from "./tools/index.js";

const cwd = process.cwd();
const git = simpleGit(cwd);

const Z = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";

const typeColor: Record<string, string> = {
  feat: "\x1b[36m",    fix: "\x1b[33m",     docs: "\x1b[34m",
  style: "\x1b[35m",   refactor: "\x1b[32m", perf: "\x1b[31m",
  test: "\x1b[32m",    chore: "\x1b[2m",     ci: "\x1b[2m",
  build: "\x1b[2m",    revert: "\x1b[31m",
};

function startSpinner(message: string) {
  const chars = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r\x1b[K${chars[i % chars.length]} ${message}`);
    i++;
  }, 80);
  return {
    stop: () => {
      clearInterval(interval);
      process.stdout.write("\r\x1b[K");
    },
  };
}

interface CommitEntry {
  type: string;
  scope?: string;
  description: string;
  files: string[];
}

const commitSchema = z.object({
  commits: z.array(
    z.object({
      type: z.enum([
        "feat", "fix", "docs", "style", "refactor", "perf",
        "test", "chore", "ci", "build", "revert",
      ]),
      scope: z.string().optional(),
      description: z.string(),
      files: z.array(z.string()).min(1),
    })
  ),
});

const SYSTEM_PROMPT = `You are an expert at writing conventional commit messages for git repositories.

**Workflow**
1. Use the gitStatus tool to see all changed files.
2. Use the gitDiff tool to understand the specific changes in each file.
3. Use the gitLog tool to see recent commit conventions.
4. Use the readFile tool if you need more context about file contents.
5. Produce a list of commits where each changed file is assigned to exactly one commit.

**Commit Rules**
- Each commit must follow the Conventional Commits format: type(scope): description
- Valid types: feat, fix, docs, style, refactor, perf, test, chore, ci, build, revert
- Scope is optional but encouraged when clearly applicable
- Description must be in imperative mood, lowercase, and concise
- Each commit MUST list the exact file paths in the 'files' array
- EVERY changed file must appear in exactly ONE commit
- Group logically related file changes into a single commit
- Split clearly independent changes into separate commits only when warranted
- There can be at most as many commits as there are changed files
- If the AGENTS.md section below specifies conventions, follow them

**Critical Output Format**
- Your final response MUST be raw, valid JSON and nothing else.
- Do NOT wrap the JSON in markdown code fences (no \`\`\`json or \`\`\`).
- The response must start with { and end with } — pure JSON, no prefix, no suffix.`;

async function loadAgentsMd(): Promise<string> {
  try {
    const content = await readFile(join(cwd, "AGENTS.md"), "utf-8");
    return `\n\n**AGENTS.md (project conventions):**\n${content}`;
  } catch {
    return "";
  }
}

function header(entry: CommitEntry): string {
  const c = typeColor[entry.type] ?? "";
  return entry.scope
    ? `${c}${entry.type}${Z}(${entry.scope}): ${entry.description}`
    : `${c}${entry.type}${Z}: ${entry.description}`;
}

function message(entry: CommitEntry): string {
  return entry.scope
    ? `${entry.type}(${entry.scope}): ${entry.description}`
    : `${entry.type}: ${entry.description}`;
}

function renderCommit(entry: CommitEntry, index: number): string {
  const lines = [
    `\n ${B}${String(index + 1).padStart(2, " ")}.${Z} ${header(entry)}`,
    ` ${D}Files${Z}`,
    ...entry.files.map((f) => `    ${D}•${Z} ${f}`),
  ];
  return lines.join("\n");
}

function validateCommits(commits: CommitEntry[]): string[] {
  const errors: string[] = [];
  const seenFiles = new Map<string, number>();

  for (let i = 0; i < commits.length; i++) {
    for (const file of commits[i].files) {
      if (seenFiles.has(file)) {
        errors.push(
          `File "${file}" appears in both commit ${seenFiles.get(file)! + 1} and commit ${i + 1}`
        );
      }
      seenFiles.set(file, i);
    }
  }

  return errors;
}

function stripMarkdownJsonFences(text: string): string {
  let stripped = text.trim();
  if (stripped.startsWith("```")) {
    const firstNewline = stripped.indexOf("\n");
    if (firstNewline !== -1) {
      stripped = stripped.slice(firstNewline + 1);
      if (stripped.endsWith("```")) {
        stripped = stripped.slice(0, -3).trimEnd();
      }
    }
  }
  return stripped;
}

export async function run(opts?: { modelOverride?: string; yes?: boolean; verbose?: boolean }): Promise<void> {
  try {
    await runInternal(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

async function runInternal(opts?: { modelOverride?: string; yes?: boolean; verbose?: boolean }): Promise<void> {
  const config = await readConfig();

  if (!config.key) {
    console.error("Error: API key not configured.");
    console.error("Run: zencommit config set key <your-openode-zen-api-key>");
    process.exit(1);
  }

  const modelName = opts?.modelOverride ?? config.model;

  if (!modelName) {
    console.error("Error: Model not configured.");
    console.error("Run: zencommit config set model <model-name>");
    process.exit(1);
  }

  const status = await git.status();
  const allChanged = [
    ...status.staged,
    ...status.modified,
    ...status.deleted,
    ...status.created,
    ...status.not_added,
    ...status.renamed.map((r) => r.to),
  ];

  if (allChanged.length === 0) {
    console.log("Nothing to commit. Working tree clean.");
    return;
  }

  const agentsMdContent = await loadAgentsMd();

  const provider = createOpenAICompatible({
    name: "zen",
    baseURL: "https://opencode.ai/zen/v1",
    apiKey: config.key,
  });

  const model = provider(modelName);
  const spinner = opts?.verbose ? null : startSpinner("Analyzing changes...");

  let stepNumber = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onStepFinish: ((step: any) => void) | undefined =
    opts?.verbose
      ? (step) => {
          stepNumber++;
          console.log(`\n${D}Step ${stepNumber} (${step.stepType})${Z}`);

          if (step.text.trim()) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const text: string = step.text;
            console.log(`${D}│ text:${Z} ${text.trim().split("\n").join(`\n${D}│      ${Z}`)}`);
          }

          if (step.reasoning?.trim()) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const reasoning: string = step.reasoning;
            console.log(`${D}│ reasoning:${Z} ${reasoning.trim().split("\n").join(`\n${D}│            ${Z}`)}`);
          }

          if (step.toolCalls.length > 0) {
            console.log(`${D}│ tool calls:${Z}`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const tc of step.toolCalls as any[]) {
              const argsStr = JSON.stringify(tc.args);
              const truncated = argsStr.length > 300 ? argsStr.slice(0, 300) + "…" : argsStr;
              console.log(`${D}│   •${Z} ${tc.toolName}(${truncated})`);
            }
          }

          if (step.toolResults.length > 0) {
            console.log(`${D}│ tool results:${Z}`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const tr of step.toolResults as any[]) {
              const raw = tr.result;
              const resultStr = typeof raw === "string" ? raw : JSON.stringify(raw);
              const truncated = resultStr.length > 120 ? resultStr.slice(0, 120) + `…${D} (truncated)${Z}` : resultStr;
              console.log(`${D}│   •${Z} ${tr.toolName}: ${truncated.split("\n").join(`\n${D}│     ${Z}`)}`);
            }
          }
        }
      : undefined;

  if (opts?.verbose) {
    console.log(`${D}─── Verbose agent logs ───${Z}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  let recovered = false;
  try {
    result = await generateText({
      model,
      system: SYSTEM_PROMPT + agentsMdContent,
      prompt: "Analyze the current git working tree and produce conventional commit messages for all changes. Respond with raw JSON only, no markdown fences.",
      tools,
      maxSteps: 6,
      experimental_output: Output.object({ schema: commitSchema }),
      onStepFinish,
    });
  } catch (err) {
    spinner?.stop();
    if (NoObjectGeneratedError.isInstance(err) && err.text) {
      try {
        const stripped = stripMarkdownJsonFences(err.text);
        const parsed = commitSchema.safeParse(JSON.parse(stripped));
        if (parsed.success) {
          result = { experimental_output: parsed.data, usage: err.usage, steps: [] };
          recovered = true;
        } else {
          if (opts?.verbose) {
            console.log(`\n${D}─── End verbose agent logs (${stepNumber} steps) ───${Z}\n`);
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Error: ${message}`);
          process.exit(1);
        }
      } catch {
        if (opts?.verbose) {
          console.log(`\n${D}─── End verbose agent logs (${stepNumber} steps) ───${Z}\n`);
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    } else {
      if (opts?.verbose) {
        console.log(`\n${D}─── End verbose agent logs (${stepNumber} steps) ───${Z}\n`);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  }

  spinner?.stop();

  if (opts?.verbose) {
    if (recovered) {
      console.log(`\n${D}─── End verbose agent logs (${stepNumber} steps, ${result.usage?.totalTokens ?? "?"} tokens, recovered from markdown fences) ───${Z}\n`);
    } else {
      console.log(`\n${D}─── End verbose agent logs (${result.steps.length} steps, ${result.usage.totalTokens} tokens) ───${Z}\n`);
    }
  }

  if (!result.experimental_output) {
    console.error("Error: No commit messages generated.");
    process.exit(1);
  }

  const { commits } = result.experimental_output as { commits: CommitEntry[] };

  if (commits.length === 0) {
    console.log("No commits generated.");
    return;
  }

  const errors = validateCommits(commits);
  if (errors.length > 0) {
    console.error("Error: Invalid commit structure returned by AI:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    console.error("\nGenerated commits were:");
    for (let i = 0; i < commits.length; i++) {
      console.error(renderCommit(commits[i], i));
    }
    console.error();
    process.exit(1);
  }

  console.log("━".repeat(48));
  for (let i = 0; i < commits.length; i++) {
    console.log(renderCommit(commits[i], i));
  }
  console.log("\n" + "━".repeat(48) + "\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = opts?.yes ? "y" : await rl.question("Apply these commits? [y/N] ");
  rl.close();

  if (!answer.toLowerCase().startsWith("y")) {
    console.log("Aborted.");
    return;
  }

  for (const entry of commits) {
    await git.add(entry.files);
    await git.commit(message(entry));
  }

  console.log(`\n${D}Committed ${commits.length} commit(s).${Z}`);
}
