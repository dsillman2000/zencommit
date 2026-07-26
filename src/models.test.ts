import { describe, it, expect } from "@jest/globals";
import { buildModelsTable, formatTable } from "./models.js";

describe("buildModelsTable", () => {
  const pricing = new Map([
    ["deepseek-v4-flash", { input: 0.14, output: 0.28 }],
    ["claude-fable-5", { input: 10, output: 50 }],
    ["big-pickle", { input: 0, output: 0 }],
    ["gpt-5.4-mini", { input: 0.75, output: 4.5 }],
  ]);

  it("returns rows sorted alphabetically by model ID", () => {
    const ids = ["gpt-5.4-mini", "claude-fable-5", "big-pickle", "deepseek-v4-flash"];
    const rows = buildModelsTable(ids, pricing);
    expect(rows.map((r) => r.modelId)).toEqual([
      "big-pickle",
      "claude-fable-5",
      "deepseek-v4-flash",
      "gpt-5.4-mini",
    ]);
  });

  it("formats paid prices with dollar sign and two decimals", () => {
    const rows = buildModelsTable(["deepseek-v4-flash"], pricing);
    expect(rows[0].inputPrice).toBe("$0.14");
    expect(rows[0].outputPrice).toBe("$0.28");
  });

  it("formats integer prices with .00", () => {
    const rows = buildModelsTable(["claude-fable-5"], pricing);
    expect(rows[0].inputPrice).toBe("$10.00");
    expect(rows[0].outputPrice).toBe("$50.00");
  });

  it("formats free models as 'Free'", () => {
    const rows = buildModelsTable(["big-pickle"], pricing);
    expect(rows[0].inputPrice).toBe("Free");
    expect(rows[0].outputPrice).toBe("Free");
  });

  it("uses em-dash for models without pricing info", () => {
    const rows = buildModelsTable(["unknown-model"], pricing);
    expect(rows[0].inputPrice).toBe("\u2014");
    expect(rows[0].outputPrice).toBe("\u2014");
  });

  it("handles empty model ID list", () => {
    const rows = buildModelsTable([], pricing);
    expect(rows).toEqual([]);
  });

  it("handles models without pricing in the map", () => {
    const rows = buildModelsTable(["claude-sonnet-4"], new Map());
    expect(rows[0].inputPrice).toBe("\u2014");
    expect(rows[0].outputPrice).toBe("\u2014");
  });
});

describe("formatTable", () => {
  it("returns placeholder for empty rows", () => {
    expect(formatTable([])).toBe("(no models)");
  });

  it("includes a header row and separator", () => {
    const rows = buildModelsTable(["a"], new Map([["a", { input: 1, output: 2 }]]));
    const output = formatTable(rows);
    expect(output).toContain("Model ID");
    expect(output).toContain("Input/1M");
    expect(output).toContain("Output/1M");
  });

  it("aligns columns with padding", () => {
    const rows = buildModelsTable(
      ["a", "longer-id"],
      new Map([
        ["a", { input: 1, output: 2 }],
        ["longer-id", { input: 0.5, output: 1.5 }],
      ]),
    );
    const output = formatTable(rows);
    const lines = output.split("\n");
    const dataLines = lines.slice(2);
    for (const line of dataLines) {
      expect(line.includes("  ")).toBe(true);
    }
  });

  it("includes price values in the output", () => {
    const rows = buildModelsTable(
      ["m1"],
      new Map([["m1", { input: 0.14, output: 0.28 }]]),
    );
    expect(formatTable(rows)).toContain("$0.14");
    expect(formatTable(rows)).toContain("$0.28");
  });

  it("includes Free in the output", () => {
    const rows = buildModelsTable(
      ["free-model"],
      new Map([["free-model", { input: 0, output: 0 }]]),
    );
    expect(formatTable(rows)).toContain("Free");
  });
});
