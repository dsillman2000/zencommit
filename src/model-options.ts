import type { ModelMetadata, ReasoningOption } from "./models.js";

/** Parsed model specifier such as `deepseek-v4-flash:high`. */
export interface ParsedModel {
  /** Base model ID without the variant suffix. */
  baseModel: string;
  /** Explicit variant, e.g. `high`, or `undefined` if none was supplied. */
  variant?: string;
}

/**
 * Splits a model name like `deepseek-v4-flash:high` into the base model ID
 * and an optional variant. A colon is used as the separator because model IDs
 * themselves do not contain colons.
 */
export function parseModelVariant(modelName: string): ParsedModel {
  const colonIndex = modelName.indexOf(":");
  if (colonIndex === -1) {
    return { baseModel: modelName };
  }
  const baseModel = modelName.slice(0, colonIndex);
  const variant = modelName.slice(colonIndex + 1);
  if (!baseModel || !variant) {
    throw new Error(`invalid model variant syntax: ${modelName}`);
  }
  return { baseModel, variant };
}

/**
 * Returns the default variant for a model. If the model is not in the
 * metadata cache, no variant is returned.
 */
export function getDefaultVariant(metadata: ModelMetadata | undefined): string | undefined {
  return metadata?.defaultVariant;
}

/**
 * Returns a human-readable list of valid variants for a model.
 */
export function formatVariants(metadata: ModelMetadata | undefined): string {
  if (!metadata || metadata.variants.length === 0) {
    return "(none)";
  }
  return metadata.variants
    .map((v) => (v === metadata.defaultVariant ? `${v} (default)` : v))
    .join(", ");
}

function getEffortOption(options: ReasoningOption[]): ReasoningOption | undefined {
  return options.find((o) => o.type === "effort");
}

function hasToggleOption(options: ReasoningOption[]): boolean {
  return options.some((o) => o.type === "toggle");
}

function isKnownVariant(metadata: ModelMetadata, variant: string): boolean {
  return metadata.variants.includes(variant);
}

/**
 * Builds the `providerOptions.zen` payload for a model/variant pair.
 *
 * Returns `undefined` when the model has no controllable reasoning settings.
 *
 * Family-specific transformers:
 * - DeepSeek V4 (`deepseek-*`): uses `thinking: { type }` plus `reasoningEffort`.
 * - OpenAI GPT (`gpt-*`): uses `reasoningEffort`.
 * - Fallback: effort → `reasoningEffort`, toggle → `thinking`.
 */
export function buildProviderOptions(
  metadata: ModelMetadata | undefined,
  variant: string,
): Record<string, unknown> | undefined {
  if (!metadata || !metadata.reasoning || metadata.variants.length === 0) {
    return undefined;
  }
  if (!isKnownVariant(metadata, variant)) {
    return undefined;
  }

  const options = metadata.reasoningOptions;
  const effort = getEffortOption(options);
  const hasToggle = hasToggleOption(options);
  const family = metadata.family;

  if (variant === "off" || variant === "default") {
    if (hasToggle) {
      return { thinking: { type: "disabled" } };
    }
    if (effort?.values && effort.values.length > 0) {
      return { reasoningEffort: effort.values[0] };
    }
    return undefined;
  }

  if (variant === "on" || variant === "enabled") {
    if (hasToggle) {
      return { thinking: { type: "enabled" } };
    }
    return undefined;
  }

  // Effort-level variant.
  if (effort?.values?.includes(variant)) {
    if (family.startsWith("deepseek")) {
      return {
        thinking: { type: "enabled" },
        reasoningEffort: variant,
      };
    }
    return { reasoningEffort: variant };
  }

  return undefined;
}
