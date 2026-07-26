/**
 * File-reading AI tool definition.
 *
 * Allows the model to read the full content of a repository file when
 * the pre-fetched diff does not provide enough context.
 */
import { tool } from "ai";
import { z } from "zod";
import { readFile as fsReadFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

const cwd = process.cwd();

/** Maximum bytes returned by the ``readFile`` tool before truncation. */
const READ_FILE_CAP = 50 * 1024;

/**
 * ``readFile`` tool — reads a repository file from disk.
 *
 * Enforces a guard that the path is relative and stays within the
 * working directory.  Absolute paths and directory traversal attempts
 * are rejected.  Output is truncated at {@link READ_FILE_CAP} bytes.
 *
 * @throws {Error} If the path is absolute.
 * @throws {Error} If the path resolves outside the working directory.
 * @throws {Error} If the file cannot be read (missing, permissions, etc.).
 */
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
      throw new Error(`Failed to read file "${path}": ${message}`, { cause: err });
    }

    if (raw.length <= READ_FILE_CAP) return raw;
    return raw.slice(0, READ_FILE_CAP) + `\n[readFile truncated at ${READ_FILE_CAP} bytes for ${path}]`;
  },
});
