import { mkdir, writeFile, readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "./fixtures.js";
import { StatsReportSchema, type StatsReport } from "./stats-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ScenarioEntry {
  name: string;
  enabled: boolean;
}

interface ScenarioManifest {
  prompt?: string;
}

interface BenchmarkConfig {
  models: string[];
  trialsPerModel: number;
  spawnTimeoutMs: number;
  scenarios: ScenarioEntry[];
}

interface TrialResult {
  trial: number;
  model: string;
  ok: boolean;
  spawnExitCode: number | null;
  spawnSignal: string | null;
  spawnStdoutLen: number;
  spawnStderr: string;
  spawnWallMs: number;
  parseError?: string;
  report?: StatsReport;
}

interface ModelSummary {
  model: string;
  trials: number;
  successes: number;
  robustness: number;
  totalMs: { p50: number; p95: number; p99: number; min: number; max: number };
  promptTokens: { p50: number; mean: number };
  completionTokens: { p50: number; mean: number };
  totalTokens: { p50: number; mean: number };
  toolCallCount: { p50: number; mean: number };
  formatRepairs: number;
  coverageRetries: number;
}

interface AggregatedResults {
  timestamp: string;
  config: BenchmarkConfig;
  cwd: string;
  cliPath: string;
  trials: TrialResult[];
  summaries: ModelSummary[];
}

function projectRoot(): string {
  return resolve(__dirname, "..", "..");
}

function fixturesDir(): string {
  return resolve(projectRoot(), "tests", "fixtures");
}

function readConfig(): BenchmarkConfig {
  const configPath = resolve(projectRoot(), "tests", "benchmark.config.json");
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  return {
    models: raw.models ?? [
      "big-pickle",
      "deepseek-v4-flash-free",
      "gpt-5-nano",
      "mimo-v2.5-free",
    ],
    trialsPerModel: raw.trialsPerModel ?? 10,
    spawnTimeoutMs: raw.spawnTimeoutMs ?? 120_000,
    scenarios: raw.scenarios ?? [],
  };
}

async function readScenarioManifest(name: string): Promise<ScenarioManifest> {
  const path = resolve(fixturesDir(), name, "scenario.json");
  if (!existsSync(path)) {
    return {};
  }
  const raw = await readFile(path, "utf-8");
  try {
    return JSON.parse(raw) as ScenarioManifest;
  } catch {
    return {};
  }
}

function p50(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.5)];
}

function p95(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)];
}

function p99(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.99)];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function summarizeTrial(trial: TrialResult): string {
  const wall = (trial.spawnWallMs / 1000).toFixed(1) + "s";
  if (trial.ok && trial.report) {
    const inner = (trial.report.metrics.totalMs / 1000).toFixed(1) + "s";
    const tokens = trial.report.calls.find((c) => c.usage)?.usage?.totalTokens ?? 0;
    const tools = trial.report.calls.reduce(
      (sum, c) => sum + c.steps.reduce((s, st) => s + st.toolCalls.length, 0),
      0,
    );
    const repairs =
      "formatRepairs" in trial.report.result
        ? (trial.report.result as { formatRepairs: number }).formatRepairs +
          (trial.report.result as { coverageRetries: number }).coverageRetries
        : 0;
    return `OK  wall=${wall} inner=${inner}  ${tokens}tok  ${tools}tools  ${repairs}rep`;
  }
  if (trial.parseError) {
    const firstLine = trial.parseError.split("\n")[0].slice(0, 60);
    if (trial.spawnExitCode === null) {
      return `SPAWN FAIL  wall=${wall}  ${firstLine}`;
    }
    return `PARSE FAIL  wall=${wall}  ${firstLine}`;
  }
  if (!trial.ok && trial.report) {
    const err = trial.report.result;
    if ("error" in err) {
      return `FAIL  wall=${wall}  ${err.error.phase}: ${err.error.message.slice(0, 50)}`;
    }
  }
  return `FAIL  wall=${wall}`;
}

