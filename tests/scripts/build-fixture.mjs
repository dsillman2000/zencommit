#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile, stat, readdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

async function buildScenario(projectType, name) {
  const fixtures = join(ROOT, "tests", "fixtures", projectType);
  const base = join(fixtures, "base");
  const scenarioDir = join(fixtures, "scenarios", name);
  const tarball = join(fixtures, "scenarios", `${name}.tar.gz`);
  const tmp = join(fixtures, "scenarios", `.build-${name}`);

  console.log(`Building scenario "${projectType}/${name}"…`);

  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  await cp(base, tmp, { recursive: true });

  execSync("git init", { cwd: tmp });
  execSync('git config user.email "test@example.com"', { cwd: tmp });
  execSync('git config user.name "Test"', { cwd: tmp });

  execSync("git add .", { cwd: tmp });
  execSync('git commit -m "init: scaffold project structure"', { cwd: tmp });

  const readmePath = join(tmp, "README.md");
  const readme = await readFile(readmePath, "utf-8");
  await writeFile(readmePath, readme + "\n\nSecond version with documentation updates.\n");
  execSync("git add -A", { cwd: tmp });
  execSync('git commit -m "docs: update project documentation"', { cwd: tmp });

  if (existsSync(scenarioDir)) {
    await cp(scenarioDir, tmp, {
      recursive: true,
      filter: (src) => {
        const rel = src.startsWith(scenarioDir)
          ? src.slice(scenarioDir.length + 1)
          : "";
        return !rel.startsWith(".") && rel !== "deleted.txt" && rel !== "staged.txt";
      },
    });
  }

  const deletedListPath = join(scenarioDir, "deleted.txt");
  if (existsSync(deletedListPath)) {
    const toDelete = (await readFile(deletedListPath, "utf-8"))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const f of toDelete) {
      try { await rm(join(tmp, f)); } catch { }
    }
  }

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

  console.log(execSync("git status --short", { cwd: tmp, encoding: "utf-8" }));

  execSync(`tar -czf "${tarball}" -C "${tmp}" .`, { cwd: tmp });

  await rm(tmp, { recursive: true, force: true });
  console.log(`  → ${tarball} (${(await stat(tarball)).size} bytes)`);
}

async function main() {
  const configPath = join(ROOT, "tests", "benchmark.config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));

  const enabled = (config.scenarios ?? []).filter((s) => s.enabled);

  if (enabled.length === 0) {
    console.log("No enabled scenarios found in benchmark.config.json");
    return;
  }

  for (const scenario of enabled) {
    const [projectType, scenarioName] = scenario.id.split("/");
    if (!projectType || !scenarioName) {
      console.error(`Invalid scenario id: "${scenario.id}" — expected "<projectType>/<scenarioName>"`);
      continue;
    }
    await buildScenario(projectType, scenarioName);
  }
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
