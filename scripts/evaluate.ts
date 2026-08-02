import { readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");

function projectPath(...parts: string[]): string {
  return join(PROJECT_ROOT, ...parts);
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
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

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}

function fmtDelta(current: number, baseline: number): string {
  const diff = current - baseline;
  const pct = baseline !== 0 ? ((diff / baseline) * 100).toFixed(1) : "∞";
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${pct}%`;
}

function fmtDeltaPct(current: number, baseline: number): string {
  const diff = current - baseline;
  const pct = baseline !== 0 ? ((diff / baseline) * 100).toFixed(1) : "∞";
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${pct}pp`;
}

function scenarioSummary(config: BenchmarkConfig): string {
  const enabled = config.scenarios.filter((s) => s.enabled).map((s) => s.name);
  if (enabled.length === 0) return "no scenarios";
  if (enabled.length === 1) return `Scenario: ${enabled[0]}`;
  if (enabled.length <= 3) return `${enabled.length} scenarios: ${enabled.join(", ")}`;
  return `${enabled.length} scenarios`;
}

interface TrialResult {
  trial: number;
  model: string;
  ok: boolean;
  spawnWallMs: number;
  parseError?: string;
  report?: {
    calls: { usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }[];
  };
}

interface ScenarioEntry {
  name: string;
  enabled: boolean;
}

interface BenchmarkConfig {
  models: string[];
  trialsPerModel: number;
  spawnTimeoutMs: number;
  scenarios: ScenarioEntry[];
}

interface AggregatedResults {
  timestamp: string;
  config: BenchmarkConfig;
  trials: TrialResult[];
}

interface ModelMetrics {
  model: string;
  trials: number;
  successes: number;
  successRate: number;
  wallMs: { avg: number; p50: number; p95: number };
  totalTokens: { avg: number; p50: number; p95: number };
}

interface BaselineMetrics {
  sha: string;
  timestamp: string;
  models: Record<string, ModelMetrics>;
}

function computeMetrics(results: AggregatedResults): ModelMetrics[] {
  const byModel = new Map<string, TrialResult[]>();
  for (const trial of results.trials) {
    const arr = byModel.get(trial.model) ?? [];
    arr.push(trial);
    byModel.set(trial.model, arr);
  }

  const metrics: ModelMetrics[] = [];
  for (const [model, trials] of byModel) {
    const successful = trials.filter((t) => t.ok);
    const wallArr = successful.map((t) => t.spawnWallMs);
    const tokenArr = successful.map((t) => {
      const calls = t.report?.calls ?? [];
      return calls.reduce((sum, c) => sum + (c.usage?.totalTokens ?? 0), 0);
    });

    metrics.push({
      model,
      trials: trials.length,
      successes: successful.length,
      successRate: trials.length > 0 ? successful.length / trials.length : 0,
      wallMs: {
        avg: avg(wallArr),
        p50: p50(wallArr),
        p95: p95(wallArr),
      },
      totalTokens: {
        avg: avg(tokenArr),
        p50: p50(tokenArr),
        p95: p95(tokenArr),
      },
    });
  }

  return metrics;
}

function findLatestResults(): AggregatedResults | null {
  const resultsDir = projectPath("tests", "benchmark", ".results");
  if (!existsSync(resultsDir)) return null;

  const files = readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(resultsDir, files[0]), "utf-8"));
}

