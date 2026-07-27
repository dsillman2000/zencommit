import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ────────────────────────────────────────────────────────

export interface ModelRow {
  modelId: string;
  inputPrice: string;
  outputPrice: string;
  variants: string[];
  defaultVariant?: string;
}

export interface Cost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ReasoningOption {
  type: "toggle" | "effort";
  values?: string[];
}

export interface ModelMetadata {
  id: string;
  name: string;
  family: string;
  reasoning: boolean;
  reasoningOptions: ReasoningOption[];
  variants: string[];
  defaultVariant?: string;
  cost: Cost;
}

interface ModelCache {
  timestamp: number;
  models: Record<string, ModelMetadata>;
}

interface ApiModel {
  id: string;
}

interface ModelsDevCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

interface ModelsDevModel {
  id: string;
  name?: string;
  family?: string;
  reasoning?: boolean;
  reasoning_options?: ReasoningOption[];
  cost?: ModelsDevCost;
}

// ─── Cache ────────────────────────────────────────────────────────

const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const cacheDirPath = join(configDir, "zencommit");
let cacheFilePath = join(cacheDirPath, "models-cache.json");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** @internal Replace the cache file path for testing. */
export function __setCacheFilePath(path: string): string {
  const prev = cacheFilePath;
  cacheFilePath = path;
  return prev;
}

function isValidModelCache(cache: unknown): cache is ModelCache {
  if (typeof cache !== "object" || cache === null) return false;
  const c = cache as Record<string, unknown>;
  if (typeof c.timestamp !== "number") return false;
  if (typeof c.models !== "object" || c.models === null) return false;
  const models = c.models as Record<string, unknown>;
  if (Object.keys(models).length === 0) return false;
  for (const meta of Object.values(models)) {
    if (typeof meta !== "object" || meta === null) return false;
    const m = meta as Record<string, unknown>;
    if (typeof m.id !== "string") return false;
    if (typeof m.family !== "string") return false;
    if (typeof m.reasoning !== "boolean") return false;
    if (!Array.isArray(m.reasoningOptions)) return false;
    if (!Array.isArray(m.variants)) return false;
    const cost = m.cost;
    if (typeof cost !== "object" || cost === null) return false;
    const co = cost as Record<string, unknown>;
    if (typeof co.input !== "number") return false;
    if (typeof co.output !== "number") return false;
  }
  return true;
}

