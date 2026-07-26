import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit, type StatusResult } from "simple-git";

const PER_FILE_BUDGET = 4 * 1024;
const TOTAL_DIFF_BUDGET = 32 * 1024;
const MAX_FILES_FOR_DIFF = 50;

const cwd = process.cwd();
const git = simpleGit(cwd);

export interface ChangedFiles {
  staged: string[];
  modified: string[];
  deleted: string[];
  created: string[];
  untracked: string[];
  renamed: { from: string; to: string }[];
}

export function changedFilesFromStatus(status: StatusResult): ChangedFiles {
  return {
    staged: status.staged,
    modified: status.modified,
    deleted: status.deleted,
    created: status.created,
    untracked: status.not_added,
    renamed: status.renamed.map((r) => ({ from: r.from, to: r.to })),
  };
}

export function allChangedPaths(files: ChangedFiles): string[] {
  return [
    ...files.staged,
    ...files.modified,
    ...files.deleted,
    ...files.created,
    ...files.untracked,
    ...files.renamed.map((r) => r.to),
  ];
}

function truncateTo(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const kept = text.slice(0, maxChars);
  return { text: kept, truncated: true };
}

async function diffForFile(file: string, deletedFiles: Set<string>, untracked: Set<string>): Promise<string> {
  try {
    if (deletedFiles.has(file)) {
      return "(deleted from working tree)";
    }
    if (untracked.has(file)) {
      return "(untracked; no HEAD diff available)";
    }
    const raw = await git.diff(["HEAD", "--", file]);
    if (raw.trim().length === 0) {
      const unstaged = await git.diff(["--", file]);
      return unstaged.trim().length === 0 ? "(no textual changes)" : unstaged;
    }
    return raw;
  } catch (err) {
    return `(diff failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export interface DiffSection {
  path: string;
  diff: string;
  truncated: boolean;
  omitted?: boolean;
}

export async function buildDiffSections(files: ChangedFiles): Promise<{ sections: DiffSection[]; capHit: boolean }> {
  const deletedSet = new Set(files.deleted);
  const untrackedSet = new Set(files.untracked);

  const candidates = [
    ...files.staged,
    ...files.modified,
    ...files.deleted,
    ...files.created,
    ...files.untracked,
    ...files.renamed.map((r) => r.to),
  ].slice(0, MAX_FILES_FOR_DIFF);

  const sections: DiffSection[] = [];
  let totalBytesUsed = 0;
  let capHit = false;

  for (const path of candidates) {
    const raw = await diffForFile(path, deletedSet, untrackedSet);
    const { text, truncated } = truncateTo(raw, PER_FILE_BUDGET);

    if (totalBytesUsed + text.length > TOTAL_DIFF_BUDGET) {
      capHit = true;
      sections.push({
        path,
        diff: `[diff omitted: total diff budget exceeded; call readFile for ${path}]`,
        truncated: true,
        omitted: true,
      });
      continue;
    }

    totalBytesUsed += text.length;
    sections.push({ path, diff: text, truncated });
  }
  return { sections, capHit };
}

export function formatChangedFiles(files: ChangedFiles): string {
  const blocks: string[] = [];
  if (files.staged.length) blocks.push(`Staged:\n${files.staged.map((f) => `  ${f}`).join("\n")}`);
  if (files.modified.length) blocks.push(`Modified (unstaged):\n${files.modified.map((f) => `  ${f}`).join("\n")}`);
  if (files.deleted.length) blocks.push(`Deleted (unstaged):\n${files.deleted.map((f) => `  ${f}`).join("\n")}`);
  if (files.created.length) blocks.push(`Created (unstaged):\n${files.created.map((f) => `  ${f}`).join("\n")}`);
  if (files.untracked.length) blocks.push(`Untracked:\n${files.untracked.map((f) => `  ${f}`).join("\n")}`);
  if (files.renamed.length) blocks.push(`Renamed:\n${files.renamed.map((r) => `  ${r.from} -> ${r.to}`).join("\n")}`);
  return blocks.length === 0 ? "(none)" : blocks.join("\n\n");
}

export function formatDiffSections(sections: DiffSection[], capHit: boolean): string {
  if (sections.length === 0) return "(no diffs)";
  const parts: string[] = [];
  for (const sec of sections) {
    const tag = sec.omitted ? " [omitted]" : sec.truncated ? " [truncated]" : "";
    parts.push(`--- ${sec.path}${tag} ---\n${sec.diff}`);
  }
  if (capHit) {
    parts.push(`\n[note: total diff budget reached; some files were omitted. Use readFile or gitLog only if context is genuinely missing.]`);
  }
  return parts.join("\n\n");
}

export interface PrefetchedContext {
  changedFiles: ChangedFiles;
  allChangedPaths: string[];
  diffSections: DiffSection[];
  diffCapHit: boolean;
  formatted: {
    files: string;
    diffs: string;
  };
}

export async function precomputeContext(status: StatusResult): Promise<PrefetchedContext> {
  const changedFiles = changedFilesFromStatus(status);
  const allPaths = allChangedPaths(changedFiles);
  const { sections, capHit } = await buildDiffSections(changedFiles);
  return {
    changedFiles,
    allChangedPaths: allPaths,
    diffSections: sections,
    diffCapHit: capHit,
    formatted: {
      files: formatChangedFiles(changedFiles),
      diffs: formatDiffSections(sections, capHit),
    },
  };
}

export async function loadAgentsMd(): Promise<string> {
  try {
    const content = await readFile(join(cwd, "AGENTS.md"), "utf-8");
    return `\n\n**AGENTS.md (project conventions):**\n${content}`;
  } catch {
    return "";
  }
}

export const SYSTEM_PROMPT = `You are an expert at writing conventional commit messages for git repositories.

**Workflow**
1. The status and per-file diffs are provided below. You usually do not need any tools.
2. Only call \`gitLog\` if recent commit-message convention is genuinely unclear from the context.
3. Only call \`readFile\` if a specific diff line is genuinely ambiguous and you cannot infer intent from context.
4. Produce a list of commits where each changed file is assigned to exactly one commit.

**Commit Rules**
- Each commit must follow the Conventional Commits format: type(scope): description
- Valid types: feat, fix, docs, style, refactor, perf, test, chore, ci, build, revert
- Scope is optional but encouraged when clearly applicable
- Description must be in imperative mood, lowercase, and concise
- Each commit MUST list the exact file paths in the 'files' array
- EVERY changed file in the pre-fetched status MUST appear in exactly ONE commit
- Group logically related file changes into a single commit
- Split clearly independent changes into separate commits only when warranted
- There can be at most as many commits as there are changed files
- If the AGENTS.md section below specifies conventions, follow them

**Critical Output Format**
- Your final response MUST be raw, valid JSON and nothing else.
- Do NOT wrap the JSON in markdown code fences (no \`\`\`json or \`\`\`).
- The response must start with { and end with } — pure JSON, no prefix, no suffix.`;
