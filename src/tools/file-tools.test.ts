import { describe, it, expect } from "@jest/globals";
import { readFile } from "./file-tools.js";

describe("readFile tool", () => {
  it("returns error string for absolute paths", async () => {
    const result = await readFile.execute({ path: "/etc/passwd" });
    expect(result).toContain("Absolute paths are not allowed");
  });

  it("returns error string for path traversal outside the working directory", async () => {
    const result = await readFile.execute({ path: "../../etc/passwd" });
    expect(result).toContain("outside the working directory");
  });

  it("returns error string for a dot path that resolves to the working directory itself", async () => {
    const result = await readFile.execute({ path: "." });
    expect(result).toContain("outside the working directory");
  });

  it("returns error string when the file does not exist", async () => {
    const result = await readFile.execute({ path: "./nonexistent-xyz123.test" });
    expect(result).toContain("Failed to read file");
  });

  it("reads an existing repo file", async () => {
    const content = await readFile.execute({ path: "package.json" });
    expect(content).toBeTruthy();
    expect(content.startsWith("{")).toBe(true);
  });

  it("reads a nested source file by relative path", async () => {
    const content = await readFile.execute({ path: "src/tools/file-tools.ts" });
    expect(content).toContain("readFile");
  });
});
