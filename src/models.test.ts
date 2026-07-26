import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
  afterAll,
} from "@jest/globals";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildModelsTable,
  fetchModelIds,
  fetchPricingMap,
  formatTable,
  listModels,
  printModelsList,
  __setCacheFilePath,
  __setFetch,
  type ModelRow,
} from "./models.js";

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

  it("includes the em-dash for unknown pricing in the output", () => {
    const rows = buildModelsTable(["unknown"], new Map());
    expect(formatTable(rows)).toContain("\u2014");
  });

  it("widens columns to fit the longest model ID", () => {
    const longId = "this-is-a-very-long-model-id-name";
    const rows: ModelRow[] = [{ modelId: longId, inputPrice: "Free", outputPrice: "Free" }];
    expect(formatTable(rows)).toContain(longId);
  });
});

describe("printModelsList", () => {
  it("returns the formatted table given model IDs and pricing", () => {
    const pricing = new Map<string, { input: number; output: number }>([
      ["a", { input: 0.14, output: 0.28 }],
    ]);
    expect(printModelsList(["a"], pricing)).toBe(formatTable(buildModelsTable(["a"], pricing)));
  });

  it("returns '(no models)' when given an empty model list", () => {
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
    prevFetch = __setFetch(() => Promise.resolve(zenOk()) as unknown as Promise<Response>);
  });

  afterEach(() => {
    __setFetch(prevFetch);
  });

  it("returns the list of model IDs from data array", async () => {
    const ids = await fetchModelIds();
    expect(ids).toEqual(["big-pickle", "deepseek-v4-flash", "claude-sonnet-4"]);
  });

  it("returns an empty array when data is missing", async () => {
    __setFetch(() => Promise.resolve(zenOk({})) as unknown as Promise<Response>);
    const ids = await fetchModelIds();
    expect(ids).toEqual([]);
  });

  it("returns an empty array when data is explicitly null", async () => {
    __setFetch(() => Promise.resolve(zenOk({ data: null })) as unknown as Promise<Response>);
    const ids = await fetchModelIds();
    expect(ids).toEqual([]);
  });

  it("throws on non-OK response including the HTTP status", async () => {
    __setFetch(() => Promise.resolve(zenFail(503)) as unknown as Promise<Response>);
    await expect(fetchModelIds()).rejects.toThrow(/failed to fetch models from Zen API: 503/);
  });

  it("rejects on network failure", async () => {
    __setFetch(() => Promise.reject(new Error("ECONNREFUSED")) as unknown as Promise<Response>);
    await expect(fetchModelIds()).rejects.toThrow("ECONNREFUSED");
  });

  it("calls the configured fetch implementation", async () => {
    const spy = jest.fn(() => Promise.resolve(zenOk()) as unknown as Promise<Response>);
    __setFetch(spy as never);
    await fetchModelIds();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("https://opencode.ai/zen/v1/models");
  });
});

// ─── fetchPricingMap ───────────────────────────────────────────────

