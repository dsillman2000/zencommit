import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
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
} from "./zencommit.js";
import type { CommitEntry, PrefetchedContext } from "./zencommit.js";

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
