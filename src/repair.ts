/**
 * JSON repair and validation helpers.
 *
 * When the AI model returns malformed output (missing braces, trailing
 * commas, markdown fences, or file-coverage issues), this module attempts
 * automatic repair and generates structured retry feedback.
 */
import type { ZodError } from "zod";

/**
 * Strips markdown code-fence syntax (`` ```json `` and `` ``` ``) from a
 * string that might be wrapped in a fenced code block.
 *
 * @param text - The raw model output.
 * @returns The text with leading and trailing fences removed.
 */
export function stripMarkdownJsonFences(text: string): string {
  let stripped = text.trim();
  if (stripped.startsWith("```")) {
    const firstNewline = stripped.indexOf("\n");
    if (firstNewline !== -1) {
      stripped = stripped.slice(firstNewline + 1);
      if (stripped.endsWith("```")) {
        stripped = stripped.slice(0, -3).trimEnd();
      }
    }
  }
  return stripped;
}

/**
 * Extracts the first top-level JSON object (``{ ... }``) from arbitrary
 * text by tracking brace depth while respecting string literal boundaries.
 *
 * @param text - Text that may contain embedded JSON.
 * @returns The extracted JSON substring, or ``null`` if no balanced
 *          top-level object is found.
 */
function extractTopLevelJsonBlock(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (c === "\\") {
        escaping = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function removeTrailingCommas(json: string): string {
  return json.replace(/,(\s*[}\]])/g, "$1");
}

function quoteUnquotedKeys(json: string): string {
  return json.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, (_match, p1, p2, p3) => `${p1}"${p2}"${p3}`);
}

/**
 * Attempts to repair a malformed JSON string produced by the model.
 *
 * Applies a series of increasingly aggressive transformations —
 * stripping markdown fences, extracting top-level objects,
 * removing trailing commas, and quoting unquoted keys — until one
 * variant parses successfully.
 *
 * @param rawText - The raw model output that failed to parse.
 * @returns A valid JSON string, or ``null`` if all repair attempts fail.
 */
export function repairJSON(rawText: string): string | null {
  const strippedFences = stripMarkdownJsonFences(rawText);
  const block = extractTopLevelJsonBlock(strippedFences) ?? strippedFences.trim();

  const candidates: string[] = [
    strippedFences.trim(),
    block,
    removeTrailingCommas(block),
    quoteUnquotedKeys(removeTrailingCommas(block)),
    removeTrailingCommas(quoteUnquotedKeys(removeTrailingCommas(block))),
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Describes file-coverage problems in the AI-generated commit plan.
 */
export interface FilesValidationIssue {
  /** Files that are changed on disk but missing from any commit. */
  missingInCommits: string[];
  /** Files included in commits but not actually changed on disk. */
  extraInCommits: string[];
  /** Files that appear in more than one commit. */
  duplicateFiles: { file: string; commitIndices: number[] }[];
}

/**
 * Validates that the AI-generated commit plan covers every changed file
 * exactly once and includes no extra files.
 *
 * @param aiFiles - Array of per-commit file arrays from the model output.
 * @param knownChanged - List of file paths known to be changed
 *   (from pre-fetched context).
 * @returns A {@link FilesValidationIssue} describing any discrepancies.
 */
export function validateFileCoverage(
  aiFiles: string[][],
  knownChanged: string[],
): FilesValidationIssue {
  const knownSet = new Set(knownChanged);
  const seenFiles: Map<string, number[]> = new Map();

  for (let i = 0; i < aiFiles.length; i++) {
    for (const f of aiFiles[i]) {
      seenFiles.set(f, [...(seenFiles.get(f) ?? []), i]);
    }
  }

  const duplicateFiles: { file: string; commitIndices: number[] }[] = [];
  for (const [file, indices] of seenFiles.entries()) {
    if (indices.length > 1) {
      duplicateFiles.push({ file, commitIndices: indices });
    }
  }

  const missingInCommits: string[] = [];
  const extraInCommits: string[] = [];
  const allSeen = new Set(seenFiles.keys());
  for (const file of knownChanged) {
    if (!allSeen.has(file)) missingInCommits.push(file);
  }
  for (const file of allSeen) {
    if (!knownSet.has(file)) extraInCommits.push(file);
  }

  return { missingInCommits, extraInCommits, duplicateFiles };
}

/**
 * Formats Zod validation issues into a human-readable string.
 *
 * @param error - A Zod ``ZodError`` instance.
 * @param maxLines - Maximum number of issue lines to include (default 6).
 * @returns A multi-line string describing the issues.
 */
export function describeZodIssues(error: ZodError, maxLines = 6): string {
  const issues = error.issues.slice(0, maxLines);
  const lines = issues.map((issue) => {
    const path = issue.path.join(".") || "(root)";
    return `  - ${path}: ${issue.message}`;
  });
  if (error.issues.length > maxLines) {
    lines.push(`  ...(${error.issues.length - maxLines} more)`);
  }
  return lines.join("\n");
}

/**
 * Builds retry feedback for a format-level failure (malformed JSON).
 *
 * @param text - The model's previous raw output.
 * @param maxChars - Maximum characters of the output to include in the
 *   feedback snippet (default 600).
 * @returns A feedback string suitable for appending to the retry prompt.
 */
export function buildFormatRetryFeedback(text: string, maxChars = 600): string {
  const trimmed = text.trim();
  const snippet = trimmed.length > maxChars ? trimmed.slice(0, maxChars) + "…" : trimmed;
  return [
    "Your previous response could not be parsed as the required JSON schema.",
    "Return ONLY a single JSON object matching the schema with no commentary, no markdown, and no code fences.",
    "Previous attempt:",
    snippet,
  ].join("\n");
}

/**
 * Builds retry feedback for file-coverage validation issues.
 *
 * Tells the model exactly which files are missing, extra, or duplicated
 * so it can fix its output.
 *
 * @param issue - The validation issue from
 *   {@link validateFileCoverage}.
 * @returns A feedback string suitable for appending to the retry prompt.
 */
export function buildFilesRetryFeedback(issue: FilesValidationIssue): string {
  const lines: string[] = ["Your previous response had file-coverage issues. Return ONLY the JSON with these corrections:"];
  if (issue.missingInCommits.length > 0) {
    lines.push(`- These changed files MUST appear in some commit's files[]: ${issue.missingInCommits.join(", ")}`);
  }
  if (issue.extraInCommits.length > 0) {
    lines.push(`- These files were NOT changed; remove them: ${issue.extraInCommits.join(", ")}`);
  }
  if (issue.duplicateFiles.length > 0) {
    lines.push(`- These files appeared in multiple commits (each must be in exactly one):`);
    for (const dup of issue.duplicateFiles) {
      lines.push(`    - ${dup.file} appears in commits ${dup.commitIndices.map((i) => i + 1).join(", ")}`);
    }
  }
  return lines.join("\n");
}
