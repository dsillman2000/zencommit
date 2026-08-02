import { mkdtemp, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function projectRoot(): string {
  return resolve(__dirname, "..", "..");
}

function fixturesDir(): string {
  return join(projectRoot(), "tests", "fixtures");
}

export interface Scenario {
  /** Absolute path to the tempdir containing the ready-to-use git repo. */
  dir: string;
  /** Remove the tempdir. */
  cleanup: () => Promise<void>;
}

/**
 * Loads a scenario tarball into a temporary directory.
 *
 * The returned directory is a fully functional git repo with the desired
 * working-tree state already applied.
 *
 * @param projectType - e.g. ``"node-project"``
 * @param scenarioName - e.g. ``"default"``
 */
export async function loadScenario(
  projectType: string,
  scenarioName: string,
): Promise<Scenario> {
  const tarball = join(
    fixturesDir(),
    projectType,
    "scenarios",
    `${scenarioName}.tar.gz`,
  );

  if (!existsSync(tarball)) {
    throw new Error(
      `Scenario tarball not found: ${tarball}\n` +
      `Run: node tests/scripts/build-fixture.mjs ${scenarioName}`,
    );
  }

  const tmp = await mkdtemp(join(tmpdir(), "zc-benchmark-"));

  execSync(`tar -xzf "${tarball}" -C "${tmp}"`, { stdio: "pipe" });

  return {
    dir: tmp,
    cleanup: () => rm(tmp, { recursive: true, force: true }).catch(() => {}),
  };
}
