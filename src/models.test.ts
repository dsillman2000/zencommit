import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  mkdtemp,
  rm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildModelsTable,
  buildVariantsFromOptions,
  fetchModelIds,
  fetchModelMetadata,
  fetchPricingMap,
  formatTable,
  listModels,
  printModelsList,
  __setCacheFilePath,
  __setFetch,
  type ModelMetadata,
} from "./models.js";

function makeMeta(
  id: string,
  input: number,
  output: number,
  variants: string[] = ["default"],
): ModelMetadata {
  return {
    id,
    name: id,
    family: id,
    reasoning: variants.length > 1 || variants[0] !== "default",
    reasoningOptions: [],
    variants,
    defaultVariant: variants[0],
    cost: { input, output },
  };
}

describe("buildVariantsFromOptions", () => {
  it("returns ['default'] for empty options", () => {
    expect(buildVariantsFromOptions([])).toEqual(["default"]);
  });

  it("returns ['off', 'on'] for toggle-only options", () => {
    expect(buildVariantsFromOptions([{ type: "toggle" }])).toEqual([
      "off",
      "on",
    ]);
  });

  it("returns effort values for effort-only options", () => {
    expect(
      buildVariantsFromOptions([
        { type: "effort", values: ["minimal", "low", "high"] },
      ]),
    ).toEqual(["minimal", "low", "high"]);
  });

  it("combines off with effort values when both toggle and effort exist", () => {
    expect(
      buildVariantsFromOptions([
        { type: "toggle" },
        { type: "effort", values: ["high", "max"] },
      ]),
    ).toEqual(["off", "high", "max"]);
  });
});

describe("buildModelsTable", () => {
  const metadata = new Map<string, ModelMetadata>([
    [
      "deepseek-v4-flash",
      makeMeta("deepseek-v4-flash", 0.14, 0.28, ["off", "high", "max"]),
    ],
    ["claude-fable-5", makeMeta("claude-fable-5", 10, 50)],
    ["big-pickle", makeMeta("big-pickle", 0, 0)],
    ["gpt-5.4-mini", makeMeta("gpt-5.4-mini", 0.75, 4.5)],
  ]);

  it("returns rows sorted alphabetically by model ID", () => {
    const ids = [
      "gpt-5.4-mini",
      "claude-fable-5",
      "big-pickle",
      "deepseek-v4-flash",
    ];
    const rows = buildModelsTable(ids, metadata);
    expect(rows.map((r) => r.modelId)).toEqual([
      "big-pickle",
      "claude-fable-5",
      "deepseek-v4-flash",
      "gpt-5.4-mini",
    ]);
  });

  it("formats paid prices with dollar sign and two decimals", () => {
    const rows = buildModelsTable(["deepseek-v4-flash"], metadata);
    expect(rows[0].inputPrice).toBe("$0.14");
    expect(rows[0].outputPrice).toBe("$0.28");
  });

  it("formats integer prices with .00", () => {
    const rows = buildModelsTable(["claude-fable-5"], metadata);
    expect(rows[0].inputPrice).toBe("$10.00");
    expect(rows[0].outputPrice).toBe("$50.00");
  });

  it("formats free models as 'Free'", () => {
    const rows = buildModelsTable(["big-pickle"], metadata);
    expect(rows[0].inputPrice).toBe("Free");
    expect(rows[0].outputPrice).toBe("Free");
  });

  it("uses em-dash for models without metadata info", () => {
    const rows = buildModelsTable(["unknown-model"], metadata);
    expect(rows[0].inputPrice).toBe("\u2014");
    expect(rows[0].outputPrice).toBe("\u2014");
    expect(rows[0].variants).toEqual([]);
  });

  it("handles empty model ID list", () => {
    const rows = buildModelsTable([], metadata);
    expect(rows).toEqual([]);
  });

  it("does not mutate the input modelIds array", () => {
    const ids = ["zzz", "aaa", "mmm"];
    const original = [...ids];
    buildModelsTable(ids, new Map());
    expect(ids).toEqual(original);
  });
});

