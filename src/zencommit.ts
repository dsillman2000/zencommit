/**
 * Core commit-generation logic.
 *
 * Orchestrates the full flow:
 *
 * 1. Reads config and validates the API key / model.
 * 2. Pre-fetches git context (changed files, diffs).
 * 3. Calls the OpenCode Zen API to generate a Conventional Commits plan.
 * 4. Validates file coverage and repairs malformed output when needed.
 * 5. Presents the plan interactively; accepts feedback / revisions.
 * 6. Executes commits via simple-git.
 */
import { generateText, Output, NoObjectGeneratedError, type LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { createInterface } from "node:readline/promises";
import { simpleGit } from "simple-git";
import { readConfig } from "./config.js";
import { tools } from "./tools/index.js";
import {
  SYSTEM_PROMPT,
  precomputeContext,
  allChangedPaths,
  loadAgentsMd,
  type PrefetchedContext,
} from "./prompt.js";
import {
  repairJSON,
  validateFileCoverage,
  buildFormatRetryFeedback,
  buildFilesRetryFeedback,
  type FilesValidationIssue,
} from "./repair.js";

const cwd = process.cwd();
const git = simpleGit(cwd);

/** ANSI reset code. */
const Z = "\x1b[0m";
/** ANSI bold. */
const B = "\x1b[1m";
/** ANSI dim. */
const D = "\x1b[2m";

/**
 * Maps Conventional Commit types to their display colours in the terminal.
 *
 * Types that share the same colour (e.g. ``test`` / ``refactor``, or
 * ``chore`` / ``ci`` / ``build``) are visually indistinguishable but
 * semantically distinct.
 */
const typeColor: Record<string, string> = {
  feat: "\x1b[36m",    fix: "\x1b[33m",     docs: "\x1b[34m",
  style: "\x1b[35m",   refactor: "\x1b[32m", perf: "\x1b[31m",
  test: "\x1b[32m",    chore: "\x1b[2m",     ci: "\x1b[2m",
  build: "\x1b[2m",    revert: "\x1b[31m",
};

/**
 * Handle for a terminal spinner animation.
 *
 * Allows callers to update the displayed label, stop the spinner, and
 * check whether the animation is still active.
 */
export interface SpinnerHandle {
  /** Updates the label shown next to the spinner. */
  update: (message: string) => void;
  /** Stops the spinner and clears the line. */
  stop: () => void;
  /** Returns ``true`` if the spinner is currently animating. */
  isRunning: () => boolean;
}

/**
 * Starts a continuous spinner animation on the terminal.
 *
 * The spinner occupies a single line and rotates through a set of
 * braille-dot characters while showing the given message.
 *
 * @param message - The initial label to display.
 * @returns A {@link SpinnerHandle} for updating or stopping the spinner.
 */
export function startSpinner(message: string): SpinnerHandle {
  const chars = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let i = 0;
  let current = message;
  let running = true;
  const interval = setInterval(() => {
    process.stdout.write(`\r\x1b[K${chars[i % chars.length]} ${current}`);
    i++;
  }, 80);
  return {
    update: (msg) => {
      current = msg;
    },
    stop: () => {
      if (!running) return;
      clearInterval(interval);
      running = false;
      process.stdout.write("\r\x1b[K");
    },
    isRunning: () => running,
  };
}

/**
 * A single commit entry in the AI-generated plan.
 */
export interface CommitEntry {
  /** Conventional Commit type (e.g. ``feat``, ``fix``). */
  type: string;
  /** Optional scope (e.g. ``api``, ``cli``). */
  scope?: string;
  /** Imperative-mood, lowercase description. */
  description: string;
  /** Exact relative file paths included in this commit. */
  files: string[];
}

/**
 * Zod schema for validating the AI model's JSON output.
 *
 * Defines the expected structure of the commit plan: an array of
 * {@link CommitEntry} objects with enumerated types and required file
 * lists.
 */
export const commitSchema = z.object({
  commits: z.array(
    z.object({
      type: z.enum([
        "feat", "fix", "docs", "style", "refactor", "perf",
        "test", "chore", "ci", "build", "revert",
      ]).describe("Conventional commit type"),
      scope: z.string()
        .optional()
        .describe("Optional scope, lowercase, no spaces (e.g. 'api', 'cli', 'docs')"),
      description: z.string()
        .describe("Short imperative-mood lowercase summary of the change"),
      files: z.array(z.string()).min(1)
        .describe("Exact relative file paths included in this commit"),
    })
  ),
});

export function header(entry: CommitEntry): string {
  const c = typeColor[entry.type] ?? "";
  return entry.scope
    ? `${c}${entry.type}${Z}(${entry.scope}): ${entry.description}`
    : `${c}${entry.type}${Z}: ${entry.description}`;
}

export function message(entry: CommitEntry): string {
  return entry.scope
    ? `${entry.type}(${entry.scope}): ${entry.description}`
    : `${entry.type}: ${entry.description}`;
}

/**
 * Renders a single commit entry for terminal display.
 *
 * Includes a numbered header, colourised commit type, and a bulleted
 * file list.
 *
 * @param entry - The commit entry to render.
 * @param index - Zero-based position in the commit list (displayed
 *   as 1-based).
 * @returns A formatted multi-line string.
 */
export function renderCommit(entry: CommitEntry, index: number): string {
  const lines = [
    `\n ${B}${String(index + 1).padStart(2, " ")}.${Z} ${header(entry)}`,
    ` ${D}Files${Z}`,
    ...entry.files.map((f) => `    ${D}•${Z} ${f}`),
  ];
  return lines.join("\n");
}

/**
 * Prints the full commit plan to the terminal with a decorative border.
 *
 * @param commits - The commit entries to render.
 */
function renderCommits(commits: CommitEntry[]): void {
  const bar = "━".repeat(48);
  console.log(bar);
  for (let i = 0; i < commits.length; i++) {
    console.log(renderCommit(commits[i], i));
  }
  console.log("\n" + bar + "\n");
}

/**
 * Serializes a commit plan to a pretty-printed JSON string.
 *
 * @param commits - The commit entries.
 * @returns A JSON string with ``{ commits: [...] }`` shape.
 */
export function commitsAsJson(commits: CommitEntry[]): string {
  return JSON.stringify({ commits }, null, 2);
}

/**
 * Builds the user prompt for the initial commit-generation request.
 *
 * Wraps the pre-fetched changed-files list and diffs in XML-style tags
 * for the model.
 *
 * @param context - Pre-fetched git context.
 * @returns The complete user-prompt string.
 */
export function buildUserPrompt(context: PrefetchedContext): string {
  return [
    "<changed_files>",
    context.formatted.files,
    "</changed_files>",
    "",
    "<diffs>",
    context.formatted.diffs,
    "</diffs>",
    "",
    "Analyze the above and produce conventional commit messages for all changes.",
    "Respond with raw JSON only — no markdown fences, no commentary.",
  ].join("\n");
}

/**
 * Builds the user prompt for a revision (replan) request.
 *
 * Includes the original context, the previous commit plan, and the
 * user's feedback so the model can refine the plan.
 *
 * @param context - Pre-fetched git context.
 * @param currentCommits - The previous commit plan the user wants to
 *   change.
 * @param feedback - The user's free-text revision feedback.
 * @returns The complete refocus-prompt string.
 */
export function buildRefocusPrompt(context: PrefetchedContext, currentCommits: CommitEntry[], feedback: string): string {
  return [
    buildUserPrompt(context),
    "",
    "<previous_plan>",
    commitsAsJson(currentCommits),
    "</previous_plan>",
    "",
    "<feedback>",
    feedback,
    "</feedback>",
    "",
    "Revise the commit plan above based on the user's feedback.",
    "Preserve commits that are still valid; only change entries that the feedback requires.",
    "Respond with raw JSON only — no markdown fences, no commentary.",
  ].join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStep = any;

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…(truncated)";
}

/**
 * Creates an on-step-finished callback that logs verbose agent traces.
 *
 * When ``verbose`` is ``true`` the returned callback prints the step
 * counter, model text/output, reasoning, tool calls, tool results,
 * finish reason, and token usage for every agent step.  When
 * ``verbose`` is ``false`` the function returns ``undefined``
 * (step logging is disabled).
 *
 * @param verbose - Whether verbose logging is enabled.
 * @param setLabel - Callback to update the spinner / status label.
 * @returns A step callback, or ``undefined`` if verbose is off.
 */
export function verboseStepLogger(verbose: boolean, setLabel: (label: string) => void): ((step: AnyStep) => void) | undefined {
  if (!verbose) return undefined;
  let counter = 0;
  return (step: AnyStep) => {
    counter++;
    console.log(`\n${D}─── Step ${counter} (${step.stepType ?? "unknown"}) ───${Z}`);
    setLabel(`Step ${counter}`);

    const text = typeof step.text === "string" ? step.text : "";
    const reasoning = typeof step.reasoning === "string" ? step.reasoning : "";
    const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];

    console.log(`${D}│ text:${Z} ${text.length === 0 ? "(empty)" : `${text.length} chars`}`);
    if (text.trim().length > 0) {
      console.log(`${D}│${Z} ${truncate(text.trim(), 800)}`);
    }
    console.log(`${D}│ reasoning:${Z} ${reasoning.length === 0 ? "(none)" : `${reasoning.length} chars`}`);
    if (reasoning.trim().length > 0) {
      console.log(`${D}│${Z} ${truncate(reasoning.trim(), 800)}`);
    }
    console.log(`${D}│ tool calls:${Z} ${toolCalls.length}`);
    for (const tc of toolCalls) {
      const argsStr = JSON.stringify(tc.args ?? {});
      console.log(`${D}│   •${Z} ${tc.toolName ?? "?"}(${truncate(argsStr, 300)})`);
    }
    console.log(`${D}│ tool results:${Z} ${toolResults.length}`);
    for (const tr of toolResults) {
      const raw = tr.result;
      const resultStr = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
      console.log(`${D}│   •${Z} ${tr.toolName ?? "?"}: ${truncate(resultStr, 200)}`);
    }
    console.log(`${D}│ finishReason:${Z} ${step.finishReason ?? "?"}  ${D}│ usage:${Z} ${step.usage?.totalTokens ?? "?"} tokens`);
  };
}

