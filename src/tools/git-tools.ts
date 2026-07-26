/**
 * Git-related AI tool definitions.
 *
 * Tools in this module allow the model to fetch git state beyond the
 * pre-fetched context in the prompt.
 */
import { tool } from "ai";
import { z } from "zod";
import { simpleGit, type SimpleGit } from "simple-git";

const cwd = process.cwd();
let git: SimpleGit = simpleGit(cwd);

/** @internal Replace the git instance for testing. */
export function __setGit(newGit: SimpleGit): SimpleGit {
  const prev = git;
  git = newGit;
  return prev;
}

/** Maximum bytes returned by the ``gitDiff`` tool before truncation. */
const GIT_DIFF_RETURN_CAP = 16 * 1024;

/**
 * ``gitDiff`` tool — re-fetches the full working-tree diff.
 *
 * Normally the prompt already contains per-file diffs; this tool is
 * only intended for cases where the model genuinely needs more context
 * than what was pre-fetched.  Output is truncated at
 * {@link GIT_DIFF_RETURN_CAP} bytes.
 *
 * @remarks
 * Falls back to unstaged diff (``git diff``) when the HEAD diff fails
 * (e.g. in a brand-new repository).
 */
export const gitDiff = tool({
  description:
    "Rarely needed: status and per-file diffs are normally pre-fetched into the prompt. " +
    "Use only to re-fetch the full unified diff when you need additional context beyond what is in the prompt.",
  parameters: z.object({}),
  execute: async () => {
    try {
      const raw = await git.diff(["HEAD"]);
      if (raw.length <= GIT_DIFF_RETURN_CAP) return raw;
      return raw.slice(0, GIT_DIFF_RETURN_CAP) + `\n[gitDiff truncated at ${GIT_DIFF_RETURN_CAP} bytes; use readFile for specific files]`;
    } catch {
      const fallback = await git.diff();
      if (fallback.length <= GIT_DIFF_RETURN_CAP) return fallback;
      return fallback.slice(0, GIT_DIFF_RETURN_CAP) + `\n[gitDiff truncated at ${GIT_DIFF_RETURN_CAP} bytes]`;
    }
  },
});

/**
 * ``gitLog`` tool — fetches recent commit history.
 *
 * Allows the model to learn commit-message conventions from the
 * repository when the pattern is not obvious from context.  Returns
 * truncated SHA-1 hashes and full commit messages.
 */
export const gitLog = tool({
  description:
    "Get recent commit history to learn commit-message conventions. Use only when the convention is genuinely unclear from context.",
  parameters: z.object({
    count: z.number().optional().default(5).describe("Number of recent commits to show (max 20)"),
  }),
  execute: async ({ count }) => {
    const safeCount = Math.min(Math.max(count, 1), 20);
    const log = await git.log({ n: safeCount });
    if (log.all.length === 0) {
      return "No commits yet.";
    }
    return log.all.map((entry) => `${entry.hash.slice(0, 7)} ${entry.message}`).join("\n");
  },
});
