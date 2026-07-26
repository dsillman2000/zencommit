import { describe, it, expect, jest, beforeEach, afterAll } from "@jest/globals";
import {
  changedFilesFromStatus,
  allChangedPaths,
  formatChangedFiles,
  formatDiffSections,
  buildDiffSections,
  precomputeContext,
  __setGit,
  type ChangedFiles,
  type DiffSection,
} from "./prompt.js";

function makeStatus(overrides?: Partial<{
  staged: string[];
  modified: string[];
  deleted: string[];
  created: string[];
  not_added: string[];
  renamed: { from: string; to: string }[];
}>) {
  return {
    staged: overrides?.staged ?? [],
    modified: overrides?.modified ?? [],
    deleted: overrides?.deleted ?? [],
    created: overrides?.created ?? [],
    not_added: overrides?.not_added ?? [],
    renamed: overrides?.renamed ?? [],
  } as never;
}

const mockGit = {
  diff: jest.fn<(...args: string[]) => Promise<string>>(),
};

let prevGit: ReturnType<typeof __setGit>;

beforeEach(() => {
  prevGit = __setGit(mockGit as never);
  mockGit.diff.mockReset();
});

afterAll(() => {
  __setGit(prevGit);
});

describe("changedFilesFromStatus", () => {
  it("converts a StatusResult to ChangedFiles", () => {
    const status = makeStatus({
      staged: ["a.ts"],
      modified: ["b.ts"],
      deleted: ["c.ts"],
      created: ["d.ts"],
      not_added: ["e.ts"],
      renamed: [{ from: "old.ts", to: "new.ts" }],
    });
    const result = changedFilesFromStatus(status);
    expect(result).toEqual({
      staged: ["a.ts"],
      modified: ["b.ts"],
      deleted: ["c.ts"],
      created: ["d.ts"],
      untracked: ["e.ts"],
      renamed: [{ from: "old.ts", to: "new.ts" }],
    });
  });

  it("handles empty status", () => {
    const result = changedFilesFromStatus(makeStatus({}));
    expect(result).toEqual({
      staged: [],
      modified: [],
      deleted: [],
      created: [],
      untracked: [],
      renamed: [],
    });
  });

  it("maps not_added to untracked", () => {
    const status = makeStatus({ not_added: ["u.ts"] });
    expect(changedFilesFromStatus(status).untracked).toEqual(["u.ts"]);
  });

  it("transforms renamed entries", () => {
    const status = makeStatus({
      renamed: [{ from: "a.txt", to: "b.txt" }],
    });
    const result = changedFilesFromStatus(status);
    expect(result.renamed).toEqual([{ from: "a.txt", to: "b.txt" }]);
  });
});

describe("allChangedPaths", () => {
  it("merges all categories into a flat list", () => {
    const files: ChangedFiles = {
      staged: ["a.ts"],
      modified: ["b.ts"],
      deleted: ["c.ts"],
      created: ["d.ts"],
      untracked: ["e.ts"],
      renamed: [{ from: "old.ts", to: "new.ts" }],
    };
    expect(allChangedPaths(files)).toEqual([
      "a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "new.ts",
    ]);
  });

  it("includes only the destination path for renames", () => {
    const files: ChangedFiles = {
      staged: [],
      modified: [],
      deleted: [],
      created: [],
      untracked: [],
      renamed: [{ from: "old.ts", to: "new.ts" }],
    };
    const paths = allChangedPaths(files);
    expect(paths).toContain("new.ts");
    expect(paths).not.toContain("old.ts");
  });

  it("returns empty array for no changes", () => {
    const files: ChangedFiles = {
      staged: [], modified: [], deleted: [],
      created: [], untracked: [], renamed: [],
    };
    expect(allChangedPaths(files)).toEqual([]);
  });
});

