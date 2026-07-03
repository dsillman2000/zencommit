import { generateText, Output } from "ai";
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
- If the AGENTS.md section below specifies conventions, follow them`;

async function loadAgentsMd(): Promise<string> {
  try {
    const content = await readFile(join(cwd, "AGENTS.md"), "utf-8");
    return `\n\n**AGENTS.md (project conventions):**\n${content}`;
  } catch {
    return "";
  }
}

function formatCommit(entry: CommitEntry, index: number): string {
  const header = entry.scope
    ? `${entry.type}(${entry.scope}): ${entry.description}`
    : `${entry.type}: ${entry.description}`;
  const files = entry.files.map((f) => `  ${f}`).join("\n");
  return `Commit ${index + 1}: ${header}\nFiles:\n${files}`;
}

function formatCommitMessage(entry: CommitEntry): string {
  return entry.scope
    ? `${entry.type}(${entry.scope}): ${entry.description}`
    : `${entry.type}: ${entry.description}`;
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

export async function run(): Promise<void> {
  try {
    await runInternal();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

async function runInternal(): Promise<void> {
  const config = await readConfig();

  if (!config.key) {
    console.error("Error: API key not configured.");
    console.error("Run: zencommit config set key <your-openode-zen-api-key>");
    process.exit(1);
  }

  if (!config.model) {
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

  const model = provider(config.model);

  console.log(`Generating commit messages using ${config.model}...`);

  let result;
  try {
    result = await generateText({
      model,
      system: SYSTEM_PROMPT + agentsMdContent,
      prompt: "Analyze the current git working tree and produce conventional commit messages for all changes.",
      tools,
      maxSteps: 6,
      experimental_output: Output.object({ schema: commitSchema }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
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
      console.error(formatCommit(commits[i], i));
      console.error();
    }
    process.exit(1);
  }

  console.log();
  for (let i = 0; i < commits.length; i++) {
    console.log(formatCommit(commits[i], i));
    console.log();
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Apply these commits? [y/N] ");
  rl.close();

  if (!answer.toLowerCase().startsWith("y")) {
    console.log("Aborted.");
    return;
  }

  for (const entry of commits) {
    await git.add(entry.files);
    await git.commit(formatCommitMessage(entry));
  }

  console.log(`\nCommitted ${commits.length} commit(s).`);
}
