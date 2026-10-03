import type { ModelsDevEntry } from "@/lib/modelsDevPricing";

// Preserve custom model IDs and aliases while hiding other harness brands.
const OTHER_HARNESS_MODEL =
  /(?:^|[ /_-])(?:claude|gemini|grok|opencode|openclaw|hermes|minimax|mcode|pi)(?:[ /_-]|\d|$)/i;

export function isCodexPricingModel(
  modelId: string,
  displayName = "",
): boolean {
  return (
    !OTHER_HARNESS_MODEL.test(modelId) && !OTHER_HARNESS_MODEL.test(displayName)
  );
}

export function isCodexCatalogEntry(entry: ModelsDevEntry): boolean {
  return (
    entry.providerId === "openai" &&
    isCodexPricingModel(entry.normalizedId, entry.modelName)
  );
}
