import { gitStatus, gitDiff, gitLog } from "./git-tools.js";
import { readFile } from "./file-tools.js";
import type { ToolSet } from "ai";

export const tools: ToolSet = {
  gitStatus,
  gitDiff,
  gitLog,
  readFile,
};
