import { describe, it, expect, jest, beforeEach, afterEach, afterAll } from "@jest/globals";
import { NoObjectGeneratedError } from "ai";
import {
  header,
  message,
  renderCommit,
  commitsAsJson,
  buildUserPrompt,
  buildRefocusPrompt,
  hasFileIssue,
  truncate,
  startSpinner,
  verboseStepLogger,
  quietStepLogger,
  logFileIssue,
  commitSchema,
  CommitFlowError,
  resolveModel,
  hasChanges,
  ensureTTY,
  generateInitialPlan,
  runReplan,
  fixFileCoverage,
  runInteractiveLoop,
  executeCommits,
  __setGenerateText,
  type GenerateInitialPlanArgs,
  type FixFileCoverageArgs,
  type CommitEntry,
  type PrefetchedContext,
} from "./zencommit.js";

const ansiPattern = new RegExp(
  String.fromCharCode(27) + "\\[[0-9;]*m", "g",
);
function stripAnsi(s: string): string {
  return s.replace(ansiPattern, "");
}

const mockCommit: CommitEntry = {
  type: "feat",
  scope: "api",
  description: "add user endpoint",
  files: ["src/api.ts", "src/api.test.ts"],
};

const mockCommitNoScope: CommitEntry = {
  type: "fix",
  description: "fix login bug",
  files: ["src/login.ts"],
};

function mockContext(overrides?: Partial<PrefetchedContext>): PrefetchedContext {
  return {
    changedFiles: {
      staged: ["a.ts"],
      modified: [],
      deleted: [],
      created: [],
      untracked: [],
      renamed: [],
    },
    allChangedPaths: ["a.ts"],
    diffSections: [{ path: "a.ts", diff: "+1", truncated: false }],
    diffCapHit: false,
    formatted: { files: "Staged:\n  a.ts", diffs: "--- a.ts ---\n+1" },
    ...overrides,
  } as PrefetchedContext;
}

describe("header", () => {
  it("formats with scope", () => {
    const result = stripAnsi(header(mockCommit));
    expect(result).toBe("feat(api): add user endpoint");
  });

  it("formats without scope", () => {
    const result = stripAnsi(header(mockCommitNoScope));
    expect(result).toBe("fix: fix login bug");
  });

  it("handles unknown type color gracefully", () => {
    const weird = { ...mockCommit, type: "unknown" };
    const result = stripAnsi(header(weird));
    expect(result).toBe("unknown(api): add user endpoint");
  });
});

describe("message", () => {
  it("formats with scope", () => {
    expect(message(mockCommit)).toBe("feat(api): add user endpoint");
  });

  it("formats without scope", () => {
    expect(message(mockCommitNoScope)).toBe("fix: fix login bug");
  });
});

describe("renderCommit", () => {
  it("shows 1-based index", () => {
    const output = stripAnsi(renderCommit(mockCommit, 0));
    expect(output).toContain(" 1.");
  });

  it("shows scope in header", () => {
    const output = stripAnsi(renderCommit(mockCommit, 0));
    expect(output).toContain("feat(api): add user endpoint");
  });

  it("lists files with bullets", () => {
    const output = stripAnsi(renderCommit(mockCommit, 0));
    expect(output).toContain("src/api.ts");
    expect(output).toContain("src/api.test.ts");
  });
});

describe("commitsAsJson", () => {
  it("serializes to {commits: [...]} shape", () => {
    const json = JSON.parse(commitsAsJson([mockCommit]));
    expect(json).toHaveProperty("commits");
    expect(Array.isArray(json.commits)).toBe(true);
    expect(json.commits).toHaveLength(1);
  });

  it("pretty-prints with indentation", () => {
    const output = commitsAsJson([mockCommit]);
    expect(output).toContain("\n  ");
  });

  it("handles empty array", () => {
    expect(commitsAsJson([])).toBe('{\n  "commits": []\n}');
  });
});

