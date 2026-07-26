import { describe, it, expect, jest, beforeEach, afterAll } from "@jest/globals";
import { gitDiff, gitLog, __setGit } from "./git-tools.js";

const mockGit = {
  diff: jest.fn<(...args: string[]) => Promise<string>>(),
  log: jest.fn<(opts: { n: number }) => Promise<{ all: { hash: string; message: string }[] }>>(),
};

let prevGit: ReturnType<typeof __setGit>;

beforeEach(() => {
  prevGit = __setGit(mockGit as never);
  mockGit.diff.mockReset();
  mockGit.log.mockReset();
});

afterAll(() => {
  __setGit(prevGit);
});

describe("gitDiff tool", () => {
  it("returns the HEAD diff on success", async () => {
    mockGit.diff.mockResolvedValue("+\nnew code");
    const result = await gitDiff.execute({});
    expect(result).toBe("+\nnew code");
  });

  it("falls back to unstaged diff when HEAD diff throws", async () => {
    mockGit.diff
      .mockRejectedValueOnce(new Error("no HEAD"))
      .mockResolvedValueOnce("+\nunstaged changes");
    const result = await gitDiff.execute({});
    expect(result).toBe("+\nunstaged changes");
  });

  it("truncates output when over the return cap", async () => {
    const big = "x".repeat(20 * 1024);
    mockGit.diff.mockResolvedValue(big);
    const result = await gitDiff.execute({});
    expect(result).toContain("[gitDiff truncated at");
  });

  it("throws when both HEAD and unstaged diff fail", async () => {
    mockGit.diff
      .mockRejectedValueOnce(new Error("HEAD error"))
      .mockRejectedValueOnce(new Error("unstaged error"));
    await expect(gitDiff.execute({})).rejects.toThrow("unstaged error");
  });
});

describe("gitLog tool", () => {
  it("returns formatted commit history", async () => {
    mockGit.log.mockResolvedValue({
      all: [
        { hash: "abc123def456", message: "feat: add stuff" },
        { hash: "789012abcdef", message: "fix: resolve bug" },
      ],
    });
    const result = await gitLog.execute({ count: 5 });
    expect(result).toContain("abc123d feat: add stuff");
    expect(result).toContain("789012a fix: resolve bug");
  });

  it("returns 'No commits yet.' for an empty repo", async () => {
    mockGit.log.mockResolvedValue({ all: [] });
    const result = await gitLog.execute({ count: 5 });
    expect(result).toBe("No commits yet.");
  });

  it("passes the count to git.log", async () => {
    mockGit.log.mockResolvedValue({
      all: [{ hash: "a", message: "msg" }],
    });
    await gitLog.execute({ count: 10 });
    expect(mockGit.log).toHaveBeenCalledWith({ n: 10 });
  });

  it("clamps count to max 20", async () => {
    mockGit.log.mockResolvedValue({
      all: [{ hash: "a", message: "msg" }],
    });
    await gitLog.execute({ count: 100 });
    expect(mockGit.log).toHaveBeenCalledWith({ n: 20 });
  });

  it("clamps count to minimum 1", async () => {
    mockGit.log.mockResolvedValue({
      all: [{ hash: "a", message: "msg" }],
    });
    await gitLog.execute({ count: 0 });
    expect(mockGit.log).toHaveBeenCalledWith({ n: 1 });
  });
});
