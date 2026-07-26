import type { ZodError } from "zod";

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

export interface FilesValidationIssue {
  missingInCommits: string[];
  extraInCommits: string[];
  duplicateFiles: { file: string; commitIndices: number[] }[];
}

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
