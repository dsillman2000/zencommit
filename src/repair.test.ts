import { describe, it, expect } from "@jest/globals";
import {
  stripMarkdownJsonFences,
  repairJSON,
  validateFileCoverage,
  describeZodIssues,
  buildFormatRetryFeedback,
  buildFilesRetryFeedback,
} from "./repair.js";

describe("stripMarkdownJsonFences", () => {
  it("passes through text without fences", () => {
    expect(stripMarkdownJsonFences('{"a":1}')).toBe('{"a":1}');
  });

  it("strips ```json fences with language tag", () => {
    const input = '```json\n{"commits":[]}\n```';
    expect(stripMarkdownJsonFences(input)).toBe('{"commits":[]}');
  });

  it("strips bare ``` fences without language tag", () => {
    const input = '```\n{"a":1}\n```';
    expect(stripMarkdownJsonFences(input)).toBe('{"a":1}');
  });

  it("strips only opening fence when closing fence is missing", () => {
    const input = '```json\n{"a":1}';
    expect(stripMarkdownJsonFences(input)).toBe('{"a":1}');
  });

  it("returns empty string for whitespace-only input", () => {
    expect(stripMarkdownJsonFences("   \n  ")).toBe("");
  });

  it("handles fences with extra trailing newlines", () => {
    const input = '```json\n{"a":1}\n```\n';
    expect(stripMarkdownJsonFences(input)).toBe('{"a":1}');
  });
});

describe("repairJSON", () => {
  it("passes through already-valid JSON", () => {
    const input = '{"commits":[{"type":"feat","description":"add foo","files":["a.ts"]}]}';
    expect(repairJSON(input)).toBe(input);
  });

  it("unwraps markdown-fenced JSON", () => {
    const input = '```json\n{"a":1}\n```';
    expect(repairJSON(input)).toBe('{"a":1}');
  });

  it("fixes trailing commas", () => {
    const input = '{"a":1,"b":2,}';
    expect(repairJSON(input)).toBe('{"a":1,"b":2}');
  });

  it("quotes unquoted keys", () => {
    const input = "{a:1,b:2}";
    expect(repairJSON(input)).toBe('{"a":1,"b":2}');
  });

  it("fixes combination of unquoted keys and trailing commas", () => {
    const input = "{a:1,b:2,}";
    expect(repairJSON(input)).toBe('{"a":1,"b":2}');
  });

  it("extracts JSON object from surrounding text", () => {
    const input = 'Here is the response:\n{"commits":[]}\nDone.';
    expect(repairJSON(input)).toBe('{"commits":[]}');
  });

  it("extracts nested top-level JSON from text", () => {
    const input = 'Some text before\n{"outer":{"inner":1}}\nSome text after';
    expect(repairJSON(input)).toBe('{"outer":{"inner":1}}');
  });

  it("returns null for completely broken input", () => {
    expect(repairJSON("not json at all")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(repairJSON("")).toBeNull();
  });
});

describe("validateFileCoverage", () => {
  it("returns empty issue for perfect coverage", () => {
    const result = validateFileCoverage(
      [["a.ts", "b.ts"], ["c.ts"]],
      ["a.ts", "b.ts", "c.ts"],
    );
    expect(result.missingInCommits).toEqual([]);
    expect(result.extraInCommits).toEqual([]);
    expect(result.duplicateFiles).toEqual([]);
  });

  it("reports missing files", () => {
    const result = validateFileCoverage(
      [["a.ts"]],
      ["a.ts", "b.ts", "c.ts"],
    );
    expect(result.missingInCommits).toEqual(["b.ts", "c.ts"]);
    expect(result.extraInCommits).toEqual([]);
  });

  it("reports extra files not in known changes", () => {
    const result = validateFileCoverage(
      [["a.ts", "x.ts"]],
      ["a.ts"],
    );
    expect(result.extraInCommits).toEqual(["x.ts"]);
    expect(result.missingInCommits).toEqual([]);
  });

  it("reports duplicate files across commits", () => {
    const result = validateFileCoverage(
      [["a.ts", "b.ts"], ["b.ts", "c.ts"]],
      ["a.ts", "b.ts", "c.ts"],
    );
    expect(result.duplicateFiles).toEqual([
      { file: "b.ts", commitIndices: [0, 1] },
    ]);
    expect(result.missingInCommits).toEqual([]);
  });

  it("handles multiple issue types simultaneously", () => {
    const result = validateFileCoverage(
      [["a.ts"], ["a.ts", "x.ts"]],
      ["a.ts", "b.ts"],
    );
    expect(result.missingInCommits).toEqual(["b.ts"]);
    expect(result.extraInCommits).toEqual(["x.ts"]);
    expect(result.duplicateFiles).toEqual([
      { file: "a.ts", commitIndices: [0, 1] },
    ]);
  });

  it("returns clean for empty input arrays", () => {
    const result = validateFileCoverage([], []);
    expect(result.missingInCommits).toEqual([]);
    expect(result.extraInCommits).toEqual([]);
    expect(result.duplicateFiles).toEqual([]);
  });

  it("reports all known files as missing when no commits exist", () => {
    const result = validateFileCoverage([], ["a.ts", "b.ts"]);
    expect(result.missingInCommits).toEqual(["a.ts", "b.ts"]);
  });
});

describe("describeZodIssues", () => {
  it("formats issues under the max line limit", () => {
    const error = {
      issues: [
        { path: ["commits", "0", "type"], message: "Invalid enum value" },
        { path: ["files"], message: "Array must contain at least 1 element" },
      ],
    } as never;
    const output = describeZodIssues(error as never);
    expect(output).toContain("commits.0.type: Invalid enum value");
    expect(output).toContain("files: Array must contain at least 1 element");
  });

  it("truncates issues over the max line limit", () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({
      path: ["field", String(i)],
      message: `Error ${i}`,
    }));
    const error = { issues } as never;
    const output = describeZodIssues(error, 3);
    const lines = output.split("\n").filter((l) => l.startsWith("  - "));
    expect(lines).toHaveLength(3);
    expect(output).toContain("...(");
  });

  it("uses '(root)' for empty path", () => {
    const error = { issues: [{ path: [], message: "Required" }] } as never;
    const output = describeZodIssues(error);
    expect(output).toContain("(root): Required");
  });
});