describe("formatTable", () => {
  it("returns placeholder for empty rows", () => {
    expect(formatTable([])).toBe("(no models)");
  });

  it("includes a header row and separator", () => {
    const rows = buildModelsTable(
      ["a"],
      new Map([["a", makeMeta("a", 1, 2)]]),
    );
    const output = formatTable(rows);
    expect(output).toContain("Model ID");
    expect(output).toContain("Input/1M");
    expect(output).toContain("Output/1M");
    expect(output).toContain("Variants");
  });

  it("includes price and variant values in output", () => {
    const rows = buildModelsTable(
      ["m1"],
      new Map([["m1", makeMeta("m1", 0.14, 0.28, ["off", "high"])]]),
    );
    const table = formatTable(rows);
    expect(table).toContain("$0.14");
    expect(table).toContain("$0.28");
    expect(table).toContain("off (default)");
    expect(table).toContain("high");
  });

  it("includes Free in the output", () => {
    const rows = buildModelsTable(
      ["free-model"],
      new Map([["free-model", makeMeta("free-model", 0, 0)]]),
    );
    expect(formatTable(rows)).toContain("Free");
  });

  it("includes em-dash for unknown models", () => {
    const rows = buildModelsTable(["unknown"], new Map());
    expect(formatTable(rows)).toContain("\u2014");
  });
});

describe("printModelsList", () => {
  it("returns formatted table given model IDs and metadata", () => {
    const metaMap = new Map([["a", makeMeta("a", 0.14, 0.28)]]);
    expect(printModelsList(["a"], metaMap)).toBe(
      formatTable(buildModelsTable(["a"], metaMap)),
    );
  });

  it("returns '(no models)' when given empty model list", () => {
    expect(printModelsList([], new Map())).toBe("(no models)");
  });
});

// ─── fetchModelIds ─────────────────────────────────────────────────

const ZEN_MODELS_RESPONSE = {
  data: [
    { id: "big-pickle" },
    { id: "deepseek-v4-flash" },
    { id: "claude-sonnet-4" },
  ],
};

function zenOk(body: unknown = ZEN_MODELS_RESPONSE): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function zenFail(status = 500): Response {
  return new Response("boom", { status });
}

describe("fetchModelIds", () => {
  let prevFetch: ReturnType<typeof __setFetch>;

  beforeEach(() => {
    prevFetch = __setFetch(
      () => Promise.resolve(zenOk()) as unknown as Promise<Response>,
    );
  });

  afterEach(() => {
    __setFetch(prevFetch);
  });

  it("returns the list of model IDs from data array", async () => {
    const ids = await fetchModelIds();
    expect(ids).toEqual(["big-pickle", "deepseek-v4-flash", "claude-sonnet-4"]);
  });

  it("returns empty array when data is missing", async () => {
    __setFetch(() => Promise.resolve(zenOk({})) as unknown as Promise<Response>);
    const ids = await fetchModelIds();
    expect(ids).toEqual([]);
  });

  it("throws on non-OK response", async () => {
    __setFetch(() => Promise.resolve(zenFail(503)) as unknown as Promise<Response>);
    await expect(fetchModelIds()).rejects.toThrow(
      /failed to fetch models from Zen API: 503/,
    );
  });
});

// ─── fetchModelMetadata & fetchPricingMap ─────────────────────────

const MODELS_DEV_RESPONSE = {
  opencode: {
    models: {
      "big-pickle": { id: "big-pickle", cost: { input: 0, output: 0 } },
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        family: "deepseek-flash",
        reasoning: true,
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["high", "max"] },
        ],
        cost: { input: 0.14, output: 0.28 },
      },
      "no-cost-model": { id: "no-cost-model" },
    },
  },
};