export async function runBenchmark(): Promise<AggregatedResults> {
  const config = readConfig();
  const cliPath = resolve(projectRoot(), "dist", "index.js");

  if (!existsSync(cliPath)) {
    throw new Error(
      `CLI not found at ${cliPath}. Build first: npm run build`,
    );
  }

  const enabledScenarios = config.scenarios.filter((s) => s.enabled);
  if (enabledScenarios.length === 0) {
    throw new Error("No enabled scenarios in benchmark.config.json");
  }

  const scenarioManifests = await Promise.all(
    enabledScenarios.map((s) => readScenarioManifest(s.name)),
  );

  const trials: TrialResult[] = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const totalTrials = config.models.length * config.trialsPerModel;
  let trialIndex = 0;

  for (let t = 1; t <= config.trialsPerModel; t++) {
    for (let mi = 0; mi < config.models.length; mi++) {
      const model = config.models[mi];
      const si = (t + mi) % enabledScenarios.length;
      const scenarioName = enabledScenarios[si].name;
      const manifest = scenarioManifests[si];
      const scenario = await loadScenario(scenarioName);
      trialIndex++;

      process.stderr.write(
        `  [${trialIndex}/${totalTrials}] ${model} trial ${t}/${config.trialsPerModel} (${scenarioName}) … `,
      );

      const args = [cliPath, "--stats", "-m", model];
      if (manifest.prompt) {
        args.push("-p", manifest.prompt);
      }

      const spawnStart = Date.now();
      const result = spawnSync(
        process.execPath,
        args,
        {
          cwd: scenario.dir,
          timeout: config.spawnTimeoutMs,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const spawnWallMs = Date.now() - spawnStart;

      const trial: TrialResult = {
        trial: t,
        model,
        ok: false,
        spawnExitCode: result.status,
        spawnSignal: result.signal,
        spawnStdoutLen: (result.stdout ?? "").length,
        spawnStderr: result.stderr ?? "",
        spawnWallMs,
      };

      if (result.error) {
        trial.parseError = `spawn error: ${result.error.message}`;
        process.stderr.write(summarizeTrial(trial) + "\n");
      } else {
        const stdout = (result.stdout ?? "").trim();
        const parsed = StatsReportSchema.safeParse(
          (() => {
            try {
              return JSON.parse(stdout);
            } catch {
              trial.parseError =
                `JSON parse error on stdout (${stdout.length} chars)\n` +
                `stdout preview: ${stdout.slice(0, 300)}\n` +
                `stderr: ${(result.stderr ?? "").slice(0, 300)}`;
              return null;
            }
          })(),
        );

        if (parsed.success) {
          trial.report = parsed.data;
          trial.ok = parsed.data.ok;
          process.stderr.write(summarizeTrial(trial) + "\n");
        } else {
          trial.parseError =
            (parsed.error instanceof Error
              ? parsed.error.message
              : "schema validation error") +
            `\nstdout preview: ${stdout.slice(0, 300)}`;
          process.stderr.write(summarizeTrial(trial) + "\n");
        }
      }

      trials.push(trial);
      await scenario.cleanup();
    }
  }

  // Aggregate per-model
  const summaries: ModelSummary[] = config.models.map((model) => {
    const modelTrials = trials.filter((t) => t.model === model);
    const successful = modelTrials.filter((t) => t.ok);
    const totalMsArr = successful.map((t) => t.report!.metrics.totalMs);
    const promptTokensArr = successful.map(
      (t) =>
        t.report!.calls.find((c) => c.usage)?.usage?.promptTokens ?? 0,
    );
    const completionTokensArr = successful.map(
      (t) =>
        t.report!.calls.find((c) => c.usage)?.usage?.completionTokens ?? 0,
    );
    const totalTokensArr = successful.map(
      (t) =>
        t.report!.calls.find((c) => c.usage)?.usage?.totalTokens ?? 0,
    );
    const toolCallCounts = successful.map((t) =>
      t.report!.calls.reduce(
        (sum, c) =>
          sum +
          c.steps.reduce((s, step) => s + step.toolCalls.length, 0),
        0,
      ),
    );
    const formatRepairs = successful.reduce(
      (sum, t) =>
        sum +
        ("formatRepairs" in t.report!.result
          ? (t.report!.result as { formatRepairs: number }).formatRepairs
          : 0),
      0,
    );
    const coverageRetries = successful.reduce(
      (sum, t) =>
        sum +
        ("coverageRetries" in t.report!.result
          ? (t.report!.result as { coverageRetries: number }).coverageRetries
          : 0),
      0,
    );

    return {
      model,
      trials: modelTrials.length,
      successes: successful.length,
      robustness:
        modelTrials.length > 0 ? successful.length / modelTrials.length : 0,
      totalMs: {
        p50: p50(totalMsArr),
        p95: p95(totalMsArr),
        p99: p99(totalMsArr),
        min: totalMsArr.length > 0 ? Math.min(...totalMsArr) : 0,
        max: totalMsArr.length > 0 ? Math.max(...totalMsArr) : 0,
      },
      promptTokens: { p50: p50(promptTokensArr), mean: mean(promptTokensArr) },
      completionTokens: {
        p50: p50(completionTokensArr),
        mean: mean(completionTokensArr),
      },
      totalTokens: { p50: p50(totalTokensArr), mean: mean(totalTokensArr) },
      toolCallCount: { p50: p50(toolCallCounts), mean: mean(toolCallCounts) },
      formatRepairs,
      coverageRetries,
    };
  });

  const results: AggregatedResults = {
    timestamp,
    config,
    cwd: projectRoot(),
    cliPath,
    trials,
    summaries,
  };

  // Write results to .results/
  const resultsDir = resolve(
    projectRoot(),
    "tests",
    "benchmark",
    ".results",
  );
  await mkdir(resultsDir, { recursive: true });
  const resultsFile = join(resultsDir, `${timestamp}.json`);
  await writeFile(resultsFile, JSON.stringify(results, null, 2), "utf-8");

  // Print summary table
  console.log("\n─── Benchmark Results ───");
  console.log(`Results written to: ${relative(projectRoot(), resultsFile)}`);
  console.log("");
  console.log(
    "Model".padEnd(30) +
      "Success".padEnd(10) +
      "Robust".padEnd(8) +
      "p50(ms)".padEnd(10) +
      "p95(ms)".padEnd(10) +
      "p50(token)".padEnd(12) +
      "Tools".padEnd(8) +
      "Rprs",
  );
  console.log("─".repeat(90));
  for (const s of summaries) {
    console.log(
      s.model.padEnd(30) +
        `${s.successes}/${s.trials}`.padEnd(10) +
        `${(s.robustness * 100).toFixed(0)}%`.padEnd(8) +
        `${s.totalMs.p50.toFixed(0)}`.padEnd(10) +
        `${s.totalMs.p95.toFixed(0)}`.padEnd(10) +
        `${s.totalTokens.p50.toFixed(0)}`.padEnd(12) +
        `${s.toolCallCount.mean.toFixed(1)}`.padEnd(8) +
        `${s.formatRepairs}`,
    );
  }

  return results;
}