describe("formatChangedFiles", () => {
  const full: ChangedFiles = {
    staged: ["s.ts"],
    modified: ["m.ts"],
    deleted: ["d.ts"],
    created: ["c.ts"],
    untracked: ["u.ts"],
    renamed: [{ from: "old.ts", to: "new.ts" }],
  };

  it("includes all non-empty categories", () => {
    const output = formatChangedFiles(full);
    expect(output).toContain("Staged:");
    expect(output).toContain("Modified (unstaged):");
    expect(output).toContain("Deleted (unstaged):");
    expect(output).toContain("Created (unstaged):");
    expect(output).toContain("Untracked:");
    expect(output).toContain("Renamed:");
    expect(output).toContain("old.ts -> new.ts");
  });

  it("omits empty categories", () => {
    const onlyStaged: ChangedFiles = { ...full, modified: [], deleted: [], created: [], untracked: [], renamed: [] };
    const output = formatChangedFiles(onlyStaged);
    expect(output).toContain("Staged:");
    expect(output).not.toContain("Modified");
    expect(output).not.toContain("Deleted");
  });

  it("returns '(none)' when all categories are empty", () => {
    const empty: ChangedFiles = {
      staged: [], modified: [], deleted: [],
      created: [], untracked: [], renamed: [],
    };
    expect(formatChangedFiles(empty)).toBe("(none)");
  });

  it("formats renamed files with arrow", () => {
    const files: ChangedFiles = {
      staged: [], modified: [], deleted: [],
      created: [], untracked: [],
      renamed: [{ from: "a.ts", to: "b.ts" }],
    };
    expect(formatChangedFiles(files)).toContain("a.ts -> b.ts");
  });
});

describe("formatDiffSections", () => {
  it("returns '(no diffs)' for empty sections", () => {
    expect(formatDiffSections([], false)).toBe("(no diffs)");
  });

  it("formats a normal section without tags", () => {
    const sections: DiffSection[] = [
      { path: "a.ts", diff: "+1 line", truncated: false },
    ];
    const output = formatDiffSections(sections, false);
    expect(output).toContain("--- a.ts ---");
    expect(output).toContain("+1 line");
    expect(output).not.toContain("[omitted]");
    expect(output).not.toContain("[truncated]");
  });

  it("tags truncated sections", () => {
    const sections: DiffSection[] = [
      { path: "a.ts", diff: "+1 line", truncated: true },
    ];
    expect(formatDiffSections(sections, false)).toContain("[truncated]");
  });

  it("tags omitted sections", () => {
    const sections: DiffSection[] = [
      { path: "a.ts", diff: "[diff omitted]", truncated: true, omitted: true },
    ];
    expect(formatDiffSections(sections, false)).toContain("[omitted]");
  });

  it("appends budget note when capHit is true", () => {
    const sections: DiffSection[] = [
      { path: "a.ts", diff: "+1", truncated: false },
    ];
    const output = formatDiffSections(sections, true);
    expect(output).toContain("diff budget reached");
  });
});

describe("diffForFile (indirectly via buildDiffSections)", () => {
  it("returns diff for a tracked file", async () => {
    mockGit.diff.mockResolvedValue("+\nnew content");
    const files: ChangedFiles = {
      staged: ["a.ts"], modified: [], deleted: [], created: [], untracked: [], renamed: [],
    };
    const { sections } = await buildDiffSections(files);
    expect(sections[0]).toMatchObject({ diff: "+\nnew content", truncated: false });
  });

  it("falls back to unstaged diff when HEAD diff is empty", async () => {
    mockGit.diff
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("+\nunstaged");
    const files: ChangedFiles = {
      staged: ["a.ts"], modified: [], deleted: [], created: [], untracked: [], renamed: [],
    };
    const { sections } = await buildDiffSections(files);
    expect(sections[0].diff).toBe("+\nunstaged");
  });

  it("returns no-textual-changes message when both diffs are empty", async () => {
    mockGit.diff
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    const files: ChangedFiles = {
      staged: ["a.ts"], modified: [], deleted: [], created: [], untracked: [], renamed: [],
    };
    const { sections } = await buildDiffSections(files);
    expect(sections[0].diff).toBe("(no textual changes)");
  });

  it("returns deleted message without calling git", async () => {
    const files: ChangedFiles = {
      staged: [], modified: [], deleted: ["d.ts"], created: [], untracked: [], renamed: [],
    };
    const { sections } = await buildDiffSections(files);
    expect(sections[0].diff).toBe("(deleted from working tree)");
    expect(mockGit.diff).not.toHaveBeenCalled();
  });

  it("returns untracked message without calling git", async () => {
    const files: ChangedFiles = {
      staged: [], modified: [], deleted: [], created: [], untracked: ["u.ts"], renamed: [],
    };
    const { sections } = await buildDiffSections(files);
    expect(sections[0].diff).toBe("(untracked; no HEAD diff available)");
    expect(mockGit.diff).not.toHaveBeenCalled();
  });

  it("returns diff-failed message when git throws", async () => {
    mockGit.diff.mockRejectedValue(new Error("boom"));
    const files: ChangedFiles = {
      staged: ["a.ts"], modified: [], deleted: [], created: [], untracked: [], renamed: [],
    };
    const { sections } = await buildDiffSections(files);
    expect(sections[0].diff).toBe("(diff failed: boom)");
  });
});