const MODELS_DEV_RESPONSE = {
  opencode: {
    models: {
      "big-pickle": { id: "big-pickle", cost: { input: 0, output: 0 } },
      "deepseek-v4-flash": { id: "deepseek-v4-flash", cost: { input: 0.14, output: 0.28 } },
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

function modelsDevFail(status = 500): Response {
  return new Response("boom", { status });
}

describe("fetchPricingMap", () => {
  let tmpDir: string;
  let cachePath: string;
  let prevCachePath: string;
  let prevFetch: ReturnType<typeof __setFetch>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "zc-models-test-"));
    cachePath = join(tmpDir, "models-cache.json");
    prevCachePath = __setCacheFilePath(cachePath);
    prevFetch = __setFetch(() => Promise.resolve(modelsDevOk()) as unknown as Promise<Response>);
  });

  afterEach(async () => {
    __setCacheFilePath(prevCachePath);
    __setFetch(prevFetch);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a fresh cache without making any network request", async () => {
    const cached = {
      timestamp: Date.now(),
      models: {
        "big-pickle": { input: 0, output: 0 },
        "deepseek-v4-flash": { input: 0.14, output: 0.28 },
        "model-00": { input: 0, output: 0 },
        "model-01": { input: 1, output: 2 },
        "model-02": { input: 2, output: 4 },
        "model-03": { input: 3, output: 6 },
        "model-04": { input: 4, output: 8 },
        "model-05": { input: 5, output: 10 },
        "model-06": { input: 6, output: 12 },
        "model-07": { input: 7, output: 14 },
      },
    };
    await fsWriteFile(cachePath, JSON.stringify(cached), "utf-8");

    const spy = jest.fn(() => Promise.resolve(modelsDevOk()) as unknown as Promise<Response>);
    __setFetch(spy as never);

    const map = await fetchPricingMap();
    expect(map.get("big-pickle")).toEqual({ input: 0, output: 0 });
    expect(map.get("deepseek-v4-flash")).toEqual({ input: 0.14, output: 0.28 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-fetches and re-saves when cache is stale", async () => {
    const stale = {
      timestamp: Date.now() - (7 * 60 * 60 * 1000),
      models: { old: { input: 99, output: 99 } },
    };
    await fsWriteFile(cachePath, JSON.stringify(stale), "utf-8");

    const map = await fetchPricingMap();
    expect(map.has("old")).toBe(false);
    expect(map.get("big-pickle")).toEqual({ input: 0, output: 0 });
    expect(map.get("deepseek-v4-flash")).toEqual({ input: 0.14, output: 0.28 });

    const refreshed = JSON.parse(await readFile(cachePath, "utf-8"));
    expect(refreshed.models["big-pickle"]).toEqual({ input: 0, output: 0 });
    expect(refreshed.models["no-cost-model"]).toBeUndefined();
    expect(refreshed.timestamp).toBeGreaterThan(stale.timestamp);
  });

  it("fetches and caches when there is no cache file", async () => {
    const map = await fetchPricingMap();
    expect(map.get("big-pickle")).toEqual({ input: 0, output: 0 });
    expect(map.get("deepseek-v4-flash")).toEqual({ input: 0.14, output: 0.28 });
    expect(map.has("no-cost-model")).toBe(false);
  });

  it("omits models without a cost field", async () => {
    const map = await fetchPricingMap();
    expect(map.has("no-cost-model")).toBe(false);
  });

  it("throws when the response body is missing the opencode.models section", async () => {
    __setFetch(() => Promise.resolve(modelsDevOk({})) as unknown as Promise<Response>);
    await expect(fetchPricingMap()).rejects.toThrow(/opencode section not found/);
  });

  it("throws on non-OK response from models.dev", async () => {
    __setFetch(() => Promise.resolve(modelsDevFail(502)) as unknown as Promise<Response>);
    await expect(fetchPricingMap()).rejects.toThrow(/models.dev API returned 502/);
  });

  it("falls back to stale cache when the network fetch fails", async () => {
    const stale = {
      timestamp: Date.now() - (7 * 60 * 60 * 1000),
      models: { "big-pickle": { input: 7, output: 11 } },
    };
    await fsWriteFile(cachePath, JSON.stringify(stale), "utf-8");
    __setFetch(() => Promise.reject(new Error("network down")) as unknown as Promise<Response>);

    const map = await fetchPricingMap();
    expect(map.get("big-pickle")).toEqual({ input: 7, output: 11 });
  });

  it("rethrows the network error when no cache exists", async () => {
    __setFetch(() => Promise.reject(new Error("network down")) as unknown as Promise<Response>);
    await expect(fetchPricingMap()).rejects.toThrow("network down");
  });

  it("still returns fresh data when saveCache fails (error swallowed)", async () => {
    // Block the cache dir so saveCache's mkdir-recursive fails.
    await rm(tmpDir, { recursive: true, force: true });
    await fsWriteFile(tmpDir, "blocker", "utf-8");
    __setCacheFilePath(join(tmpDir, "models-cache.json"));

    const map = await fetchPricingMap();
    expect(map.get("big-pickle")).toEqual({ input: 0, output: 0 });
  });

  it("treats invalid JSON in cache as missing cache", async () => {
    await fsWriteFile(cachePath, "{not-json", "utf-8");
    const map = await fetchPricingMap();
    expect(map.get("big-pickle")).toEqual({ input: 0, output: 0 });
  });

  it("treats cache exactly past the 6h boundary as stale", async () => {
    const stale = {
      timestamp: Date.now() - (6 * 60 * 60 * 1000) - 100,
      models: { ghost: { input: 1, output: 1 } },
    };
    await fsWriteFile(cachePath, JSON.stringify(stale), "utf-8");
    const map = await fetchPricingMap();
    expect(map.has("ghost")).toBe(false);
  });
});

// ─── listModels ────────────────────────────────────────────────────

// ─── listModels ────────────────────────────────────────────────────

describe("listModels", () => {
  let prevFetch: ReturnType<typeof __setFetch>;

  beforeEach(() => {
    prevFetch = __setFetch(() => Promise.reject(new Error("should not be called directly")) as unknown as Promise<Response>);
  });

  afterEach(() => {
    __setFetch(prevFetch);
  });

  it("orchestrates fetchModelIds + fetchPricingMap and prints the formatted table", async () => {
    const pricing = new Map<string, { input: number; output: number }>();
    const fetchSpy = jest.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("opencode.ai")) {
        return new Response(
          JSON.stringify({ data: [{ id: "big-pickle" }, { id: "deepseek-v4-flash" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({
        opencode: {
          models: {
            "big-pickle": { id: "big-pickle", cost: { input: 0, output: 0 } },
            "deepseek-v4-flash": { id: "deepseek-v4-flash", cost: { input: 0.14, output: 0.28 } },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    __setFetch(fetchSpy as never);

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    pricing.set("deepseek-v4-flash", { input: 0.14, output: 0.28 });

    // Note: listModels itself does fetchModelIds + fetchPricingMap via real __setFetch.
    await listModels();

    expect(fetchSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0][0] as string;
    expect(printed).toContain("big-pickle");
    expect(printed).toContain("deepseek-v4-flash");
    expect(printed).toContain("Free");
    expect(printed).toContain("$0.14");

    logSpy.mockRestore();
  });

it("propagates fetchModelIds errors", async () => {
    __setFetch(() => Promise.reject(new Error("offline")) as unknown as Promise<Response>);
    await expect(listModels()).rejects.toThrow("offline");
  });
});

// ─── Hook round-trip ───────────────────────────────────────────────

describe("__setCacheFilePath / __setFetch", () => {
  afterAll(() => {
    // Reset to known defaults so future suites aren't contaminated.
    __setCacheFilePath("");
    __setFetch(((...a) => (globalThis.fetch as never)(...a)) as never);
  });

  it("__setCacheFilePath returns the previous path", () => {
    const prev = __setCacheFilePath("/tmp/x.json");
    expect(typeof prev).toBe("string");
  });

  it("__setFetch returns the previous fetch implementation", () => {
    const noop = (() => Promise.resolve(new Response(""))) as never;
    const prev = __setFetch(noop);
    expect(typeof prev).toBe("function");
  });
});
