#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

async function buildScenario(name) {
  const fixtureDir = join(ROOT, "tests", "fixtures", name);
  const beforeTarball = join(fixtureDir, "before.tar.gz");
  const patchFile = join(fixtureDir, "changes.patch");
  const scenarioJson = join(fixtureDir, "scenario.json");
  const outTarball = join(fixtureDir, "scenario.tar.gz");
  const tmp = join(fixtureDir, `.build-${name}`);

  console.log(`Building scenario "${name}"…`);

  if (!existsSync(beforeTarball)) {
    throw new Error(`Missing before state: ${beforeTarball}`);
  }
  if (!existsSync(patchFile)) {
    throw new Error(`Missing changes patch: ${patchFile}`);
  }
  if (!existsSync(scenarioJson)) {
    throw new Error(`Missing scenario manifest: ${scenarioJson}`);
  }

  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  // Extract before state
  execSync(`tar -xzf "${beforeTarball}" -C "${tmp}"`, { stdio: "pipe" });

  // Initialize git and commit the before state
  execSync("git init", { cwd: tmp });
  execSync('git config user.email "test@example.com"', { cwd: tmp });
  execSync('git config user.name "Test"', { cwd: tmp });
  execSync("git add .", { cwd: tmp });
  execSync('git commit -m "init: scaffold project structure"', { cwd: tmp });

  // Apply changes patch
  const patch = await readFile(patchFile, "utf-8");
  execSync("git apply -", { cwd: tmp, input: patch });

  console.log(execSync("git status --short", { cwd: tmp, encoding: "utf-8" }));

  // Create the built scenario tarball
  execSync(`tar -czf "${outTarball}" -C "${tmp}" .`, { cwd: tmp });

  await rm(tmp, { recursive: true, force: true });
  console.log(`  → ${outTarball} (${(await stat(outTarball)).size} bytes)`);
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
    if (!scenario.name) {
      console.error(`Invalid scenario: missing "name"`);
      continue;
    }
    await buildScenario(scenario.name);
  }
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
