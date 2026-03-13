import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODEL_REGISTRY_ENTRIES, defaultSupportedModel, listSupportedModels } from "../src/models/registry";
import type { ProviderName } from "../src/types";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

describe("model registry invariants", () => {
  test("every provider has a default supported model", () => {
    for (const provider of ["google", "openai", "anthropic", "opencode-go", "opencode-zen", "codex-cli"] as ProviderName[]) {
      const models = listSupportedModels(provider);
      expect(models.length).toBeGreaterThan(0);
      expect(defaultSupportedModel(provider).provider).toBe(provider);
    }
  });

  test("every model entry has display metadata and a prompt template that exists", () => {
    const root = repoRoot();
    for (const model of MODEL_REGISTRY_ENTRIES) {
      expect(model.displayName.length).toBeGreaterThan(0);
      expect(model.knowledgeCutoff.length).toBeGreaterThan(0);
      expect(
        fs.existsSync(path.join(root, "prompts", model.promptTemplate)),
        `${model.provider}:${model.id} -> prompts/${model.promptTemplate}`,
      ).toBe(true);
    }
  });

  test("each provider has exactly one default model", () => {
    const seenDefaults = new Map<ProviderName, number>();
    for (const model of MODEL_REGISTRY_ENTRIES) {
      if (!model.isDefault) continue;
      seenDefaults.set(model.provider, (seenDefaults.get(model.provider) ?? 0) + 1);
    }

    for (const provider of ["google", "openai", "anthropic", "opencode-go", "opencode-zen", "codex-cli"] as ProviderName[]) {
      expect(seenDefaults.get(provider)).toBe(1);
    }
  });
});