describe("buildUserPrompt", () => {
  it("includes changed_files tag", () => {
    const ctx = mockContext();
    expect(buildUserPrompt(ctx)).toContain("<changed_files>");
    expect(buildUserPrompt(ctx)).toContain("</changed_files>");
  });

  it("includes diffs tag", () => {
    const ctx = mockContext();
    expect(buildUserPrompt(ctx)).toContain("<diffs>");
    expect(buildUserPrompt(ctx)).toContain("</diffs>");
  });

  it("includes formatted content", () => {
    const ctx = mockContext();
    const prompt = buildUserPrompt(ctx);
    expect(prompt).toContain(ctx.formatted.files);
    expect(prompt).toContain(ctx.formatted.diffs);
  });

  it("prepends custom prompt when provided", () => {
    const ctx = mockContext();
    const prompt = buildUserPrompt(ctx, "Focus on breaking changes only.");
    expect(prompt.startsWith("Focus on breaking changes only.")).toBe(true);
    expect(prompt).toContain("<changed_files>");
  });

  it("does not add extra blank lines when custom prompt is empty", () => {
    const ctx = mockContext();
    const prompt = buildUserPrompt(ctx, "");
    expect(prompt.startsWith("<changed_files>")).toBe(true);
  });
});

describe("buildRefocusPrompt", () => {
  it("includes previous_plan tag", () => {
    const ctx = mockContext();
    const prompt = buildRefocusPrompt(ctx, [mockCommit], "feedback");
    expect(prompt).toContain("<previous_plan>");
    expect(prompt).toContain("</previous_plan>");
  });

  it("includes feedback tag and content", () => {
    const ctx = mockContext();
    const prompt = buildRefocusPrompt(ctx, [mockCommit], "merge these");
    expect(prompt).toContain("<feedback>");
    expect(prompt).toContain("merge these");
    expect(prompt).toContain("</feedback>");
  });

  it("prepends custom prompt when provided", () => {
    const ctx = mockContext();
    const prompt = buildRefocusPrompt(ctx, [mockCommit], "merge these", "Use angular convention.");
    expect(prompt.startsWith("Use angular convention.")).toBe(true);
    expect(prompt).toContain("<feedback>");
  });
});

describe("hasFileIssue", () => {
  it("returns false when no issues", () => {
    expect(hasFileIssue({
      missingInCommits: [],
      extraInCommits: [],
      duplicateFiles: [],
    })).toBe(false);
  });

  it("returns true when files are missing", () => {
    expect(hasFileIssue({
      missingInCommits: ["a.ts"],
      extraInCommits: [],
      duplicateFiles: [],
    })).toBe(true);
  });

  it("returns true when files are extra", () => {
    expect(hasFileIssue({
      missingInCommits: [],
      extraInCommits: ["x.ts"],
      duplicateFiles: [],
    })).toBe(true);
  });

  it("returns true when files are duplicated", () => {
    expect(hasFileIssue({
      missingInCommits: [],
      extraInCommits: [],
      duplicateFiles: [{ file: "a.ts", commitIndices: [0, 1] }],
    })).toBe(true);
  });
});

describe("truncate", () => {
  it("returns the string unchanged when under max", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns the string unchanged when at max exactly", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and appends marker when over max", () => {
    const result = truncate("hello world", 5);
    expect(result).toBe("hello…(truncated)");
  });
});

describe("startSpinner", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("returns a handle with update, stop, and isRunning", () => {
    const spinner = startSpinner("loading…");
    expect(spinner).toHaveProperty("update");
    expect(spinner).toHaveProperty("stop");
    expect(spinner).toHaveProperty("isRunning");
    spinner.stop();
  });

  it("is running after creation", () => {
    const spinner = startSpinner("test");
    expect(spinner.isRunning()).toBe(true);
    spinner.stop();
  });

  it("is not running after stop", () => {
    const spinner = startSpinner("test");
    spinner.stop();
    expect(spinner.isRunning()).toBe(false);
  });

  it("writes to stdout on tick", () => {
    const spinner = startSpinner("test");
    jest.advanceTimersByTime(160);
    expect(process.stdout.write).toHaveBeenCalled();
    const writeMock = process.stdout.write as jest.Mock;
    expect(writeMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    spinner.stop();
  });

  it("update changes the displayed message", () => {
    const spinner = startSpinner("initial");
    spinner.update("updated");
    jest.advanceTimersByTime(80);
    const writeMock = process.stdout.write as jest.Mock;
    const lastCall = writeMock.mock.calls[writeMock.mock.calls.length - 1][0] as string;
    expect(lastCall).toContain("updated");
    spinner.stop();
  });
});

