import { describe, it, expect } from "@jest/globals";
import { readFile } from "./file-tools.js";

describe("readFile tool", () => {
  it("rejects absolute paths", async () => {
    await expect(readFile.execute({ path: "/etc/passwd" }))
      .rejects.toThrow("Absolute paths are not allowed");
  });

  it("rejects path traversal outside the working directory", async () => {
    await expect(readFile.execute({ path: "../../etc/passwd" }))
      .rejects.toThrow("outside the working directory");
  });

  it("rejects a dot path that resolves to the working directory itself", async () => {
    await expect(readFile.execute({ path: "." }))
      .rejects.toThrow("outside the working directory");
  });

  it("throws when the file does not exist", async () => {
    await expect(readFile.execute({ path: "./nonexistent-xyz123.test" }))
      .rejects.toThrow("Failed to read file");
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
