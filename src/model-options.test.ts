import { describe, it, expect } from "@jest/globals";
import {
  parseModelVariant,
  getDefaultVariant,
  formatVariants,
  buildProviderOptions,
} from "./model-options.js";
import type { ModelMetadata } from "./models.js";

const deepseekMeta: ModelMetadata = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  family: "deepseek-flash",
  reasoning: true,
  reasoningOptions: [
    { type: "toggle" },
    { type: "effort", values: ["high", "max"] },
  ],
  variants: ["off", "high", "max"],
  defaultVariant: "off",
  cost: { input: 0.14, output: 0.28 },
};

const gptMeta: ModelMetadata = {
  id: "gpt-5-nano",
  name: "GPT 5 Nano",
  family: "gpt-nano",
  reasoning: true,
  reasoningOptions: [
    { type: "effort", values: ["minimal", "low", "medium", "high"] },
  ],
  variants: ["minimal", "low", "medium", "high"],
  defaultVariant: "minimal",
  cost: { input: 0.05, output: 0.4 },
};

const pickleMeta: ModelMetadata = {
  id: "big-pickle",
  name: "Big Pickle",
  family: "big-pickle",
  reasoning: true,
  reasoningOptions: [],
  variants: ["default"],
  defaultVariant: "default",
  cost: { input: 0, output: 0 },
};

describe("parseModelVariant", () => {
  it("parses model name without variant", () => {
    expect(parseModelVariant("deepseek-v4-flash")).toEqual({
      baseModel: "deepseek-v4-flash",
    });
  });

  it("parses model name with variant suffix", () => {
    expect(parseModelVariant("deepseek-v4-flash:high")).toEqual({
      baseModel: "deepseek-v4-flash",
      variant: "high",
    });
  });

  it("throws on trailing colon", () => {
    expect(() => parseModelVariant("deepseek-v4-flash:")).toThrow(
      "invalid model variant syntax: deepseek-v4-flash:",
    );
  });

  it("throws on leading colon", () => {
    expect(() => parseModelVariant(":high")).toThrow(
      "invalid model variant syntax: :high",
    );
  });
});

describe("getDefaultVariant", () => {
  it("returns defaultVariant when metadata exists", () => {
    expect(getDefaultVariant(deepseekMeta)).toBe("off");
    expect(getDefaultVariant(gptMeta)).toBe("minimal");
  });

  it("returns undefined when metadata is undefined", () => {
    expect(getDefaultVariant(undefined)).toBeUndefined();
  });
});

describe("formatVariants", () => {
  it("formats variants list with default marked", () => {
    expect(formatVariants(deepseekMeta)).toBe("off (default), high, max");
  });

  it("returns (none) for undefined or empty metadata", () => {
    expect(formatVariants(undefined)).toBe("(none)");
    expect(formatVariants({ ...deepseekMeta, variants: [] })).toBe("(none)");
  });
});

describe("buildProviderOptions", () => {
  it("returns undefined when metadata is undefined", () => {
    expect(buildProviderOptions(undefined, "off")).toBeUndefined();
  });

  it("returns undefined for unknown variants", () => {
    expect(buildProviderOptions(deepseekMeta, "unknown")).toBeUndefined();
  });

  it("returns disabled thinking for deepseek off variant", () => {
    expect(buildProviderOptions(deepseekMeta, "off")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("returns enabled thinking + effort for deepseek high variant", () => {
    expect(buildProviderOptions(deepseekMeta, "high")).toEqual({
      thinking: { type: "enabled" },
      reasoningEffort: "high",
    });
  });

  it("returns enabled thinking + max effort for deepseek max variant", () => {
    expect(buildProviderOptions(deepseekMeta, "max")).toEqual({
      thinking: { type: "enabled" },
      reasoningEffort: "max",
    });
  });

  it("returns reasoningEffort for GPT models", () => {
    expect(buildProviderOptions(gptMeta, "minimal")).toEqual({
      reasoningEffort: "minimal",
    });
    expect(buildProviderOptions(gptMeta, "high")).toEqual({
      reasoningEffort: "high",
    });
  });

  it("returns undefined for models with no reasoning options (big-pickle)", () => {
    expect(buildProviderOptions(pickleMeta, "default")).toBeUndefined();
  });
});
