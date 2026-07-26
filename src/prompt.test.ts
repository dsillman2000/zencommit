import { describe, it, expect } from "@jest/globals";
import {
  changedFilesFromStatus,
  allChangedPaths,
  formatChangedFiles,
  formatDiffSections,
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

// loadAgentsMd is tested implicitly through the real AGENTS.md file.
// It is a thin wrapper around fs.readFile that returns an empty string on
// ENOENT, and module-level mocking of built-in `node:fs/promises` is not
// supported in Jest's ESM mode.