function modelsDevOk(body: unknown = MODELS_DEV_RESPONSE): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchModelMetadata", () => {
  let tmpDir: string;
  let cachePath: string;
  let prevCachePath: string;
  let prevFetch: ReturnType<typeof __setFetch>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "zc-models-test-"));
    cachePath = join(tmpDir, "models-cache.json");
    prevCachePath = __setCacheFilePath(cachePath);
    prevFetch = __setFetch(
      () => Promise.resolve(modelsDevOk()) as unknown as Promise<Response>,
    );
  });

  afterEach(async () => {
    __setCacheFilePath(prevCachePath);
    __setFetch(prevFetch);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns fresh cache without making network requests", async () => {
    const models: Record<string, ModelMetadata> = {};
    for (let i = 0; i < 10; i++) {
      const id = `m-${i}`;
      models[id] = makeMeta(id, i, i * 2);
    }
    const cached = { timestamp: Date.now(), models };
    await fsWriteFile(cachePath, JSON.stringify(cached), "utf-8");

    const spy = jest.fn(
      () => Promise.resolve(modelsDevOk()) as unknown as Promise<Response>,
    );
    __setFetch(spy as never);

    const map = await fetchModelMetadata();
    expect(map.size).toBe(10);
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-fetches when cache is stale", async () => {
    const staleModels: Record<string, ModelMetadata> = {
      old: makeMeta("old", 99, 99),
    };
    const stale = {
      timestamp: Date.now() - 7 * 60 * 60 * 1000,
      models: staleModels,
    };
    await fsWriteFile(cachePath, JSON.stringify(stale), "utf-8");

    const map = await fetchModelMetadata();
    expect(map.has("old")).toBe(false);
    expect(map.get("big-pickle")).toBeDefined();
    expect(map.get("deepseek-v4-flash")?.variants).toEqual([
      "off",
      "high",
      "max",
    ]);
  });

  it("fetches and caches when no cache file exists", async () => {
    const map = await fetchModelMetadata();
    expect(map.get("big-pickle")).toBeDefined();
    expect(map.get("deepseek-v4-flash")).toBeDefined();
    expect(map.has("no-cost-model")).toBe(false);
  });

  it("fetchPricingMap returns cost map derived from metadata", async () => {
    const pricingMap = await fetchPricingMap();
    expect(pricingMap.get("big-pickle")).toEqual({ input: 0, output: 0 });
    expect(pricingMap.get("deepseek-v4-flash")).toEqual({
      input: 0.14,
      output: 0.28,
      cacheRead: undefined,
      cacheWrite: undefined,
    });
  });

  it("falls back to stale cache when network fails", async () => {
    const staleModels: Record<string, ModelMetadata> = {
      "big-pickle": makeMeta("big-pickle", 7, 11),
    };
    const stale = {
      timestamp: Date.now() - 7 * 60 * 60 * 1000,
      models: staleModels,
    };
    await fsWriteFile(cachePath, JSON.stringify(stale), "utf-8");
    __setFetch(
      () => Promise.reject(new Error("network down")) as unknown as Promise<Response>,
    );

    const map = await fetchModelMetadata();
    expect(map.get("big-pickle")?.cost).toEqual({ input: 7, output: 11 });
  });

  it("rethrows network error when no cache exists", async () => {
    __setFetch(
      () => Promise.reject(new Error("network down")) as unknown as Promise<Response>,
    );
    await expect(fetchModelMetadata()).rejects.toThrow("network down");
  });
});

// ─── listModels ────────────────────────────────────────────────────

describe("listModels", () => {
  let prevFetch: ReturnType<typeof __setFetch>;

  beforeEach(() => {
    prevFetch = __setFetch(
      () =>
        Promise.reject(
          new Error("should not be called directly"),
        ) as unknown as Promise<Response>,
    );
  });

  afterEach(() => {
    __setFetch(prevFetch);
  });

  it("orchestrates fetchModelIds + fetchModelMetadata and prints table", async () => {
    const fetchSpy = jest.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("opencode.ai")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "big-pickle" }, { id: "deepseek-v4-flash" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          opencode: {
            models: {
              "big-pickle": { id: "big-pickle", cost: { input: 0, output: 0 } },
              "deepseek-v4-flash": {
                id: "deepseek-v4-flash",
                cost: { input: 0.14, output: 0.28 },
                reasoning_options: [{ type: "toggle" }],
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    __setFetch(fetchSpy as never);

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await listModels();

    expect(fetchSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0][0] as string;
    expect(printed).toContain("big-pickle");
    expect(printed).toContain("deepseek-v4-flash");
    expect(printed).toContain("Free");
    expect(printed).toContain("$0.14");
    expect(printed).toContain("off (default)");

    logSpy.mockRestore();
  });
});
