/**
 * Prompt construction and git-context pre-fetching.
 *
 * This module gathers the working-tree state (changed files, diffs) and
 * assembles the system prompt the AI model receives to generate
 * Conventional Commits.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit, type StatusResult } from "simple-git";

/** Maximum bytes per-file diff included in the prompt. */
const PER_FILE_BUDGET = 4 * 1024;

/** Maximum total bytes of all diffs combined in the prompt. */
const TOTAL_DIFF_BUDGET = 32 * 1024;

/** Maximum number of changed files considered when pre-fetching diffs. */
const MAX_FILES_FOR_DIFF = 50;

const cwd = process.cwd();
let git = simpleGit(cwd);

/** @internal Replace the git instance for testing. */
export function __setGit(newGit: typeof git): typeof git {
  const prev = git;
  git = newGit;
  return prev;
}

/**
 * Normalised view of the files changed in the working tree.
 *
 * Derived from simple-git's ``StatusResult`` into a shape that is
 * independent of the underlying git client.
 */
export interface ChangedFiles {
  /** Files staged for commit (``git add``). */
  staged: string[];
  /** Modified but unstaged files. */
  modified: string[];
  /** Deleted but unstaged files. */
  deleted: string[];
  /** Newly created but unstaged files. */
  created: string[];
  /** Untracked files (not yet ``git add``-ed). */
  untracked: string[];
  /** Renamed files, with both old and new paths. */
  renamed: { from: string; to: string }[];
}

/**
 * Converts a simple-git status result into the normalised
 * {@link ChangedFiles} shape.
 *
 * @param status - The status result from simple-git.
 * @returns The normalised changed-files representation.
 */
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

/**
 * Collects every changed file path into a single flat array.
 *
 * For renamed files only the destination path is included; the old name
 * is not part of the current working tree.
 *
 * @param files - The normalised changed-files record.
 * @returns All unique file paths that are part of the change set.
 */
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

/**
 * Fetches the git diff for a single file.
 *
 * Handles edge cases where the file is deleted (no diff to show) or
 * untracked (no HEAD baseline), and falls back to scanning for unstaged
 * changes when the HEAD diff is empty.
 *
 * @param file - Relative path to the file.
 * @param deletedFiles - Set of files marked as deleted.
 * @param untracked - Set of files marked as untracked.
 * @returns A diff string or a human-readable status message.
 */
export async function diffForFile(file: string, deletedFiles: Set<string>, untracked: Set<string>): Promise<string> {
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

/**
 * A single file's diff section within the prompt context.
 */
export interface DiffSection {
  /** Relative file path. */
  path: string;
  /** The diff text (may be truncated or omitted). */
  diff: string;
  /** Whether the diff text was truncated due to the per-file budget. */
  truncated: boolean;
  /** Whether the diff was fully omitted due to the total budget cap. */
  omitted?: boolean;
}

/**
 * Builds diff sections for all changed files, respecting both per-file
 * and total-size budgets.
 *
 * When the total budget is exceeded, remaining files are annotated as
 * omitted so the model knows additional context is available via
 * ``readFile``.
 *
 * @param files - The normalised changed-files record.
 * @returns The list of diff sections and a flag indicating whether the
 *          budget cap was hit.
 */
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

/**
 * Formats the changed-files list into a human-readable string for the
 * model prompt.
 *
 * @param files - The normalised changed-files record.
 * @returns A multi-line string grouped by change category.
 */
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

/**
 * Formats diff sections into a single string for the model prompt.
 *
 * Files whose diffs were truncated or omitted are annotated accordingly.
 *
 * @param sections - The diff sections to format.
 * @param capHit - Whether the total budget was exceeded.
 * @returns A formatted diff string.
 */
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

/**
 * All pre-fetched git context passed into the model prompt.
 */
export interface PrefetchedContext {
  /** Normalised changed-files list. */
  changedFiles: ChangedFiles;
  /** Flat array of all changed file paths. */
  allChangedPaths: string[];
  /** Per-file diff sections (may be truncated or omitted). */
  diffSections: DiffSection[];
  /** Whether the diff budget was exceeded. */
  diffCapHit: boolean;
  /** Pre-formatted strings ready for inclusion in the prompt. */
  formatted: {
    /** Formatted changed-files listing. */
    files: string;
    /** Formatted diffs block. */
    diffs: string;
  };
}

/**
 * Pre-computes all git context needed by the model prompt.
 *
 * Reads the working-tree status, normalises it, fetches diffs
 * (respecting budgets), and pre-formats everything into a single
 * {@link PrefetchedContext} object.
 *
 * @param status - The status result from simple-git.
 * @returns A fully-formed context object ready for prompt construction.
 */
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

/**
 * Loads the project's ``AGENTS.md`` file for inclusion in the system
 * prompt.
 *
 * The content is appended so the model can follow project-specific
 * commit conventions defined in that file.
 *
 * @returns The AGENTS.md content wrapped with a header, or an empty
 *          string if the file does not exist.
 */
export async function loadAgentsMd(): Promise<string> {
  try {
    const content = await readFile(join(cwd, "AGENTS.md"), "utf-8");
    return `\n\n**AGENTS.md (project conventions):**\n${content}`;
  } catch {
    return "";
  }
}

/**
 * System prompt sent to the AI model.
 *
 * Instructs the model to generate Conventional Commits output as raw JSON
 * without markdown wrapping, respecting budgets and considering the
 * pre-fetched diff context.
 */
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