async function loadCache(): Promise<ModelCache | null> {
  try {
    const raw = await readFile(cacheFilePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isValidModelCache(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveCache(models: Record<string, ModelMetadata>): Promise<void> {
  const cache: ModelCache = { timestamp: Date.now(), models };
  await mkdir(cacheDirPath, { recursive: true });
  await writeFile(cacheFilePath, JSON.stringify(cache));
}

function isCacheFresh(cache: ModelCache): boolean {
  const age = Date.now() - cache.timestamp;
  if (age < 0) return false;
  if (Object.keys(cache.models).length < 10) return false;
  return age < CACHE_TTL_MS;
}

// ─── Fetchers ─────────────────────────────────────────────────────

const ZEN_API = "https://opencode.ai/zen/v1/models";
const MODELS_DEV_API = "https://models.dev/api.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchFn: typeof fetch = (...args) => (globalThis.fetch as any)(...args);

/** @internal Replace the fetch implementation for testing. */
export function __setFetch(fn: typeof fetch): typeof fetch {
  const prev = fetchFn;
  fetchFn = fn;
  return prev;
}

/**
 * Fetches the list of available model IDs from the OpenCode Zen API.
 */
export async function fetchModelIds(): Promise<string[]> {
  const res = await fetchFn(ZEN_API);
  if (!res.ok) {
    throw new Error(`failed to fetch models from Zen API: ${res.status}`);
  }
  const body = await res.json() as { data: ApiModel[] };
  return (body.data ?? []).map((m) => m.id);
}

/** Builds a flat list of variant names from models.dev reasoning_options. */
export function buildVariantsFromOptions(
  reasoningOptions: ReasoningOption[],
): string[] {
  if (reasoningOptions.length === 0) {
    return ["default"];
  }
  const toggle = reasoningOptions.find((o) => o.type === "toggle");
  const effort = reasoningOptions.find((o) => o.type === "effort");

  if (toggle && effort) {
    return ["off", ...(effort.values ?? [])];
  }
  if (effort) {
    return effort.values ?? [];
  }
  if (toggle) {
    return ["off", "on"];
  }
  return ["default"];
}

function extractModelMetadata(raw: ModelsDevModel): ModelMetadata | undefined {
  if (!raw.cost) {
    return undefined;
  }
  const reasoningOptions = raw.reasoning_options ?? [];
  const variants = buildVariantsFromOptions(reasoningOptions);
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    family: raw.family ?? "",
    reasoning: raw.reasoning ?? false,
    reasoningOptions,
    variants,
    defaultVariant: variants[0],
    cost: {
      input: raw.cost.input,
      output: raw.cost.output,
      cacheRead: raw.cost.cache_read,
      cacheWrite: raw.cost.cache_write,
    },
  };
}

/**
 * Fetches full model metadata (pricing + reasoning variants) from models.dev
 * and caches it locally.
 *
 * Returns cached data if it is fresh (< 6 hours old).  When the cache
 * is stale or missing the full models.dev API is fetched and the
 * OpenCode Zen section is extracted.  If the network request fails
 * but stale cache exists, the stale cache is returned as a fallback.
 */
export async function fetchModelMetadata(): Promise<Map<string, ModelMetadata>> {
  const cached = await loadCache();
  if (cached && isCacheFresh(cached)) {
    return new Map(Object.entries(cached.models));
  }

  try {
    const res = await fetchFn(MODELS_DEV_API);
    if (!res.ok) {
      throw new Error(`models.dev API returned ${res.status}`);
    }
    const body = await res.json() as Record<string, { models?: Record<string, ModelsDevModel> }>;
    const opencodeModels = body.opencode?.models;
    if (!opencodeModels) {
      throw new Error("opencode section not found in models.dev data");
    }

    const models: Record<string, ModelMetadata> = {};
    for (const [id, model] of Object.entries(opencodeModels)) {
      const meta = extractModelMetadata(model);
      if (meta) {
        models[id] = meta;
      }
    }

    await saveCache(models).catch(() => {});
    return new Map(Object.entries(models));
  } catch (err) {
    if (cached) {
      return new Map(Object.entries(cached.models));
    }
    throw err;
  }
}

/**
 * Fetches pricing data from the shared model cache.
 *
 * Thin wrapper around {@link fetchModelMetadata} that returns only cost.
 */
export async function fetchPricingMap(): Promise<Map<string, Cost>> {
  const metadata = await fetchModelMetadata();
  const costs = new Map<string, Cost>();
  for (const [id, meta] of metadata) {
    costs.set(id, meta.cost);
  }
  return costs;
}

// ─── Pure helpers ─────────────────────────────────────────────────

function formatPrice(price: number): string {
  if (price === 0) return "Free";
  if (Number.isInteger(price)) return `$${price}.00`;
  return `$${price.toFixed(2)}`;
}

/**
 * Joins model IDs from the Zen API with metadata from models.dev and
 * returns rows sorted alphabetically by model ID.
 */
export function buildModelsTable(
  modelIds: string[],
  metadata: Map<string, ModelMetadata>,
): ModelRow[] {
  const sorted = [...modelIds].sort();
  return sorted.map((id) => {
    const meta = metadata.get(id);
    return {
      modelId: id,
      inputPrice: meta ? formatPrice(meta.cost.input) : "\u2014",
      outputPrice: meta ? formatPrice(meta.cost.output) : "\u2014",
      variants: meta?.variants ?? [],
      defaultVariant: meta?.defaultVariant,
    };
  });
}

/**
 * Formats model rows into a compact, right-padded table string.
 *
 * The Variants column is rendered as one variant per line; the default
 * variant is marked with " (default)".
 */
export function formatTable(rows: ModelRow[]): string {
  if (rows.length === 0) return "(no models)";

  const idWidth = Math.max(...rows.map((r) => r.modelId.length), 9);
  const priceWidth = 10;
  const headerId = "Model ID".padEnd(idWidth);
  const sep = "\u2500".repeat(idWidth + priceWidth * 2 + 28);
  const lines: string[] = [
    `${headerId}  ${"Input/1M".padStart(priceWidth)}  ${"Output/1M".padStart(priceWidth)}  Variants`,
    sep,
  ];

  const variantPad = idWidth + priceWidth * 2 + 6;

  for (const r of rows) {
    const firstVariant = r.variants[0];
    const variantLabel = firstVariant
      ? firstVariant === r.defaultVariant
        ? `${firstVariant} (default)`
        : firstVariant
      : "\u2014";
    lines.push(
      `${r.modelId.padEnd(idWidth)}  ${r.inputPrice.padStart(priceWidth)}  ${r.outputPrice.padStart(priceWidth)}  ${variantLabel}`,
    );
    for (let i = 1; i < r.variants.length; i++) {
      const v = r.variants[i];
      const label = v === r.defaultVariant ? `${v} (default)` : v;
      lines.push(`${" ".repeat(variantPad)}${label}`);
    }
  }
  return lines.join("\n");
}

// ─── Orchestrator ─────────────────────────────────────────────────

/**
 * Builds the formatted table string for the given model list and
 * metadata map. Pure function — does no I/O — extracted so the output
 * formatting can be unit-tested in isolation.
 */
export function printModelsList(
  modelIds: string[],
  metadata: Map<string, ModelMetadata>,
): string {
  const rows = buildModelsTable(modelIds, metadata);
  return formatTable(rows);
}

/**
 * Fetches the current OpenCode Zen model list and metadata, then
 * prints a compact table to stdout.
 */
export async function listModels(): Promise<void> {
  const [modelIds, metadata] = await Promise.all([
    fetchModelIds(),
    fetchModelMetadata(),
  ]);
  console.log(printModelsList(modelIds, metadata));
}
