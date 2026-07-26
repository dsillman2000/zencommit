import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ────────────────────────────────────────────────────────

export interface ModelRow {
  modelId: string;
  inputPrice: string;
  outputPrice: string;
}

interface Cost {
  input: number;
  output: number;
}

interface PricingCache {
  timestamp: number;
  models: Record<string, Cost>;
}

interface ApiModel {
  id: string;
}

interface ModelsDevModel {
  id: string;
  cost?: Cost;
}

// ─── Cache ────────────────────────────────────────────────────────

const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const cacheDirPath = join(configDir, "zencommit");
const cacheFilePath = join(cacheDirPath, "models-cache.json");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function loadCache(): Promise<PricingCache | null> {
  try {
    const raw = await readFile(cacheFilePath, "utf-8");
    return JSON.parse(raw) as PricingCache;
  } catch {
    return null;
  }
}

async function saveCache(models: Record<string, Cost>): Promise<void> {
  const cache: PricingCache = { timestamp: Date.now(), models };
  await mkdir(cacheDirPath, { recursive: true });
  await writeFile(cacheFilePath, JSON.stringify(cache));
}

function isCacheFresh(cache: PricingCache): boolean {
  return Date.now() - cache.timestamp < CACHE_TTL_MS;
}

// ─── Fetchers ─────────────────────────────────────────────────────

const ZEN_API = "https://opencode.ai/zen/v1/models";
const MODELS_DEV_API = "https://models.dev/api.json";

/**
 * Fetches the list of available model IDs from the OpenCode Zen API.
 */
export async function fetchModelIds(): Promise<string[]> {
  const res = await fetch(ZEN_API);
  if (!res.ok) {
    throw new Error(`failed to fetch models from Zen API: ${res.status}`);
  }
  const body = await res.json() as { data: ApiModel[] };
  return (body.data ?? []).map((m) => m.id);
}

/**
 * Fetches pricing data from models.dev and caches it locally.
 *
 * Returns cached data if it is fresh (< 6 hours old).  When the cache
 * is stale or missing the full models.dev API is fetched and the
 * OpenCode Zen section is extracted.  If the network request fails
 * but stale cache exists, the stale cache is returned as a fallback.
 */
export async function fetchPricingMap(): Promise<Map<string, Cost>> {
  const cached = await loadCache();
  if (cached && isCacheFresh(cached)) {
    return new Map(Object.entries(cached.models));
  }

  try {
    const res = await fetch(MODELS_DEV_API);
    if (!res.ok) {
      throw new Error(`models.dev API returned ${res.status}`);
    }
    const body = await res.json() as Record<string, { models?: Record<string, ModelsDevModel> }>;
    const opencodeModels = body.opencode?.models;
    if (!opencodeModels) {
      throw new Error("opencode section not found in models.dev data");
    }

    const costs: Record<string, Cost> = {};
    for (const [id, model] of Object.entries(opencodeModels)) {
      if (model.cost) {
        costs[id] = model.cost;
      }
    }

    await saveCache(costs).catch(() => {});
    return new Map(Object.entries(costs));
  } catch (err) {
    if (cached) {
      return new Map(Object.entries(cached.models));
    }
    throw err;
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────

function formatPrice(price: number): string {
  if (price === 0) return "Free";
  if (Number.isInteger(price)) return `$${price}.00`;
  return `$${price.toFixed(2)}`;
}

/**
 * Joins model IDs from the Zen API with pricing from models.dev and
 * returns rows sorted alphabetically by model ID.
 */
export function buildModelsTable(
  modelIds: string[],
  pricing: Map<string, Cost>,
): ModelRow[] {
  const sorted = [...modelIds].sort();
  return sorted.map((id) => {
    const cost = pricing.get(id);
    return {
      modelId: id,
      inputPrice: cost ? formatPrice(cost.input) : "\u2014",
      outputPrice: cost ? formatPrice(cost.output) : "\u2014",
    };
  });
}

/**
 * Formats model rows into a compact, right-padded table string.
 */
export function formatTable(rows: ModelRow[]): string {
  if (rows.length === 0) return "(no models)";

  const idWidth = Math.max(...rows.map((r) => r.modelId.length), 9);
  const headerId = "Model ID".padEnd(idWidth);
  const sep = "\u2500".repeat(idWidth + 26);
  const lines: string[] = [
    `${headerId}  Input/1M    Output/1M`,
    sep,
  ];
  for (const r of rows) {
    lines.push(
      `${r.modelId.padEnd(idWidth)}  ${r.inputPrice.padStart(10)}  ${r.outputPrice.padStart(10)}`,
    );
  }
  return lines.join("\n");
}

// ─── Orchestrator ─────────────────────────────────────────────────

/**
 * Fetches the current OpenCode Zen model list and pricing, then
 * prints a compact table to stdout.
 */
export async function listModels(): Promise<void> {
  const [modelIds, pricing] = await Promise.all([
    fetchModelIds(),
    fetchPricingMap(),
  ]);
  const rows = buildModelsTable(modelIds, pricing);
  console.log(formatTable(rows));
}