describe("verboseStepLogger", () => {
  it("returns undefined when verbose is false", () => {
    const setLabel = jest.fn();
    const logger = verboseStepLogger(false, setLabel);
    expect(logger).toBeUndefined();
  });

  it("returns a function when verbose is true", () => {
    const setLabel = jest.fn();
    const logger = verboseStepLogger(true, setLabel);
    expect(typeof logger).toBe("function");
  });

  it("logs step with basic fields", () => {
    const setLabel = jest.fn();
    const logger = verboseStepLogger(true, setLabel)!;

    const spy = jest.spyOn(console, "log").mockImplementation(() => {});

    logger({
      stepType: "initial",
      text: "thinking",
      reasoning: "because",
      toolCalls: [{ toolName: "readFile", args: { path: "x.ts" } }],
      toolResults: [{ toolName: "readFile", result: "content" }],
      finishReason: "stop",
      usage: { totalTokens: 50 },
    });

    expect(spy).toHaveBeenCalled();
    expect(setLabel).toHaveBeenCalledWith("Step 1");
    spy.mockRestore();
  });
});

describe("quietStepLogger", () => {
  it("updates label with tool name when tool calls exist", () => {
    const setLabel = jest.fn();
    const logger = quietStepLogger(setLabel);

    logger({ toolCalls: [{ toolName: "gitDiff", args: {} }] });

    expect(setLabel).toHaveBeenCalledWith("Calling gitDiff…");
  });

  it("updates label with generic message when no tool calls", () => {
    const setLabel = jest.fn();
    const logger = quietStepLogger(setLabel);

    logger({ toolCalls: undefined });

    expect(setLabel).toHaveBeenCalledWith("Refining commit plan…");
  });

  it("handles empty tool calls array", () => {
    const setLabel = jest.fn();
    const logger = quietStepLogger(setLabel);

    logger({ toolCalls: [] });

    expect(setLabel).toHaveBeenCalledWith("Refining commit plan…");
  });
});

