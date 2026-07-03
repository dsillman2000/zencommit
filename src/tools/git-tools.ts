import { tool } from "ai";
import { z } from "zod";
import { simpleGit } from "simple-git";

const cwd = process.cwd();
const git = simpleGit(cwd);

export const gitStatus = tool({
  description: "Get the current git status showing staged, unstaged, and untracked changes",
  parameters: z.object({}),
  execute: async () => {
    const status = await git.status();

    const lines: string[] = [];
    lines.push(`On branch ${status.current}`);
    if (status.tracking) {
      lines.push(`Tracking ${status.tracking}`);
    }

    if (status.staged.length > 0) {
      lines.push("\nStaged:");
      for (const file of status.staged) {
        lines.push(`  ${file}`);
      }
    }

    if (status.modified.length > 0) {
      lines.push("\nUnstaged modified:");
      for (const file of status.modified) {
        lines.push(`  ${file}`);
      }
    }

    if (status.deleted.length > 0) {
      lines.push("\nDeleted:");
      for (const file of status.deleted) {
        lines.push(`  ${file}`);
      }
    }

    if (status.not_added.length > 0) {
      lines.push("\nUntracked:");
      for (const file of status.not_added) {
        lines.push(`  ${file}`);
      }
    }

    if (status.created.length > 0) {
      lines.push("\nCreated (tracked):");
      for (const file of status.created) {
        lines.push(`  ${file}`);
      }
    }

    if (status.renamed.length > 0) {
      lines.push("\nRenamed:");
      for (const rename of status.renamed) {
        lines.push(`  ${rename.from} -> ${rename.to}`);
      }
    }

    return lines.join("\n");
  },
});

export const gitDiff = tool({
  description: "Get the full diff of all changes compared to HEAD (both staged and unstaged)",
  parameters: z.object({}),
  execute: async () => {
    try {
      return await git.diff(["HEAD"]);
    } catch {
      return await git.diff();
    }
  },
});

export const gitLog = tool({
  description: "Get recent commit history for context on commit message conventions",
  parameters: z.object({
    count: z.number().optional().default(5).describe("Number of recent commits to show"),
  }),
  execute: async ({ count }) => {
    const log = await git.log({ n: count });
    if (log.all.length === 0) {
      return "No commits yet.";
    }
    return log.all
      .map((entry) => `${entry.hash.slice(0, 7)} ${entry.message} (${entry.date})`)
      .join("\n");
  },
});
