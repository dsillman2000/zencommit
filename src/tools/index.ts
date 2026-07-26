import { gitDiff, gitLog } from "./git-tools.js";
import { readFile } from "./file-tools.js";
import type { ToolSet } from "ai";

export const tools: ToolSet = {
  gitDiff,
  gitLog,
  readFile,
};