describe("buildDiffSections budget behavior", () => {
  it("handles nonempty sections under the total budget", async () => {
    mockGit.diff.mockResolvedValue("short");
    const files: ChangedFiles = {
      staged: ["a.ts", "b.ts"], modified: [], deleted: [], created: [], untracked: [], renamed: [],
    };
    const { sections, capHit } = await buildDiffSections(files);
    expect(sections).toHaveLength(2);
    expect(capHit).toBe(false);
    expect(sections[0].omitted).toBeUndefined();
    expect(sections[1].omitted).toBeUndefined();
  });

  it("truncates a diff that exceeds the per-file budget", async () => {
    mockGit.diff.mockResolvedValue("x".repeat(5000));
    const files: ChangedFiles = {
      staged: ["big.ts"], modified: [], deleted: [], created: [], untracked: [], renamed: [],
    };
    const { sections, capHit } = await buildDiffSections(files);
    expect(sections).toHaveLength(1);
    expect(capHit).toBe(false);
    expect(sections[0].truncated).toBe(true);
    expect(sections[0].diff.length).toBe(4096);
  });

  it("omits remaining files when the total budget is exceeded", async () => {
    const fileCount = 9;
    mockGit.diff.mockResolvedValue("x".repeat(4096));
    const files: ChangedFiles = {
      staged: Array.from({ length: fileCount }, (_, i) => `f${i}.ts`),
      modified: [], deleted: [], created: [], untracked: [], renamed: [],
    };
    const { sections, capHit } = await buildDiffSections(files);
    expect(sections).toHaveLength(fileCount);
    expect(capHit).toBe(true);
    expect(sections[0].omitted).toBeUndefined();
    expect(sections[fileCount - 1]).toMatchObject({ path: "f8.ts", omitted: true, truncated: true });
    expect(sections[fileCount - 1].diff).toContain("diff omitted");
    expect(sections[fileCount - 1].diff).toContain("f8.ts");
  });

  it("includes renamed files by their destination path", async () => {
    mockGit.diff.mockResolvedValue("+\nmoved content");
    const files: ChangedFiles = {
      staged: [], modified: [], deleted: [], created: [], untracked: [], renamed: [{ from: "old.ts", to: "new.ts" }],
    };
    const { sections } = await buildDiffSections(files);
    expect(sections).toHaveLength(1);
    expect(sections[0].path).toBe("new.ts");
  });
});

describe("precomputeContext", () => {
  it("builds context for nonempty status with diffs", async () => {
    mockGit.diff.mockResolvedValue("+\ncontent");
    const status = makeStatus({
      staged: ["a.ts"],
      modified: ["b.ts"],
    });
    const ctx = await precomputeContext(status as never);
    expect(ctx.allChangedPaths).toEqual(["a.ts", "b.ts"]);
    expect(ctx.diffSections).toHaveLength(2);
    expect(ctx.diffCapHit).toBe(false);
    expect(ctx.formatted.files).toContain("Staged:");
    expect(ctx.formatted.files).toContain("Modified (unstaged):");
    expect(ctx.formatted.files).not.toContain("Deleted");
    expect(ctx.formatted.diffs).toContain("--- a.ts ---");
    expect(ctx.formatted.diffs).toContain("--- b.ts ---");
  });

  it("handles empty status gracefully", async () => {
    const ctx = await precomputeContext(makeStatus({}) as never);
    expect(ctx.allChangedPaths).toEqual([]);
    expect(ctx.diffSections).toHaveLength(0);
    expect(ctx.diffCapHit).toBe(false);
    expect(ctx.formatted.files).toBe("(none)");
    expect(ctx.formatted.diffs).toBe("(no diffs)");
  });
});

// loadAgentsMd is tested implicitly through the real AGENTS.md file.
// It is a thin wrapper around fs.readFile that returns an empty string on
// ENOENT, and module-level mocking of built-in `node:fs/promises` is not
// supported in Jest's ESM mode.
