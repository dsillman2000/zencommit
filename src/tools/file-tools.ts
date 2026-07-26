import { tool } from "ai";
import { z } from "zod";
import { readFile as fsReadFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

const cwd = process.cwd();
const READ_FILE_CAP = 50 * 1024;

export const readFile = tool({
  description:
    "Read the contents of a file in the repository. Use only when a specific diff line is genuinely ambiguous and intent cannot be inferred from context.",
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

    let raw: string;
    try {
      raw = await fsReadFile(resolved, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read file "${path}": ${message}`);
    }

    if (raw.length <= READ_FILE_CAP) return raw;
    return raw.slice(0, READ_FILE_CAP) + `\n[readFile truncated at ${READ_FILE_CAP} bytes for ${path}]`;
  },
});
