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
import { createInterface, type Interface } from "node:readline/promises";
import { simpleGit, type SimpleGit } from "simple-git";
import { readConfig } from "./config.js";
import { tools } from "./tools/index.js";
import {
  SYSTEM_PROMPT,
  precomputeContext,
  allChangedPaths,
  loadAgentsMd,
  type PrefetchedContext,
  type ChangedFiles,
} from "./prompt.js";
import {
  repairJSON,
  validateFileCoverage,
  buildFormatRetryFeedback,
  buildFilesRetryFeedback,
  type FilesValidationIssue,
} from "./repair.js";

export class CommitFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitFlowError";
  }
}

const cwd = process.cwd();
let git: SimpleGit = simpleGit(cwd);

/** @internal Replace the git instance for testing. */
export function __setGit(newGit: SimpleGit): SimpleGit {
  const prev = git;
  git = newGit;
  return prev;
}

let generateTextFn = generateText;

/** @internal Replace the generateText function for testing. */
export function __setGenerateText(fn: typeof generateText): typeof generateText {
  const prev = generateTextFn;
  generateTextFn = fn;
  return prev;
}

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
        .nullable()
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
export function buildUserPrompt(context: PrefetchedContext, customPrompt?: string): string {
  const parts: string[] = [];
  if (customPrompt) {
    parts.push(customPrompt, "");
  }
  parts.push(
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
  );
  return parts.join("\n");
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
export function buildRefocusPrompt(context: PrefetchedContext, currentCommits: CommitEntry[], feedback: string, customPrompt?: string): string {
  return [
    buildUserPrompt(context, customPrompt),
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
 * Prints the full commit plan to the terminal with a decorative border.
 *
 * @param commits - The commit entries to render.
 */
export function renderCommits(commits: CommitEntry[]): void {
  const bar = "━".repeat(48);
  console.log(bar);
  for (let i = 0; i < commits.length; i++) {
    console.log(renderCommit(commits[i], i));
  }
  console.log("\n" + bar + "\n");
}

export interface Logger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStep = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStepCallback = ((step: any) => void) | undefined;

/**
 * Validates the API key and model name in config.
 *
 * @returns The resolved model name.
 * @throws {CommitFlowError} If key or model is missing.
 */
export function resolveModel(config: { key?: string; model?: string }, modelOverride?: string): string {
  if (!config.key) {
    throw new CommitFlowError(
      "API key not configured.\nRun: zencommit config set key <your-openode-zen-api-key>",
    );
  }
  const model = modelOverride ?? config.model;
  if (!model) {
    throw new CommitFlowError(
      "Model not configured.\nRun: zencommit config set model <model-name>",
    );
  }
  return model;
}

/**
 * Returns ``true`` when the working tree has at least one change
 * across any category.
 */
export function hasChanges(status: {
  staged: string[];
  modified: string[];
  deleted: string[];
  created: string[];
  not_added: string[];
  renamed: unknown[];
}): boolean {
  return (
    status.staged.length > 0 ||
    status.modified.length > 0 ||
    status.deleted.length > 0 ||
    status.created.length > 0 ||
    status.not_added.length > 0 ||
    status.renamed.length > 0
  );
}

/**
 * Ensures the session is interactive or ``--yes`` was passed.
 *
 * @throws {CommitFlowError} If not TTY and ``--yes`` was not given.
 */
export function ensureTTY(yes: boolean | undefined, isTTY: boolean): void {
  if (!yes && !isTTY) {
    throw new CommitFlowError(
      "stdin is not a TTY. Run interactively or pass --yes to bypass the prompt.",
    );
  }
}

/** Combines the default system prompt with AGENTS.md conventions. */
export function buildSystemContent(agentsMd: string): string {
  return SYSTEM_PROMPT + agentsMd;
}

// ─── generateInitialPlan ────────────────────────────────────────

export interface GenerateInitialPlanArgs {
  model: LanguageModel;
  systemContent: string;
  context: PrefetchedContext;
  promptOverride?: string;
  onStep?: AnyStepCallback;
  onLabel?: (label: string) => void;
  logger: Logger;
}

/**
 * Calls the model to produce an initial commit plan, with format
 * repair and a retry on malformed JSON.
 *
 * @returns The parsed commit entries.
 * @throws {CommitFlowError} If the model fails to produce valid output.
 */
export async function generateInitialPlan(args: GenerateInitialPlanArgs): Promise<CommitEntry[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;

  try {
    result = await generateTextFn({
      model: args.model,
      system: args.systemContent,
      prompt: buildUserPrompt(args.context, args.promptOverride),
      tools,
      maxSteps: 3,
      maxRetries: 4,
      experimental_output: Output.object({ schema: commitSchema }),
      onStepFinish: args.onStep,
    });
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err) && err.text) {
      args.onLabel?.("Repairing malformed output…");
      const repaired = repairJSON(err.text);
      if (repaired) {
        const parsed = commitSchema.safeParse(JSON.parse(repaired));
        if (parsed.success) {
          result = { experimental_output: parsed.data, usage: err.usage, steps: [] };
        }
      }
      if (!result?.experimental_output) {
        args.onLabel?.("Retrying with focused feedback…");
        const retryPrompt = [
          buildUserPrompt(args.context, args.promptOverride),
          "",
          "---",
          buildFormatRetryFeedback(err.text),
        ].join("\n");
        try {
          result = await generateTextFn({
            model: args.model,
            system: args.systemContent,
            prompt: retryPrompt,
            tools: {},
            maxSteps: 1,
            maxRetries: 4,
            experimental_output: Output.object({ schema: commitSchema }),
            onStepFinish: args.onStep,
          });
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new CommitFlowError(`failed to parse model output after retry: ${retryMsg}`);
        }
      }
    } else {
      const message = err instanceof Error ? err.message : String(err);
      throw new CommitFlowError(message);
    }
  }

  if (!result?.experimental_output) {
    throw new CommitFlowError("No commit messages generated.");
  }
  return result.experimental_output.commits as CommitEntry[];
}

// ─── fixFileCoverage ────────────────────────────────────────────

export interface FixFileCoverageArgs {
  model: LanguageModel;
  systemContent: string;
  context: PrefetchedContext;
  commits: CommitEntry[];
  knownFiles: string[];
  promptOverride?: string;
  onStep?: AnyStepCallback;
  onLabel?: (label: string) => void;
  logger: Logger;
}

/**
 * Validates file coverage in the commit plan and retries with the
 * model if coverage is incomplete or incorrect.
 *
 * @returns The validated commit entries (original or retried).
 * @throws {CommitFlowError} If the model cannot produce valid coverage.
 */
export async function fixFileCoverage(args: FixFileCoverageArgs): Promise<CommitEntry[]> {
  let commits = args.commits;

  const filesIssue = validateFileCoverage(
    commits.map((c) => c.files),
    args.knownFiles,
  );

  if (hasFileIssue(filesIssue)) {
    args.onLabel?.("Correcting file coverage…");
    const retryPrompt = [
      buildUserPrompt(args.context, args.promptOverride),
      "",
      "---",
      buildFilesRetryFeedback(filesIssue),
    ].join("\n");
    try {
      const retryResult = await generateTextFn({
        model: args.model,
        system: args.systemContent,
        prompt: retryPrompt,
        tools: {},
        maxSteps: 1,
        maxRetries: 4,
        experimental_output: Output.object({ schema: commitSchema }),
        onStepFinish: args.onStep,
      });
      if (retryResult.experimental_output) {
        const retryCommits = retryResult.experimental_output.commits as CommitEntry[];
        const retryIssue = validateFileCoverage(
          retryCommits.map((c) => c.files),
          args.knownFiles,
        );
        if (!hasFileIssue(retryIssue)) {
          commits = retryCommits;
        } else {
          args.logger.error("Error: model could not produce a valid file-coverage set on retry.");
          logFileIssue(retryIssue);
          throw new CommitFlowError("model could not produce a valid file-coverage set on retry.");
        }
      }
    } catch (err) {
      if (err instanceof CommitFlowError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new CommitFlowError(`file-coverage retry failed: ${message}`);
    }
  }

  return commits;
}

// ─── runInteractiveLoop ─────────────────────────────────────────

export type InteractiveDecision =
  | { action: "accept" }
  | { action: "abort" }
  | { action: "revise"; revisedCommits: CommitEntry[] };

export type AskAndReplan = (
  commits: CommitEntry[],
  revisionCount: number,
) => Promise<InteractiveDecision>;

/**
 * Presents the commit plan to the user, collects feedback, and
 * iterates until the user accepts or aborts.
 *
 * @param initialCommits - The first-pass commit plan.
 * @param opts - Options including the ``--yes`` flag.
 * @param askAndReplan - Callback that prompts the user and optionally
 *   re-plans.
 * @returns The final commit list and revision metadata.
 */
export async function runInteractiveLoop(
  initialCommits: CommitEntry[],
  opts: { yes?: boolean },
  askAndReplan: AskAndReplan,
): Promise<{ commits: CommitEntry[]; aborted: boolean; revisionCount: number }> {
  if (opts.yes) {
    return { commits: initialCommits, aborted: false, revisionCount: 0 };
  }

  let commits = initialCommits;
  let revisionCount = 0;

  while (true) {
    renderCommits(commits);

    const decision = await askAndReplan(commits, revisionCount);
    if (decision.action === "accept") {
      return { commits, aborted: false, revisionCount };
    }
    if (decision.action === "abort") {
      return { commits, aborted: true, revisionCount };
    }
    commits = decision.revisedCommits;
    revisionCount++;
  }
}

// ─── executeCommits ─────────────────────────────────────────────

/**
 * Stages and commits each entry via git.
 *
 * @param git_ - The simple-git instance.
 * @param commits - The commit entries to execute.
 * @param logger - Logger for output.
 */
export async function executeCommits(git_: SimpleGit, commits: CommitEntry[], logger: Logger): Promise<void> {
  for (const entry of commits) {
    await git_.add(entry.files);
    await git_.commit(message(entry));
  }
  logger.log(`\n${D}Committed ${commits.length} commit(s).${Z}`);
}

// ─── buildAskAndReplan ──────────────────────────────────────────

/**
 * Builds an {@link AskAndReplan} callback wired to a real readline
 * interface and the model re-plan logic.
 *
 * @param rl - The readline interface.
 * @param model - Language model instance.
 * @param systemContent - Combined system prompt.
 * @param context - Pre-fetched git context.
 * @param opts - CLI options.
 * @param onStep - Step-finished callback.
 * @param setLabel - Status-label updater.
 * @param logger - Logger.
 * @returns An {@link AskAndReplan} callback.
 */
export function buildAskAndReplan(
  rl: Interface,
  model: LanguageModel,
  systemContent: string,
  context: PrefetchedContext,
  opts: { verbose?: boolean; promptOverride?: string },
  onStep: AnyStepCallback,
  setLabel: (label: string) => void,
  logger: Logger,
): AskAndReplan {
  return async (commits: CommitEntry[], revisionCount: number): Promise<InteractiveDecision> => {
    try {
      const answer = await rl.question("Enter to commit · Ctrl+C to abort · feedback: ");
      const trimmed = answer.trim();
      if (trimmed.length === 0) return { action: "accept" };

      const newCount = revisionCount + 1;
      if (opts.verbose) {
        logger.log(`\n${D}─── Revision ${newCount} — feedback: ${truncate(trimmed, 200)} ───${Z}`);
      }

      const spinner = opts.verbose ? null : startSpinner(`Refining plan (revision ${newCount})…`);
      const iterSetLabel = (l: string) => spinner?.update(l);
      const iterOnStep: AnyStepCallback = opts.verbose
        ? verboseStepLogger(true, iterSetLabel)
        : quietStepLogger(iterSetLabel);

      try {
        const revisedCommits = await runReplan({
          model,
          systemContent,
          context,
          currentCommits: commits,
          feedback: trimmed,
          onStep: iterOnStep,
          promptOverride: opts.promptOverride,
        });
        return { action: "revise", revisedCommits };
      } finally {
        if (spinner?.isRunning()) spinner.stop();
      }
    } catch (err) {
      if (err instanceof CommitFlowError) throw err;
      return { action: "abort" };
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
/* istanbul ignore next */
export async function run(opts?: {
  modelOverride?: string;
  yes?: boolean;
  verbose?: boolean;
  promptOverride?: string;
}): Promise<void> {
  try {
    await runInternal(opts);
  } catch (err) {
    if (err instanceof CommitFlowError) {
      console.error(`Error: ${err.message}`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
    }
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
/* istanbul ignore next */
async function runInternal(opts?: {
  modelOverride?: string;
  yes?: boolean;
  verbose?: boolean;
  promptOverride?: string;
}): Promise<void> {
  const config = await readConfig();
  const modelName = resolveModel(config, opts?.modelOverride);

  const status = await git.status();
  if (!hasChanges(status)) {
    console.log("Nothing to commit. Working tree clean.");
    return;
  }

  ensureTTY(opts?.yes, process.stdin.isTTY);

  const context = await precomputeContext(status);
  const knownFiles = allChangedPaths(context.changedFiles);
  const agentsMd = await loadAgentsMd();
  const systemContent = buildSystemContent(agentsMd);

  const provider = createOpenAICompatible({
    name: "zen",
    baseURL: "https://opencode.ai/zen/v1",
    apiKey: config.key,
  });
  const model: LanguageModel = provider(modelName);

  const spinner: SpinnerHandle | null = opts?.verbose ? null : startSpinner("Analyzing changes…");
  const setLabel = (label: string) => spinner?.update(label);
  const stopSpinner = () => { if (spinner?.isRunning()) spinner.stop(); };
  const onStepVerbose = verboseStepLogger(Boolean(opts?.verbose), setLabel);
  const onStepQuiet = opts?.verbose ? undefined : quietStepLogger(setLabel);
  const onStep: AnyStepCallback = opts?.verbose ? onStepVerbose : onStepQuiet;

  if (opts?.verbose) {
    console.log(`${D}─── Verbose agent logs ───${Z}`);
    console.log(`${D}│ system prompt:${Z} ${systemContent.length} chars${agentsMd ? " (AGENTS.md appended)" : ""}`);
  }

  let commits = await generateInitialPlan({
    model,
    systemContent,
    context,
    promptOverride: opts?.promptOverride,
    onStep,
    onLabel: setLabel,
    logger: console,
  });

  commits = await fixFileCoverage({
    model,
    systemContent,
    context,
    commits,
    knownFiles,
    promptOverride: opts?.promptOverride,
    onStep,
    onLabel: setLabel,
    logger: console,
  });

  stopSpinner();

  if (opts?.verbose) {
    console.log(`\n${D}─── End first-pass verbose logs ───${Z}\n`);
  }

  if (commits.length === 0) {
    console.log("No commits generated.");
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const onSigint = () => rl.close();
  process.on("SIGINT", onSigint);

  try {
    const { commits: finalCommits, aborted, revisionCount } = await runInteractiveLoop(
      commits,
      { yes: !!opts?.yes },
      buildAskAndReplan(rl, model, systemContent, context, { verbose: opts?.verbose, promptOverride: opts?.promptOverride }, onStep, setLabel, console),
    );

    if (aborted) {
      console.log("Aborted.");
      return;
    }

    if (opts?.verbose) {
      console.log(`\n${D}─── Committed after ${revisionCount} revision(s) ───${Z}`);
    }

    await executeCommits(git, finalCommits, console);
  } finally {
    rl.close();
    process.off("SIGINT", onSigint);
  }
}

/**
 * Arguments for {@link runReplan}.
 */
export interface RunReplanArgs {
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
  onStep: AnyStepCallback;
  /** Custom user instruction prepended to the prompt. */
  promptOverride?: string;
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
export async function runReplan({
  model,
  systemContent,
  context,
  currentCommits,
  feedback,
  onStep,
  promptOverride,
}: RunReplanArgs): Promise<CommitEntry[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  try {
    result = await generateTextFn({
      model,
      system: systemContent,
      prompt: buildRefocusPrompt(context, currentCommits, feedback, promptOverride),
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
        buildRefocusPrompt(context, currentCommits, feedback, promptOverride),
        "",
        "---",
        buildFormatRetryFeedback(err.text),
      ].join("\n");
      const retryResult = await generateTextFn({
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

// ─── Stats infrastructure ─────────────────────────────────────────

export interface ToolCallRecord {
  toolName: string;
  args: unknown;
}

export interface ToolResultRecord {
  toolName: string;
  result: unknown;
}

export interface StepRecord {
  stepIndex: number;
  stepType?: string;
  text?: string;
  reasoning?: string;
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason?: string;
}

export interface CallRecord {
  phase: string;
  attemptIndex: number;
  wallMs: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason?: string;
  warnings?: unknown[];
  text?: string;
  reasoning?: string;
  steps: StepRecord[];
  error?: { message: string; code?: string };
}

export interface StatsReport {
  schemaVersion: 1;
  ok: boolean;
  model: string;
  generatedAt: string;
  workdir: string;
  context: {
    systemPromptChars: number;
    userPromptChars: number;
    changedFiles: ChangedFiles;
    allChangedPaths: string[];
    diffSections: { path: string; diff: string; truncated: boolean; omitted?: boolean }[];
    diffCapHit: boolean;
  } | null;
  calls: CallRecord[];
  metrics: { totalMs: number };
  result:
    | {
        schemaValid: true;
        coverageValid: true;
        formatRepairs: number;
        coverageRetries: number;
        commits: CommitEntry[];
      }
    | {
        error: { phase: string; message: string; rawOutput?: string };
      };
}

/**
 * Collects per-call stats during a stats-mode run.
 */
export class StatsCollector {
  readonly startTime = Date.now();
  readonly calls: CallRecord[] = [];
  private callCount = 0;
  private currentPhase = "initial";

  setPhase(phase: string): void {
    this.currentPhase = phase;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrap(fn: typeof generateText): any {
    return async (args: unknown) => {
      const phase = this.currentPhase;
      const attemptIndex = this.callCount;
      this.callCount++;

      const callStart = Date.now();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await (fn as any)(args);
        const wallMs = Date.now() - callStart;

        const callRecord: CallRecord = {
          phase,
          attemptIndex,
          wallMs,
          usage: result.usage
            ? {
                promptTokens: result.usage.promptTokens as number,
                completionTokens: result.usage.completionTokens as number,
                totalTokens: result.usage.totalTokens as number,
              }
            : undefined,
          finishReason: result.finishReason as string | undefined,
          warnings: result.warnings as unknown[] | undefined,
          text: result.text as string | undefined,
          reasoning: result.reasoning as string | undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          steps: ((result.steps ?? []) as any[]).map((step: any, i: number) => ({
            stepIndex: i,
            stepType: step.stepType as string | undefined,
            text: step.text as string | undefined,
            reasoning: step.reasoning as string | undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            toolCalls: ((step.toolCalls ?? []) as any[]).map((tc: any) => ({
              toolName: tc.toolName as string,
              args: tc.args,
            })),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            toolResults: ((step.toolResults ?? []) as any[]).map((tr: any) => ({
              toolName: tr.toolName as string,
              result: tr.result,
            })),
            usage: step.usage
              ? {
                  promptTokens: (step.usage as { promptTokens: number }).promptTokens,
                  completionTokens: (step.usage as { completionTokens: number }).completionTokens,
                  totalTokens: (step.usage as { totalTokens: number }).totalTokens,
                }
              : undefined,
            finishReason: step.finishReason as string | undefined,
          })),
        };

        this.calls.push(callRecord);
        return result;
      } catch (err) {
        const wallMs = Date.now() - callStart;
        const callRecord: CallRecord = {
          phase,
          attemptIndex,
          wallMs,
          steps: [],
          error: {
            message: err instanceof Error ? err.message : String(err),
          },
        };

        if (NoObjectGeneratedError.isInstance(err)) {
          callRecord.text = err.text;
          callRecord.usage = err.usage
            ? {
                promptTokens: err.usage.promptTokens,
                completionTokens: err.usage.completionTokens,
                totalTokens: err.usage.totalTokens,
              }
            : undefined;
        }

        this.calls.push(callRecord);
        throw err;
      }
    };
  }
}

// ─── runStats ─────────────────────────────────────────────────────

/* istanbul ignore next */
export async function runStats(opts?: {
  modelOverride?: string;
  promptOverride?: string;
}): Promise<void> {
  try {
    const config = await readConfig();
    const modelName = resolveModel(config, opts?.modelOverride);

    const status = await git.status();
    if (!hasChanges(status)) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        ok: false,
        model: modelName,
        generatedAt: new Date().toISOString(),
        workdir: cwd,
        context: null,
        calls: [],
        metrics: { totalMs: 0 },
        result: { error: { phase: "precheck", message: "Nothing to commit. Working tree clean." } },
      } satisfies StatsReport, null, 2));
      return;
    }

    const context = await precomputeContext(status);
    const knownFiles = allChangedPaths(context.changedFiles);
    const agentsMd = await loadAgentsMd();
    const systemContent = buildSystemContent(agentsMd);
    const userPrompt = buildUserPrompt(context, opts?.promptOverride);

    const provider = createOpenAICompatible({
      name: "zen",
      baseURL: "https://opencode.ai/zen/v1",
      apiKey: config.key,
    });

    const model: LanguageModel = provider(modelName);
    const collector = new StatsCollector();
    const prevFn = __setGenerateText(collector.wrap(generateTextFn));

    let formatRepairs = 0;
    let coverageRetries = 0;

    try {
      collector.setPhase("initial");
      const initialCommits = await generateInitialPlan({
        model,
        systemContent,
        context,
        promptOverride: opts?.promptOverride,
        onStep: undefined,
        onLabel: () => {},
        logger: { log() {}, error() {} },
      });

      if (collector.calls.length > 1) {
        formatRepairs = 1;
      }

      collector.setPhase("coverage-retry");
      const finalCommits = await fixFileCoverage({
        model,
        systemContent,
        context,
        commits: initialCommits,
        knownFiles,
        promptOverride: opts?.promptOverride,
        onStep: undefined,
        onLabel: () => {},
        logger: { log() {}, error() {} },
      });

      if (collector.calls.length > 1 + formatRepairs) {
        coverageRetries = 1;
      }

      const elapsed = Date.now() - collector.startTime;

      console.log(JSON.stringify({
        schemaVersion: 1,
        ok: true,
        model: modelName,
        generatedAt: new Date().toISOString(),
        workdir: cwd,
        context: {
          systemPromptChars: systemContent.length,
          userPromptChars: userPrompt.length,
          changedFiles: context.changedFiles,
          allChangedPaths: knownFiles,
          diffSections: context.diffSections.map((ds) => ({
            path: ds.path,
            diff: ds.diff,
            truncated: ds.truncated,
            omitted: ds.omitted,
          })),
          diffCapHit: context.diffCapHit,
        },
        calls: collector.calls,
        metrics: { totalMs: elapsed },
        result: {
          schemaValid: true,
          coverageValid: true,
          formatRepairs,
          coverageRetries,
          commits: finalCommits,
        },
      } satisfies StatsReport, null, 2));
    } catch (err) {
      const elapsed = Date.now() - collector.startTime;
      const message = err instanceof Error ? err.message : String(err);

      const rawOutput = err instanceof NoObjectGeneratedError
        ? err.text
        : undefined;

      console.log(JSON.stringify({
        schemaVersion: 1,
        ok: false,
        model: modelName,
        generatedAt: new Date().toISOString(),
        workdir: cwd,
        context: {
          systemPromptChars: systemContent.length,
          userPromptChars: userPrompt.length,
          changedFiles: context.changedFiles,
          allChangedPaths: knownFiles,
          diffSections: context.diffSections.map((ds) => ({
            path: ds.path,
            diff: ds.diff,
            truncated: ds.truncated,
            omitted: ds.omitted,
          })),
          diffCapHit: context.diffCapHit,
        },
        calls: collector.calls,
        metrics: { totalMs: elapsed },
        result: {
          error: { phase: "model-failure", message, rawOutput },
        },
      } satisfies StatsReport, null, 2));
    } finally {
      __setGenerateText(prevFn);
    }
  } catch (err) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      ok: false,
      model: "unknown",
      generatedAt: new Date().toISOString(),
      workdir: cwd,
      context: null,
      calls: [],
      metrics: { totalMs: 0 },
      result: {
        error: { phase: "fatal", message: err instanceof Error ? err.message : String(err) },
      },
    } satisfies StatsReport, null, 2));
  }
}