describe("logFileIssue", () => {
  it("logs missing files to console.error", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    logFileIssue({
      missingInCommits: ["a.ts", "b.ts"],
      extraInCommits: [],
      duplicateFiles: [],
    });

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("a.ts"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("b.ts"));
    spy.mockRestore();
  });

  it("logs extra files to console.error", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    logFileIssue({
      missingInCommits: [],
      extraInCommits: ["x.ts"],
      duplicateFiles: [],
    });

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("x.ts"));
    spy.mockRestore();
  });

  it("logs duplicates with commit numbers", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    logFileIssue({
      missingInCommits: [],
      extraInCommits: [],
      duplicateFiles: [{ file: "b.ts", commitIndices: [0, 2] }],
    });

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("b.ts"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("1, 3"));
    spy.mockRestore();
  });

  it("does nothing for empty issue", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    logFileIssue({
      missingInCommits: [],
      extraInCommits: [],
      duplicateFiles: [],
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("commitSchema", () => {
  it("validates a correct commit entry", () => {
    const data = {
      commits: [
        { type: "feat", description: "add feature", files: ["a.ts"] },
      ],
    };
    const result = commitSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid commit type", () => {
    const data = {
      commits: [
        { type: "invalid", description: "bad", files: ["a.ts"] },
      ],
    };
    const result = commitSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects commits without files", () => {
    const data = {
      commits: [
        { type: "feat", description: "no files" },
      ],
    };
    const result = commitSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects commits with empty files array", () => {
    const data = {
      commits: [
        { type: "fix", description: "empty", files: [] },
      ],
    };
    const result = commitSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects commits without description", () => {
    const data = {
      commits: [
        { type: "feat", files: ["a.ts"] },
      ],
    };
    const result = commitSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("accepts scope as optional", () => {
    const data = {
      commits: [
        { type: "feat", scope: "api", description: "with scope", files: ["a.ts"] },
        { type: "fix", description: "without scope", files: ["b.ts"] },
      ],
    };
    const result = commitSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("validates multiple commits in a single array", () => {
    const data = {
      commits: [
        { type: "feat", description: "first", files: ["a.ts"] },
        { type: "fix", description: "second", files: ["b.ts"] },
        { type: "docs", description: "third", files: ["c.ts"] },
      ],
    };
    const result = commitSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

// ─── CommitFlowError ────────────────────────────────────────────

describe("CommitFlowError", () => {
  it("has the correct name", () => {
    const err = new CommitFlowError("test");
    expect(err.name).toBe("CommitFlowError");
  });

  it("stores the message", () => {
    const err = new CommitFlowError("something broke");
    expect(err.message).toBe("something broke");
  });
});

// ─── resolveModel ───────────────────────────────────────────────

describe("resolveModel", () => {
  it("throws when API key is missing", () => {
    expect(() => resolveModel({ key: "", model: "gpt-4" }))
      .toThrow(CommitFlowError);
  });

  it("throws when model is missing", () => {
    expect(() => resolveModel({ key: "sk-123", model: "" }))
      .toThrow(CommitFlowError);
  });

  it("throws when both are missing", () => {
    expect(() => resolveModel({ key: "", model: "" }))
      .toThrow(CommitFlowError);
  });

  it("returns the resolved model details when both are present", () => {
    const result = resolveModel({ key: "sk-123", model: "gpt-4" });
    expect(result.modelName).toBe("gpt-4");
    expect(result.variant).toBe("default");
  });

  it("returns the override when provided", () => {
    const result = resolveModel({ key: "sk-123", model: "gpt-4" }, "claude-3");
    expect(result.modelName).toBe("claude-3");
    expect(result.variant).toBe("default");
  });

  it("throws when override is empty string (treated as no model)", () => {
    expect(() => resolveModel({ key: "sk-123", model: "gpt-4" }, ""))
      .toThrow(CommitFlowError);
  });

  it("parses model variants when metadata is present", () => {
    const metaMap = new Map([
      [
        "deepseek-v4-flash",
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          family: "deepseek-flash",
          reasoning: true,
          reasoningOptions: [{ type: "toggle" as const }, { type: "effort" as const, values: ["high", "max"] }],
          variants: ["off", "high", "max"],
          defaultVariant: "off",
          cost: { input: 0.14, output: 0.28 },
        },
      ],
    ]);

    const defaultRes = resolveModel({ key: "sk-123", model: "deepseek-v4-flash" }, undefined, metaMap);
    expect(defaultRes.modelName).toBe("deepseek-v4-flash");
    expect(defaultRes.variant).toBe("off");
    expect(defaultRes.providerOptions).toEqual({ thinking: { type: "disabled" } });

    const highRes = resolveModel({ key: "sk-123", model: "deepseek-v4-flash:high" }, undefined, metaMap);
    expect(highRes.modelName).toBe("deepseek-v4-flash");
    expect(highRes.variant).toBe("high");
    expect(highRes.providerOptions).toEqual({ thinking: { type: "enabled" }, reasoningEffort: "high" });
  });

  it("throws CommitFlowError on invalid variant", () => {
    const metaMap = new Map([
      [
        "deepseek-v4-flash",
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          family: "deepseek-flash",
          reasoning: true,
          reasoningOptions: [{ type: "toggle" as const }],
          variants: ["off", "on"],
          defaultVariant: "off",
          cost: { input: 0.14, output: 0.28 },
        },
      ],
    ]);

    expect(() => resolveModel({ key: "sk-123", model: "deepseek-v4-flash:invalid" }, undefined, metaMap))
      .toThrow(CommitFlowError);
  });
});

// ─── hasChanges ─────────────────────────────────────────────────

describe("hasChanges", () => {
  const empty = { staged: [], modified: [], deleted: [], created: [], not_added: [], renamed: [] };

  it("returns false when all categories are empty", () => {
    expect(hasChanges(empty)).toBe(false);
  });

  it("returns true when staged is nonempty", () => {
    expect(hasChanges({ ...empty, staged: ["a.ts"] })).toBe(true);
  });

  it("returns true when modified is nonempty", () => {
    expect(hasChanges({ ...empty, modified: ["b.ts"] })).toBe(true);
  });

  it("returns true when deleted is nonempty", () => {
    expect(hasChanges({ ...empty, deleted: ["c.ts"] })).toBe(true);
  });

  it("returns true when created is nonempty", () => {
    expect(hasChanges({ ...empty, created: ["d.ts"] })).toBe(true);
  });

  it("returns true when not_added is nonempty", () => {
    expect(hasChanges({ ...empty, not_added: ["e.ts"] })).toBe(true);
  });

  it("returns true when renamed is nonempty", () => {
    expect(hasChanges({ ...empty, renamed: [{ from: "old", to: "new" }] })).toBe(true);
  });
});

// ─── ensureTTY ──────────────────────────────────────────────────

describe("ensureTTY", () => {
  it("throws when not TTY and no --yes", () => {
    expect(() => ensureTTY(false, false)).toThrow(CommitFlowError);
  });

  it("passes when not TTY but --yes is set", () => {
    expect(() => ensureTTY(true, false)).not.toThrow();
  });

  it("passes when TTY and no --yes", () => {
    expect(() => ensureTTY(false, true)).not.toThrow();
  });

  it("passes when TTY and --yes is set", () => {
    expect(() => ensureTTY(true, true)).not.toThrow();
  });

  it("treats undefined yes as false (no --yes)", () => {
    expect(() => ensureTTY(undefined, false)).toThrow(CommitFlowError);
  });
});

// ─── generateInitialPlan + runReplan (shared mock) ──────────────

const mockGenerateText = jest.fn<(...args: unknown[]) => unknown>();

let prevGenerateText: ReturnType<typeof __setGenerateText>;

beforeEach(() => {
  prevGenerateText = __setGenerateText(mockGenerateText as never);
  mockGenerateText.mockReset();
});

afterAll(() => {
  __setGenerateText(prevGenerateText);
});

const sampleCommits = [{ type: "feat" as const, description: "add stuff", files: ["a.ts"] }];

function makeGenerateResult(overrides?: Record<string, unknown>) {
  return {
    experimental_output: { commits: sampleCommits },
    usage: { totalTokens: 10 },
    steps: [],
    ...overrides,
  };
}

const basePlanArgs: GenerateInitialPlanArgs = {
  model: {} as never,
  systemContent: "system prompt",
  context: {
    changedFiles: { staged: ["a.ts"], modified: [], deleted: [], created: [], untracked: [], renamed: [] },
    allChangedPaths: ["a.ts"],
    diffSections: [{ path: "a.ts", diff: "+1", truncated: false }],
    diffCapHit: false,
    formatted: { files: "a.ts", diffs: "+1" },
  },
  onStep: undefined,
  onLabel: jest.fn(),
  logger: { log: jest.fn(), error: jest.fn() },
};

describe("generateInitialPlan", () => {
  it("returns commits on success", async () => {
    mockGenerateText.mockResolvedValue(makeGenerateResult());
    const commits = await generateInitialPlan(basePlanArgs);
    expect(commits).toEqual(sampleCommits);
  });

  it("repairs malformed output via NoObjectGeneratedError", async () => {
    const validJson = JSON.stringify({ commits: sampleCommits });
    mockGenerateText.mockRejectedValue(
      new NoObjectGeneratedError({ text: validJson, usage: { totalTokens: 5 } }),
    );
    const commits = await generateInitialPlan(basePlanArgs);
    expect(commits).toEqual(sampleCommits);
  });

  it("retries when repair fails and retry succeeds", async () => {
    const malformed = '{ "commits": [ broken }';
    mockGenerateText
      .mockRejectedValueOnce(new NoObjectGeneratedError({ text: malformed, usage: { totalTokens: 5 } }))
      .mockResolvedValueOnce(makeGenerateResult());
    const commits = await generateInitialPlan(basePlanArgs);
    expect(commits).toEqual(sampleCommits);
  });

  it("throws when both repair and retry fail", async () => {
    const malformed = '{ "commits": [ broken }';
    mockGenerateText
      .mockRejectedValueOnce(new NoObjectGeneratedError({ text: malformed, usage: { totalTokens: 5 } }))
      .mockRejectedValueOnce(new Error("retry also failed"));
    await expect(generateInitialPlan(basePlanArgs)).rejects.toThrow(CommitFlowError);
  });

  it("throws on non-NoObjectGeneratedError", async () => {
    mockGenerateText.mockRejectedValue(new Error("network failure"));
    await expect(generateInitialPlan(basePlanArgs)).rejects.toThrow(CommitFlowError);
  });

  it("throws when experimental_output is null", async () => {
    mockGenerateText.mockResolvedValue({ experimental_output: null });
    await expect(generateInitialPlan(basePlanArgs)).rejects.toThrow(CommitFlowError);
  });
});

const baseReplanArgs = {
  model: {} as never,
  systemContent: "system prompt",
  context: basePlanArgs.context,
  currentCommits: sampleCommits,
  feedback: "merge these",
  onStep: undefined,
};

describe("runReplan", () => {
  it("returns commits on success", async () => {
    mockGenerateText.mockResolvedValue(makeGenerateResult());
    const commits = await runReplan(baseReplanArgs);
    expect(commits).toEqual(sampleCommits);
  });

  it("repairs via NoObjectGeneratedError", async () => {
    const validJson = JSON.stringify({ commits: sampleCommits });
    mockGenerateText.mockRejectedValue(
      new NoObjectGeneratedError({ text: validJson, usage: { totalTokens: 5 } }),
    );
    const commits = await runReplan(baseReplanArgs);
    expect(commits).toEqual(sampleCommits);
  });

  it("retries when repair fails and retry succeeds", async () => {
    const malformed = '{ "commits": [ broken }';
    mockGenerateText
      .mockRejectedValueOnce(new NoObjectGeneratedError({ text: malformed, usage: { totalTokens: 5 } }))
      .mockResolvedValueOnce(makeGenerateResult());
    const commits = await runReplan(baseReplanArgs);
    expect(commits).toEqual(sampleCommits);
  });

  it("throws when both repair and retry fail", async () => {
    const malformed = '{ "commits": [ broken }';
    mockGenerateText
      .mockRejectedValueOnce(new NoObjectGeneratedError({ text: malformed, usage: { totalTokens: 5 } }))
      .mockRejectedValueOnce(new Error("retry also failed"));
    await expect(runReplan(baseReplanArgs)).rejects.toThrow(Error);
  });

  it("throws on non-NoObjectGeneratedError", async () => {
    mockGenerateText.mockRejectedValue(new Error("network failure"));
    await expect(runReplan(baseReplanArgs)).rejects.toThrow(Error);
  });

  it("throws when experimental_output is null", async () => {
    mockGenerateText.mockResolvedValue({ experimental_output: null });
    await expect(runReplan(baseReplanArgs)).rejects.toThrow(Error);
  });
});

// ─── fixFileCoverage ────────────────────────────────────────────

const baseCoverageArgs: FixFileCoverageArgs = {
  model: {} as never,
  systemContent: "system prompt",
  context: basePlanArgs.context,
  commits: sampleCommits,
  knownFiles: ["a.ts"],
  onStep: undefined,
  onLabel: jest.fn(),
  logger: { log: jest.fn(), error: jest.fn() },
};

describe("fixFileCoverage", () => {
  it("returns commits unchanged when coverage is perfect", async () => {
    const result = await fixFileCoverage(baseCoverageArgs);
    expect(result).toEqual(sampleCommits);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("retries and returns fixed commits when coverage is bad", async () => {
    const badArgs: FixFileCoverageArgs = {
      ...baseCoverageArgs,
      commits: [{ type: "feat", description: "missing file", files: ["unknown.ts"] }],
      knownFiles: ["a.ts"],
    };
    mockGenerateText.mockResolvedValue(makeGenerateResult());
    const result = await fixFileCoverage(badArgs);
    expect(result).toEqual(sampleCommits);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("throws when retry also produces bad coverage", async () => {
    const badArgs: FixFileCoverageArgs = {
      ...baseCoverageArgs,
      commits: [{ type: "feat", description: "missing file", files: ["unknown.ts"] }],
      knownFiles: ["a.ts"],
    };
    mockGenerateText.mockResolvedValue(
      makeGenerateResult({ experimental_output: { commits: [{ type: "feat", description: "still bad", files: ["wrong.ts"] }] } }),
    );
    await expect(fixFileCoverage(badArgs)).rejects.toThrow(CommitFlowError);
  });

  it("throws when retry throws", async () => {
    const badArgs: FixFileCoverageArgs = {
      ...baseCoverageArgs,
      commits: [{ type: "feat", description: "missing file", files: ["unknown.ts"] }],
      knownFiles: ["a.ts"],
    };
    mockGenerateText.mockRejectedValue(new Error("retry crashed"));
    await expect(fixFileCoverage(badArgs)).rejects.toThrow(CommitFlowError);
  });
});

// ─── runInteractiveLoop ─────────────────────────────────────────

describe("runInteractiveLoop", () => {
  const commits = [{ type: "feat" as const, description: "test", files: ["a.ts"] }];

  it("returns immediately with --yes", async () => {
    const result = await runInteractiveLoop(commits, { yes: true }, jest.fn());
    expect(result.aborted).toBe(false);
    expect(result.revisionCount).toBe(0);
    expect(result.commits).toBe(commits);
  });

  it("accepts on first prompt", async () => {
    const askAndReplan = jest.fn().mockResolvedValue({ action: "accept" });
    const result = await runInteractiveLoop(commits, {}, askAndReplan);
    expect(result.aborted).toBe(false);
    expect(result.revisionCount).toBe(0);
    expect(result.commits).toBe(commits);
    expect(askAndReplan).toHaveBeenCalledTimes(1);
  });

  it("revises once then accepts", async () => {
    const revised = [{ type: "fix" as const, description: "revised", files: ["b.ts"] }];
    const askAndReplan = jest.fn()
      .mockResolvedValueOnce({ action: "revise", revisedCommits: revised })
      .mockResolvedValueOnce({ action: "accept" });
    const result = await runInteractiveLoop(commits, {}, askAndReplan);
    expect(result.aborted).toBe(false);
    expect(result.revisionCount).toBe(1);
    expect(result.commits).toBe(revised);
  });

  it("aborts on first prompt", async () => {
    const askAndReplan = jest.fn().mockResolvedValue({ action: "abort" });
    const result = await runInteractiveLoop(commits, {}, askAndReplan);
    expect(result.aborted).toBe(true);
    expect(result.revisionCount).toBe(0);
  });

  it("revises then aborts", async () => {
    const revised = [{ type: "fix" as const, description: "revised", files: ["b.ts"] }];
    const askAndReplan = jest.fn()
      .mockResolvedValueOnce({ action: "revise", revisedCommits: revised })
      .mockResolvedValueOnce({ action: "abort" });
    const result = await runInteractiveLoop(commits, {}, askAndReplan);
    expect(result.aborted).toBe(true);
    expect(result.revisionCount).toBe(1);
    expect(result.commits).toBe(revised);
  });

  it("handles multiple revisions", async () => {
    const r1 = [{ type: "fix" as const, description: "r1", files: ["b.ts"] }];
    const r2 = [{ type: "chore" as const, description: "r2", files: ["c.ts"] }];
    const askAndReplan = jest.fn()
      .mockResolvedValueOnce({ action: "revise", revisedCommits: r1 })
      .mockResolvedValueOnce({ action: "revise", revisedCommits: r2 })
      .mockResolvedValueOnce({ action: "accept" });
    const result = await runInteractiveLoop(commits, {}, askAndReplan);
    expect(result.aborted).toBe(false);
    expect(result.revisionCount).toBe(2);
    expect(result.commits).toBe(r2);
  });
});

// ─── executeCommits ─────────────────────────────────────────────

describe("executeCommits", () => {
  const mockGit = {
    add: jest.fn<(files: string[]) => Promise<void>>().mockResolvedValue(undefined),
    commit: jest.fn<(message: string) => Promise<void>>().mockResolvedValue(undefined),
  };
  const mockLogger = { log: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    mockGit.add.mockClear();
    mockGit.commit.mockClear();
    mockLogger.log.mockClear();
  });

  it("adds and commits a single entry", async () => {
    await executeCommits(mockGit as never, sampleCommits, mockLogger);
    expect(mockGit.add).toHaveBeenCalledTimes(1);
    expect(mockGit.add).toHaveBeenCalledWith(["a.ts"]);
    expect(mockGit.commit).toHaveBeenCalledTimes(1);
    expect(mockGit.commit).toHaveBeenCalledWith("feat: add stuff");
  });

  it("adds and commits multiple entries in order", async () => {
    const multi = [
      { type: "feat" as const, description: "first", files: ["a.ts"] },
      { type: "fix" as const, description: "second", files: ["b.ts"] },
    ];
    await executeCommits(mockGit as never, multi, mockLogger);
    expect(mockGit.add).toHaveBeenCalledTimes(2);
    expect(mockGit.add).toHaveBeenNthCalledWith(1, ["a.ts"]);
    expect(mockGit.add).toHaveBeenNthCalledWith(2, ["b.ts"]);
    expect(mockGit.commit).toHaveBeenNthCalledWith(1, "feat: first");
    expect(mockGit.commit).toHaveBeenNthCalledWith(2, "fix: second");
  });

  it("logs the commit count", async () => {
    await executeCommits(mockGit as never, [], mockLogger);
    expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining("0 commit(s)"));
  });
});
