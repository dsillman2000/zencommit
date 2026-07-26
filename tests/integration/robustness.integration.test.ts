import { describe, it, expect } from "@jest/globals";
import { runIntegration } from "./orchestrator.js";

const RUN_INTEGRATION = Boolean(process.env.RUN_INTEGRATION_TESTS);

describe("zencommit integration", () => {
  if (!RUN_INTEGRATION) {
    it("skipped — set RUN_INTEGRATION_TESTS=1 to run", () => {});
    return;
  }

  it(
    "runs robustness and performance benchmarks against real models",
    async () => {
      const results = await runIntegration();

      // Basic sanity: all trials ran and produced a report
      expect(results.trials.length).toBe(
        results.config.models.length * results.config.trialsPerModel,
      );

      // Every trial either succeeded or has a recorded failure reason.
      // Spawn timeouts produce exitCode=null, which is valid — we only
      // assert exit code 0 when the process actually exited.
      for (const trial of results.trials) {
        if (trial.spawnExitCode !== null) {
          expect(trial.spawnExitCode).toBe(0);
        }
        if (!trial.parseError) {
          expect(trial.report).toBeDefined();
          expect(trial.report!.schemaVersion).toBe(1);
          if (trial.report!.calls.length > 0) {
            expect(trial.report!.metrics.totalMs).toBeGreaterThan(0);
          }
        }
      }

      // Summaries computed for each model
      expect(results.summaries.length).toBe(results.config.models.length);
      for (const s of results.summaries) {
        expect(s.trials).toBeGreaterThan(0);
        // Robustness must be ≥ 0 and ≤ 1
        expect(s.robustness).toBeGreaterThanOrEqual(0);
        expect(s.robustness).toBeLessThanOrEqual(1);
      }

      // Log summary data for human inspection
      console.table(
        results.summaries.map((s) => ({
          Model: s.model,
          "S/T": `${s.successes}/${s.trials}`,
          Robustness: `${(s.robustness * 100).toFixed(0)}%`,
          "p50(ms)": s.totalMs.p50.toFixed(0),
          "p95(ms)": s.totalMs.p95.toFixed(0),
          "p50(tok)": s.totalTokens.p50.toFixed(0),
          "Tools(μ)": s.toolCallCount.mean.toFixed(1),
          Repairs: s.formatRepairs,
        })),
      );
    },
    900_000,
  );
});