/**
 * Creates an on-step-finished callback for non-verbose (quiet) output.
 *
 * Updates the spinner label with the current tool name or a generic
 * refining message so the user sees progress without the full trace.
 *
 * @param setLabel - Callback to update the spinner / status label.
 * @returns A step callback.
 */
export function quietStepLogger(setLabel: (label: string) => void): (step: AnyStep) => void {
  return (step: AnyStep) => {
    if (Array.isArray(step.toolCalls) && step.toolCalls.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const tc of step.toolCalls as any[]) {
        setLabel(`Calling ${tc.toolName}…`);
      }
    } else {
      setLabel("Refining commit plan…");
    }
  };
}

/**
 * Entry point for the commit-generation flow.
 *
 * Wraps {@link runInternal} with top-level error handling so unhandled
 * rejections are caught, logged, and the process exits cleanly.
 *
 * @param opts - Optional configuration overrides.
 * @param opts.modelOverride - Model name to use instead of the one in
 *   config.
 * @param opts.yes - If ``true``, auto-accept suggestions without
 *   prompting.
 * @param opts.verbose - If ``true``, stream full agent step traces to
 *   stdout.
 */
export async function run(opts?: {
  modelOverride?: string;
  yes?: boolean;
  verbose?: boolean;
}): Promise<void> {
  try {
    await runInternal(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

/**
 * Core execution logic for the commit-generation flow.
 *
 * Orchestrates config loading, API validation, git state pre-fetching,
 * model invocation, output validation/repair, file-coverage checks,
 * interactive revision, and final ``git add`` / ``git commit`` calls.
 *
 * @param opts - Optional configuration overrides.
 * @param opts.modelOverride - Model name override.
 * @param opts.yes - Skip the confirmation prompt.
 * @param opts.verbose - Enable verbose step logging.
 */
async function runInternal(opts?: {
  modelOverride?: string;
  yes?: boolean;
  verbose?: boolean;
}): Promise<void> {
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
  if (status.staged.length === 0 &&
      status.modified.length === 0 &&
      status.deleted.length === 0 &&
      status.created.length === 0 &&
      status.not_added.length === 0 &&
      status.renamed.length === 0) {
    console.log("Nothing to commit. Working tree clean.");
    return;
  }

  if (!opts?.yes && !process.stdin.isTTY) {
    console.error("Error: stdin is not a TTY. Run interactively or pass --yes to bypass the prompt.");
    process.exit(1);
  }

  const context = await precomputeContext(status);
  const knownFiles = allChangedPaths(context.changedFiles);

  const agentsMdContent = await loadAgentsMd();
  const systemContent = SYSTEM_PROMPT + agentsMdContent;

  const provider = createOpenAICompatible({
    name: "zen",
    baseURL: "https://opencode.ai/zen/v1",
    apiKey: config.key,
  });

  const model: LanguageModel = provider(modelName);
  let activeSpinner: SpinnerHandle | null = opts?.verbose ? null : startSpinner("Analyzing changes…");

  if (opts?.verbose) {
    console.log(`${D}─── Verbose agent logs ───${Z}`);
    console.log(`${D}│ system prompt:${Z} ${systemContent.length} chars${agentsMdContent ? " (AGENTS.md appended)" : ""}`);
  }

  const setLabel = (label: string): void => {
    activeSpinner?.update(label);
  };
  const stopActiveSpinner = (): void => {
    if (activeSpinner?.isRunning()) activeSpinner.stop();
  };
  const onStepVerbose = verboseStepLogger(Boolean(opts?.verbose), setLabel);
  const onStepQuiet = opts?.verbose ? undefined : quietStepLogger(setLabel);
  const onStep = opts?.verbose ? onStepVerbose : onStepQuiet;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;

  try {
    result = await generateText({
      model,
      system: systemContent,
      prompt: buildUserPrompt(context),
      tools,
      maxSteps: 3,
      experimental_output: Output.object({ schema: commitSchema }),
      onStepFinish: onStep,
    });
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err) && err.text) {
      setLabel("Repairing malformed output…");
      const repaired = repairJSON(err.text);
      if (repaired) {
        const parsed = commitSchema.safeParse(JSON.parse(repaired));
        if (parsed.success) {
          result = { experimental_output: parsed.data, usage: err.usage, steps: [] };
        }
      }
      if (!result?.experimental_output) {
        setLabel("Retrying with focused feedback…");
        const retryPrompt = [
          buildUserPrompt(context),
          "",
          "---",
          buildFormatRetryFeedback(err.text),
        ].join("\n");
        try {
          result = await generateText({
            model,
            system: systemContent,
            prompt: retryPrompt,
            tools: {},
            maxSteps: 1,
            experimental_output: Output.object({ schema: commitSchema }),
            onStepFinish: onStep,
          });
        } catch (retryErr) {
          stopActiveSpinner();
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error(`Error: failed to parse model output after retry: ${retryMsg}`);
          process.exit(1);
        }
      }
    } else {
      stopActiveSpinner();
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  }

  if (!result.experimental_output) {
    stopActiveSpinner();
    console.error("Error: No commit messages generated.");
    process.exit(1);
  }

  stopActiveSpinner();

  let commits = result.experimental_output.commits as CommitEntry[];

  const filesIssue = validateFileCoverage(
    commits.map((c) => c.files),
    knownFiles,
  );

  if (hasFileIssue(filesIssue)) {
    setLabel("Correcting file coverage…");
    const retryPrompt = [
      buildUserPrompt(context),
      "",
      "---",
      buildFilesRetryFeedback(filesIssue),
    ].join("\n");
    try {
      const retryResult = await generateText({
        model,
        system: systemContent,
        prompt: retryPrompt,
        tools: {},
        maxSteps: 1,
        experimental_output: Output.object({ schema: commitSchema }),
        onStepFinish: onStep,
      });
      if (retryResult.experimental_output) {
        const retryCommits = retryResult.experimental_output.commits as CommitEntry[];
        const retryIssue = validateFileCoverage(
          retryCommits.map((c) => c.files),
          knownFiles,
        );
        if (!hasFileIssue(retryIssue)) {
          commits = retryCommits;
        } else {
          stopActiveSpinner();
          console.error("Error: model could not produce a valid file-coverage set on retry.");
          logFileIssue(retryIssue);
          process.exit(1);
        }
      }
    } catch (err) {
      stopActiveSpinner();
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: file-coverage retry failed: ${message}`);
      process.exit(1);
    }
  }

  stopActiveSpinner();

  if (opts?.verbose) {
    const totalSteps = result.steps?.length ?? 0;
    console.log(`\n${D}─── End first-pass verbose logs (${totalSteps} steps, ${result.usage?.totalTokens ?? "?"} tokens) ───${Z}\n`);
  }

  let revisionCount = 0;

  if (commits.length === 0) {
    stopActiveSpinner();
    console.log("No commits generated.");
    return;
  }

  renderCommits(commits);

  const sigintHandler = (): void => {
    if (activeSpinner?.isRunning()) activeSpinner.stop();
    if (!opts?.verbose) process.stdout.write("\n");
    console.log("Aborted.");
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);

  let acceptAndCommit = !!opts?.yes;

  try {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      while (!acceptAndCommit) {
        const answer = await rl.question("Enter to commit · Ctrl+C to abort · feedback: ");
        const trimmed = answer.trim();
        if (trimmed.length === 0) {
          acceptAndCommit = true;
          break;
        }
        revisionCount++;
        if (opts?.verbose) {
          console.log(`\n${D}─── Revision ${revisionCount} — feedback: ${truncate(trimmed, 200)} ───${Z}`);
        }

        activeSpinner = opts?.verbose ? null : startSpinner(`Refining plan (revision ${revisionCount})…`);
        const iterSetLabel = (label: string): void => {
          activeSpinner?.update(label);
        };
        const iterOnStep = opts?.verbose
          ? verboseStepLogger(true, iterSetLabel)
          : quietStepLogger(iterSetLabel);

        try {
          commits = await runReplan({
            model,
            systemContent,
            context,
            currentCommits: commits,
            feedback: trimmed,
            onStep: iterOnStep,
          });
        } catch (replanErr) {
          stopActiveSpinner();
          rl.close();
          const message = replanErr instanceof Error ? replanErr.message : String(replanErr);
          console.error(`Error: revision failed: ${message}`);
          process.exit(1);
        }
        stopActiveSpinner();
        if (commits.length === 0) {
          rl.close();
          console.log("No commits generated.");
          return;
        }
        renderCommits(commits);
      }
    } finally {
      rl.close();
    }
  } finally {
    process.off("SIGINT", sigintHandler);
  }

  stopActiveSpinner();

  if (opts?.verbose) {
    console.log(`\n${D}─── Committed after ${revisionCount} revision(s) ───${Z}`);
  }

  for (const entry of commits) {
    await git.add(entry.files);
    await git.commit(message(entry));
  }

  console.log(`\n${D}Committed ${commits.length} commit(s).${Z}`);
}

/**
 * Arguments for {@link runReplan}.
 */
interface RunReplanArgs {
  /** Configured language model instance. */
  model: LanguageModel;
  /** System prompt (including AGENTS.md if present). */
  systemContent: string;
  /** Pre-fetched git context. */
  context: PrefetchedContext;
  /** The commit plan before the user's feedback. */
  currentCommits: CommitEntry[];
  /** User's free-text revision feedback. */
  feedback: string;
  /** Optional step-finished callback for logging. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onStep: ((step: any) => void) | undefined;
}

/**
 * Re-plans the commit list based on user feedback.
 *
 * Sends the current plan and feedback back to the model, requesting a
 * revised plan. Includes format-repair logic on model failure.
 *
 * @param args - The re-plan parameters (see {@link RunReplanArgs}).
 * @returns The revised commit entries.
 * @throws {Error} If the model cannot produce a valid plan after retry.
 */
async function runReplan({
  model,
  systemContent,
  context,
  currentCommits,
  feedback,
  onStep,
}: RunReplanArgs): Promise<CommitEntry[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  try {
    result = await generateText({
      model,
      system: systemContent,
      prompt: buildRefocusPrompt(context, currentCommits, feedback),
      tools: {},
      maxSteps: 1,
      experimental_output: Output.object({ schema: commitSchema }),
      onStepFinish: onStep,
    });
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err) && err.text) {
      const repaired = repairJSON(err.text);
      if (repaired) {
        const parsed = commitSchema.safeParse(JSON.parse(repaired));
        if (parsed.success) {
          return parsed.data.commits as CommitEntry[];
        }
      }
      const retryPrompt = [
        buildRefocusPrompt(context, currentCommits, feedback),
        "",
        "---",
        buildFormatRetryFeedback(err.text),
      ].join("\n");
      const retryResult = await generateText({
        model,
        system: systemContent,
        prompt: retryPrompt,
        tools: {},
        maxSteps: 1,
        experimental_output: Output.object({ schema: commitSchema }),
        onStepFinish: onStep,
      });
      if (!retryResult.experimental_output) {
        throw new Error("model could not produce a valid plan on retry", { cause: err });
      }
      return retryResult.experimental_output.commits as CommitEntry[];
    }
    throw err;
  }

  if (!result.experimental_output) {
    throw new Error("no commit messages generated");
  }
  return result.experimental_output.commits as CommitEntry[];
}

export function hasFileIssue(issue: FilesValidationIssue): boolean {
  return issue.missingInCommits.length > 0 ||
    issue.extraInCommits.length > 0 ||
    issue.duplicateFiles.length > 0;
}

/**
 * Logs file-coverage validation issues to stderr.
 *
 * Reports missing files, extra (unchanged) files, and duplicated files
 * with their commit indices.
 *
 * @param issue - The validation issue from
 *   {@link validateFileCoverage}.
 */
export function logFileIssue(issue: FilesValidationIssue): void {
  if (issue.missingInCommits.length > 0) {
    console.error(`  - Missing files: ${issue.missingInCommits.join(", ")}`);
  }
  if (issue.extraInCommits.length > 0) {
    console.error(`  - Extra (unchanged) files: ${issue.extraInCommits.join(", ")}`);
  }
  if (issue.duplicateFiles.length > 0) {
    for (const dup of issue.duplicateFiles) {
      console.error(`  - Duplicate: ${dup.file} appears in commits ${dup.commitIndices.map((i) => i + 1).join(", ")}`);
    }
  }
}
