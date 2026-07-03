import { tool } from "ai";
import { z } from "zod";
import { readFile as fsReadFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

const cwd = process.cwd();

export const readFile = tool({
  description: "Read the contents of a file in the repository. Rejects paths outside the working directory.",
  parameters: z.object({
    path: z.string().describe("Relative path to the file within the repository"),
  }),
  execute: async ({ path }) => {
    if (path.startsWith("/")) {
      throw new Error("Absolute paths are not allowed. Use a relative path.");
    }

    const resolved = resolve(join(cwd, path));
    const rel = relative(cwd, resolved);

    if (rel.startsWith("..") || rel === "") {
      throw new Error(`Path "${path}" is outside the working directory.`);
    }

    try {
      return await fsReadFile(resolved, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read file "${path}": ${message}`);
    }
  },
});
