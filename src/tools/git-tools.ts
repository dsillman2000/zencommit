import { tool } from "ai";
import { z } from "zod";
import { simpleGit } from "simple-git";

const cwd = process.cwd();
const git = simpleGit(cwd);

const GIT_DIFF_RETURN_CAP = 16 * 1024;

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