describe("buildFormatRetryFeedback", () => {
  it("includes the full text when under maxChars", () => {
    const output = buildFormatRetryFeedback("some text", 600);
    expect(output).toContain("some text");
    expect(output).toContain("Previous attempt:");
    expect(output).toContain("markdown");
  });

  it("truncates text when over maxChars", () => {
    const longText = "x".repeat(1000);
    const output = buildFormatRetryFeedback(longText, 100);
    expect(output).toContain("…");
    expect(output.length).toBeLessThan(1000);
  });
});

describe("buildFilesRetryFeedback", () => {
  it("reports missing files", () => {
    const output = buildFilesRetryFeedback({
      missingInCommits: ["a.ts"],
      extraInCommits: [],
      duplicateFiles: [],
    });
    expect(output).toContain("MUST appear");
    expect(output).toContain("a.ts");
  });

  it("reports extra files", () => {
    const output = buildFilesRetryFeedback({
      missingInCommits: [],
      extraInCommits: ["x.ts"],
      duplicateFiles: [],
    });
    expect(output).toContain("NOT changed");
    expect(output).toContain("x.ts");
  });

  it("reports duplicate files with commit indices", () => {
    const output = buildFilesRetryFeedback({
      missingInCommits: [],
      extraInCommits: [],
      duplicateFiles: [{ file: "b.ts", commitIndices: [0, 2] }],
    });
    expect(output).toContain("b.ts");
    expect(output).toContain("commits 1, 3");
  });

  it("reports all issue types together", () => {
    const output = buildFilesRetryFeedback({
      missingInCommits: ["a.ts"],
      extraInCommits: ["x.ts"],
      duplicateFiles: [{ file: "b.ts", commitIndices: [0, 1] }],
    });
    expect(output).toContain("MUST appear");
    expect(output).toContain("NOT changed");
    expect(output).toContain("commits 1, 2");
  });
});
