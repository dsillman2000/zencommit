#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "node-project");

async function buildScenario(name) {
  const base = join(FIXTURES, "base");
  const scenarioDir = join(FIXTURES, "scenarios", name);
  const tarball = join(FIXTURES, "scenarios", `${name}.tar.gz`);
  const tmp = join(FIXTURES, "scenarios", `.build-${name}`);

  console.log(`Building scenario "${name}"…`);

  // Clean and recreate tmp dir
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  // Copy base files
  await cp(base, tmp, { recursive: true });

  // Init git repo
  execSync("git init", { cwd: tmp });
  execSync('git config user.email "test@example.com"', { cwd: tmp });
  execSync('git config user.name "Test"', { cwd: tmp });

  // First commit: scaffold
  execSync("git add .", { cwd: tmp });
  execSync('git commit -m "init: scaffold project structure"', { cwd: tmp });

  // Add auth and api files for second commit (they were in the first too,
  // so we create a second commit that "adds" them by modifying)
  // Actually for realism: the second commit introduces auth.ts and api.ts
  // but they're already present from the first commit (base/).
  // Let me create a second commit by modifying config.ts (add secret/debug):
  // Hmm, they're already in the base. Let me think differently...

  // === Approach: Two-commit history ===
  // Commit 1: everything present
  // We don't really need a second commit for the model to work,
  // but having two makes the git log dump more interesting.
  // Let me just add a benign change to a file and commit it.

  // Second commit: modify README slightly
  const readmePath = join(tmp, "README.md");
  const readme = await readFile(readmePath, "utf-8");
  await writeFile(readmePath, readme + "\n\nSecond version with documentation updates.\n");
  execSync("git add -A", { cwd: tmp });
  execSync('git commit -m "docs: update project documentation"', { cwd: tmp });

  // === Apply scenario overlay ===

  // Copy overlay files (modified and new files)
  if (existsSync(scenarioDir)) {
    await cp(scenarioDir, tmp, {
      recursive: true,
      // Use a filter: skip non-source files (deleted.txt, staged.txt)
      filter: (src) => {
        const rel = src.startsWith(scenarioDir)
          ? src.slice(scenarioDir.length + 1)
          : "";
        return !rel.startsWith(".") && rel !== "deleted.txt" && rel !== "staged.txt";
      },
    });
  }

  // Delete files listed in deleted.txt
  const deletedListPath = join(scenarioDir, "deleted.txt");
  if (existsSync(deletedListPath)) {
    const toDelete = (await readFile(deletedListPath, "utf-8"))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const f of toDelete) {
      const full = join(tmp, f);
      try {
        await rm(full);
      } catch {
        // file may not exist at this path; that's fine
      }
    }
  }

  // Stage files listed in staged.txt
  const stagedListPath = join(scenarioDir, "staged.txt");
  if (existsSync(stagedListPath)) {
    const toStage = (await readFile(stagedListPath, "utf-8"))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const f of toStage) {
      execSync(`git add "${f}"`, { cwd: tmp });
    }
  }

  // Verify the repo is in the expected state
  console.log(execSync("git status --short", { cwd: tmp, encoding: "utf-8" }));

  // Tar the whole repo (including .git/) into the scenarios directory
  execSync(`tar -czf "${tarball}" -C "${tmp}" .`, { cwd: tmp });

  // Clean up temp build dir
  await rm(tmp, { recursive: true, force: true });
  console.log(`  → ${tarball} (${(await stat(tarball)).size} bytes)`);
}

import { stat } from "node:fs/promises";

async function main() {
  const scenarioArg = process.argv[2];
  if (scenarioArg) {
    await buildScenario(scenarioArg);
  } else {
    // Build all scenario dirs
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(FIXTURES, "scenarios"), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("_build")) {
        await buildScenario(entry.name);
      }
    }
  }
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
