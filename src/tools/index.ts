/**
 * Barrel export for Vercel AI SDK tools available to the model.
 *
 * These tools allow the AI to optionally re-fetch git diffs, inspect
 * commit history, or read file contents when the pre-fetched context is
 * insufficient.
 */
import { gitDiff, gitLog } from "./git-tools.js";
import { readFile } from "./file-tools.js";
import type { ToolSet } from "ai";

/**
 * Tool definitions registered with the AI model.
 *
 * @remarks
 * Only three tools are exposed:
 *
 * - ``gitDiff`` — re-fetch the full unified diff.
 * - ``gitLog`` — browse recent commit messages for convention discovery.
 * - ``readFile`` — read a specific file from the working tree.
 */
export const tools: ToolSet = {
  gitDiff,
  gitLog,
  readFile,
};