function loadBaseline(): BaselineMetrics | null {
  const path = projectPath("baseline", "metrics.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── KDE helpers ────────────────────────────────────────────────

function gaussianKernel(u: number): number {
  return Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
}

function scottBandwidth(data: number[]): number {
  const n = data.length;
  if (n < 2) return 1;
  const m = avg(data);
  const variance = data.reduce((sum, x) => sum + (x - m) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  const h = 1.06 * std * Math.pow(n, -0.2);
  if (h < 0.001) {
    return Math.max(Math.abs(m) * 0.05, 1);
  }
  return h;
}

function computeKdeOnGrid(data: number[], xGrid: number[]): number[] {
  const n = data.length;
  if (n === 0) return xGrid.map(() => 0);
  const h = scottBandwidth(data);
  return xGrid.map((xi) => {
    let sum = 0;
    for (const d of data) {
      sum += gaussianKernel((xi - d) / h);
    }
    return sum / (n * h);
  });
}

function buildSharedGrid(dataSets: number[][], nPoints: number): number[] {
  let globalMin = Infinity;
  let globalMax = -Infinity;
  for (const data of dataSets) {
    if (data.length === 0) continue;
    globalMin = Math.min(globalMin, ...data);
    globalMax = Math.max(globalMax, ...data);
  }
  if (!isFinite(globalMin)) return [];
  const pad = (globalMax - globalMin) * 0.15 || 1;
  const step = (globalMax - globalMin + 2 * pad) / (nPoints - 1);
  const grid: number[] = [];
  for (let i = 0; i < nPoints; i++) {
    grid.push(globalMin - pad + i * step);
  }
  return grid;
}

// ─── SVG chart generators ───────────────────────────────────────

const MODEL_COLORS = [
  "#4e79a7",
  "#e15759",
  "#76b7b2",
  "#f28e2b",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
];

function formatAxisLabel(val: number): string {
  if (val >= 100000) return (val / 1000).toFixed(0) + "k";
  if (val >= 1000) return (val / 1000).toFixed(1) + "k";
  return val.toFixed(0);
}

function generateKdePlotSvg(
  traces: {
    model: string;
    color: string;
    x: number[];
    density: number[];
  }[],
  xLabel: string,
): string {
  const W = 640, H = 340, MARGIN = { top: 30, right: 160, bottom: 50, left: 65 };
  const iw = W - MARGIN.left - MARGIN.right;
  const ih = H - MARGIN.top - MARGIN.bottom;

  const allDensities = traces.flatMap((t) => t.density);
  const allX = traces.flatMap((t) => t.x);
  const xMin = Math.min(...allX);
  const xMax = Math.max(...allX);
  const dMax = Math.max(...allDensities, 0.0001) * 1.1;

  const xScale = (v: number) => MARGIN.left + ((v - xMin) / (xMax - xMin)) * iw;
  const yScale = (v: number) => MARGIN.top + ih - (v / dMax) * ih;

  const gridLines = 5;
  const grid: string[] = [];
  for (let i = 0; i <= gridLines; i++) {
    const y = MARGIN.top + (ih / gridLines) * i;
    const val = dMax - (dMax / gridLines) * i;
    grid.push(`    <line x1="${MARGIN.left}" y1="${y}" x2="${MARGIN.left + iw}" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>`);
    grid.push(`    <text x="${MARGIN.left - 8}" y="${y + 4}" text-anchor="end" fill="#666" font-size="11">${val.toFixed(4)}</text>`);
  }

  const xTicks = 5;
  const xGrid: string[] = [];
  for (let i = 0; i <= xTicks; i++) {
    const x = xMin + ((xMax - xMin) / xTicks) * i;
    const sx = xScale(x);
    xGrid.push(`    <text x="${sx}" y="${MARGIN.top + ih + 16}" text-anchor="middle" fill="#666" font-size="11">${formatAxisLabel(x)}</text>`);
  }

  const traceElements = traces.map((t) => {
    const pts = t.x.map((xi, i) => ({ x: xScale(xi), y: yScale(t.density[i]) }));
    const curve = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");

    return [
      `  <g>`,
      `    <path d="${curve}" fill="none" stroke="${t.color}" stroke-width="2" stroke-linejoin="round"/>`,
      `  </g>`,
    ].join("\n");
  });

  const legendY = MARGIN.top + 4;
  const legendElements = traces.map((t, i) => {
    const ly = legendY + i * 20;
    const label = escapeXml(t.model.length > 28 ? t.model.slice(0, 25) + "…" : t.model);
    return [
      `  <rect x="${W - MARGIN.right + 8}" y="${ly}" width="12" height="12" fill="${t.color}" rx="1"/>`,
      `  <text x="${W - MARGIN.right + 24}" y="${ly + 10}" fill="#333" font-size="11">${label}</text>`,
    ].join("\n");
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">`,
    `  <rect width="100%" height="100%" fill="#ffffff"/>`,
    `  <text x="${MARGIN.left + iw / 2}" y="${H - 8}" text-anchor="middle" fill="#333" font-size="13">${escapeXml(xLabel)}</text>`,
    `  <text x="14" y="${MARGIN.top + ih / 2}" text-anchor="middle" fill="#333" font-size="13" transform="rotate(-90, 14, ${MARGIN.top + ih / 2})">Density</text>`,
    ...grid,
    ...xGrid,
    ...traceElements,
    ...legendElements,
    `</svg>`,
  ].join("\n");
}

function generateGroupedBarChartSvg(
  groups: { label: string; bars: { status: string; value: number }[] }[],
  yLabel: string,
  options?: { yDomain?: [number, number] },
): string {
  const W = 640, H = 320, MARGIN = { top: 20, right: 20, bottom: 90, left: 70 };
  const iw = W - MARGIN.left - MARGIN.right;
  const ih = H - MARGIN.top - MARGIN.bottom;

  const allVals = groups.flatMap((g) => g.bars.map((b) => b.value));
  const yMin = 0;
  const yMax = options?.yDomain?.[1] ?? Math.max(...allVals, 1) * 1.15;
  const yScale = (v: number) => MARGIN.top + ih - ((v - yMin) / (yMax - yMin)) * ih;

  const colors: Record<string, string> = {
    "this PR": "#4e79a7",
    baseline: "#e15759",
  };

  const n = groups.length;
  const subBars = Math.max(...groups.map((g) => g.bars.length));
  const bandW = iw / n;
  const subW = Math.min((bandW * 0.8) / subBars, 50);

  const gridLines = 5;
  const grid: string[] = [];
  for (let i = 0; i <= gridLines; i++) {
    const y = MARGIN.top + (ih / gridLines) * i;
    const val = yMax - (yMax - yMin) * (i / gridLines);
    grid.push(`    <line x1="${MARGIN.left}" y1="${y}" x2="${W - MARGIN.right}" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>`);
    grid.push(`    <text x="${MARGIN.left - 8}" y="${y + 4}" text-anchor="end" fill="#666" font-size="11">${(val * 100).toFixed(0)}%</text>`);
  }

  const groupElements = groups.map((g, gi) => {
    const groupX = MARGIN.left + gi * bandW;
    const totalSubW = g.bars.length * subW;
    const startX = groupX + (bandW - totalSubW) / 2;

    const bars = g.bars.map((b, bi) => {
      const x = startX + bi * subW;
      const y = yScale(b.value);
      const barH = yScale(0) - y;
      const color = colors[b.status] ?? "#999";
      return [
        `  <rect x="${x}" y="${y}" width="${subW - 2}" height="${Math.max(barH, 0)}" fill="${color}" rx="2"/>`,
        `  <text x="${x + (subW - 2) / 2}" y="${y - 4}" text-anchor="middle" fill="#333" font-size="10">${(b.value * 100).toFixed(0)}%</text>`,
      ].join("\n");
    });

    const label = escapeXml(g.label.length > 25 ? g.label.slice(0, 22) + "…" : g.label);
    const cx = groupX + bandW / 2;
    const txt = `  <text x="${cx}" y="${MARGIN.top + ih + 20}" text-anchor="end" transform="rotate(-30, ${cx}, ${MARGIN.top + ih + 20})" fill="#333" font-size="11">${label}</text>`;

    return [`<g>`, bars, txt, `</g>`].join("\n");
  });

  const legendEntries = Object.entries(colors).map(([status, color]) =>
    `<rect x="${W - MARGIN.right - 120 + 0}" y="${MARGIN.top + 4}" width="12" height="12" fill="${color}" rx="1"/><text x="${W - MARGIN.right - 120 + 18}" y="${MARGIN.top + 14}" fill="#333" font-size="11">${escapeXml(status)}</text>`,
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">`,
    `  <rect width="100%" height="100%" fill="#ffffff"/>`,
    `  <text x="${MARGIN.left - 40}" y="${MARGIN.top + ih / 2}" text-anchor="middle" fill="#333" font-size="13" transform="rotate(-90, ${MARGIN.left - 40}, ${MARGIN.top + ih / 2})">${escapeXml(yLabel)}</text>`,
    ...grid,
    ...groupElements,
    `  <g transform="translate(${W - MARGIN.right - 140}, 0)">`,
    ...legendEntries.map((e) => `  ${e}`),
    `  </g>`,
    `</svg>`,
  ].join("\n");
}

function writeSvg(filename: string, svg: string): void {
  const chartsDir = projectPath("charts");
  mkdirSync(chartsDir, { recursive: true });
  writeFileSync(join(chartsDir, filename), svg, "utf-8");
}

function main(): void {
  const sha = gitSha();
  console.error(`evaluate: SHA=${sha}`);

  const results = findLatestResults();
  if (!results) {
    console.error("evaluate: no results found in tests/benchmark/.results/");
    process.exit(1);
  }
  console.error(`evaluate: loaded results from ${results.timestamp}`);

  const metrics = computeMetrics(results);
  const baseline = loadBaseline();
  console.error(`evaluate: baseline=${baseline ? `loaded from ${baseline.sha}` : "none"}`);

  const baselineMap = baseline?.models ?? {};

  // ─── Extract raw data per model ──────────────────────────────

  const byModel = new Map<string, { wallMsValues: number[]; tokenValues: number[] }>();
  for (const trial of results.trials) {
    if (!trial.ok) continue;
    const bucket = byModel.get(trial.model) ?? { wallMsValues: [], tokenValues: [] };
    bucket.wallMsValues.push(trial.spawnWallMs);
    const calls = trial.report?.calls ?? [];
    bucket.tokenValues.push(calls.reduce((sum, c) => sum + (c.usage?.totalTokens ?? 0), 0));
    byModel.set(trial.model, bucket);
  }
  const modelEntries = Array.from(byModel.entries());

  // ─── Generate KDE plots ──────────────────────────────────────

  const wallDataSets = modelEntries.map(([, data]) => data.wallMsValues);
  const wallGrid = buildSharedGrid(wallDataSets, 200);
  const wallTraces = modelEntries.map(([model, data], i) => ({
    model,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
    x: wallGrid,
    density: computeKdeOnGrid(data.wallMsValues, wallGrid),
  }));
  writeSvg("wall-clock.svg", generateKdePlotSvg(wallTraces, "Wall Clock (ms)"));

  const tokenDataSets = modelEntries.map(([, data]) => data.tokenValues);
  const tokenGrid = buildSharedGrid(tokenDataSets, 200);
  const tokenTraces = modelEntries.map(([model, data], i) => ({
    model,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
    x: tokenGrid,
    density: computeKdeOnGrid(data.tokenValues, tokenGrid),
  }));
  writeSvg("token-usage.svg", generateKdePlotSvg(tokenTraces, "Total Tokens"));

  // ─── Generate success rate grouped bar chart ─────────────────

  const successGroups = metrics.map((m) => {
    const bars = [{ status: "current", value: m.successRate }];
    const bl = baselineMap[m.model];
    if (bl) bars.push({ status: "baseline", value: bl.successRate });
    return { label: m.model, bars };
  });
  writeSvg("success-rate.svg", generateGroupedBarChartSvg(successGroups, "Success Rate", { yDomain: [0, 1] }));

  // ─── Build report.md ─────────────────────────────────────────

  const baselineLabel = baseline
    ? `\`${baseline.sha}\` from ${baseline.timestamp.slice(0, 10)}`
    : "none (seed by running the evaluation workflow on the default branch)";
  const scenarioLabel = scenarioSummary(results.config);
  const trialsPerModel = results.config.trialsPerModel;

  const lines: string[] = [
    "## Prompt Evaluation",
    "",
    `**SHA:** \`${sha}\` · **Baseline:** ${baselineLabel} · **${scenarioLabel} · ${trialsPerModel} trials/model**`,
    "",
    "| Model | Success | Wall p50 / p95 | Tokens p50 / p95 | Δ Rate | Δ Wall | Δ Tokens |",
    "|-------|:-------:|:--------------:|:----------------:|:------:|:------:|:--------:|",
  ];

  for (const m of metrics) {
    const bl = baselineMap[m.model];
    const rateDelta = bl ? fmtDeltaPct(m.successRate, bl.successRate) : "—";
    const wallDelta = bl ? fmtDelta(m.wallMs.p50, bl.wallMs.p50) : "—";
    const tokenDelta = bl ? fmtDelta(m.totalTokens.p50, bl.totalTokens.p50) : "—";
    lines.push(
      `| ${m.model} | ${fmtPct(m.successRate)} (${m.successes}/${m.trials}) | ${fmtMs(m.wallMs.p50)} / ${fmtMs(m.wallMs.p95)} | ${m.totalTokens.p50.toFixed(0)} / ${m.totalTokens.p95.toFixed(0)} | ${rateDelta} | ${wallDelta} | ${tokenDelta} |`,
    );
  }

  lines.push(
    "",
    "<details>",
    "<summary>📈 Charts</summary>",
    "",
    "#### Wall Clock",
    "",
    "![Wall clock](./charts/wall-clock.svg)",
    "",
    "#### Token Usage",
    "",
    "![Token usage](./charts/token-usage.svg)",
    "",
    "#### Success Rate",
    "",
    "![Success rate](./charts/success-rate.svg)",
    "",
    "</details>",
    "",
    "---",
    "",
    `*Evaluated by OpenCode at ${new Date().toISOString()}.*`,
    "",
  );

  writeFileSync(projectPath("report.md"), lines.join("\n"), "utf-8");
  console.error("evaluate: wrote report.md");

  // ─── Write metrics.json for future baselines ─────────────────

  const metricsRecord: Record<string, ModelMetrics> = {};
  for (const m of metrics) {
    metricsRecord[m.model] = m;
  }
  const out: BaselineMetrics = {
    sha,
    timestamp: new Date().toISOString(),
    models: metricsRecord,
  };
  writeFileSync(projectPath("metrics.json"), JSON.stringify(out, null, 2), "utf-8");
  console.error("evaluate: wrote metrics.json");
}

main();
