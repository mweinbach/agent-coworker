import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultSupportedModel,
  describeModelProviderMismatch,
  getSupportedModel,
  listSupportedModels,
  MODEL_REGISTRY_ENTRIES,
  supportsImageInput,
} from "../src/models/registry";
import { reasoningConfigForProviderModel } from "../src/providers/catalog";
import type { ProviderName } from "../src/types";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

describe("model registry invariants", () => {
  test("every provider has a default supported model", () => {
    for (const provider of [
      "google",
      "openai",
      "anthropic",
      "bedrock",
      "baseten",
      "together",
      "fireworks",
      "firepass",
      "nvidia",
      "opencode-go",
      "opencode-zen",
      "codex-cli",
    ] as ProviderName[]) {
      const models = listSupportedModels(provider);
      expect(models.length).toBeGreaterThan(0);
      expect(defaultSupportedModel(provider).provider).toBe(provider);
    }
  });

  test("every config/models JSON file is imported into MODEL_REGISTRY_ENTRIES", () => {
    const root = repoRoot();
    const modelsRoot = path.join(root, "config", "models");
    const expectedKeys = new Set<string>();
    const pending = [modelsRoot];

    while (pending.length > 0) {
      const dir = pending.pop();
      if (!dir) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const raw = JSON.parse(fs.readFileSync(entryPath, "utf-8")) as {
          id?: unknown;
          provider?: unknown;
        };
        if (typeof raw.provider !== "string" || typeof raw.id !== "string") {
          throw new Error(`Invalid model config shape in ${entryPath}`);
        }
        expectedKeys.add(`${raw.provider}:${raw.id}`);
      }
    }

    const importedKeys = new Set(
      MODEL_REGISTRY_ENTRIES.map((model) => `${model.provider}:${model.id}`),
    );
    expect([...importedKeys].sort()).toEqual([...expectedKeys].sort());
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

  test("declared reasoning efforts always include the model's default effort", () => {
    for (const model of MODEL_REGISTRY_ENTRIES) {
      const efforts = model.supportedReasoningEfforts;
      if (!efforts) continue;
      const defaultEffort = model.providerOptionsDefaults.reasoningEffort;
      expect(
        typeof defaultEffort === "string" &&
          efforts.includes(defaultEffort as (typeof efforts)[number]),
        `${model.provider}:${model.id} default effort ${String(defaultEffort)} must be listed in supportedReasoningEfforts`,
      ).toBe(true);
    }
  });

  test("per-model reasoning efforts flow through the provider catalog", () => {
    // GPT-5.5 does not accept "minimal" (vendor docs: none/low/medium/high/xhigh).
    expect(reasoningConfigForProviderModel("openai", "gpt-5.5")).toEqual({
      defaultEffort: "high",
      availableEfforts: ["none", "low", "medium", "high", "xhigh"],
    });
    expect(reasoningConfigForProviderModel("openai", "gpt-5-mini")).toEqual({
      defaultEffort: "high",
      availableEfforts: ["none", "minimal", "low", "medium", "high"],
    });
    expect(reasoningConfigForProviderModel("codex-cli", "gpt-5.4")).toEqual({
      defaultEffort: "high",
      availableEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    });
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(reasoningConfigForProviderModel("codex-cli", model)).toEqual({
        defaultEffort: "high",
        availableEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      });
      expect(getSupportedModel("codex-cli", model)).toMatchObject({
        knowledgeCutoff: "February 16, 2026",
        supportsImageInput: true,
      });
    }
    expect(defaultSupportedModel("codex-cli").id).toBe("gpt-5.6-sol");
    expect(getSupportedModel("codex-cli", "gpt-5.4")).not.toBeNull();
  });

  test("light and max efforts are opt-in, never assumed by the fallback list", () => {
    for (const model of MODEL_REGISTRY_ENTRIES) {
      const config = reasoningConfigForProviderModel(model.provider, model.id);
      if (!config) continue;
      if (model.supportedReasoningEfforts?.includes("light")) continue;
      expect(config.availableEfforts).not.toContain("light");
      if (model.supportedReasoningEfforts?.includes("max")) continue;
      expect(config.availableEfforts).not.toContain("max");
    }
  });

  test("each provider has exactly one default model", () => {
    const seenDefaults = new Map<ProviderName, number>();
    for (const model of MODEL_REGISTRY_ENTRIES) {
      if (!model.isDefault) continue;
      seenDefaults.set(model.provider, (seenDefaults.get(model.provider) ?? 0) + 1);
    }

    for (const provider of [
      "google",
      "openai",
      "anthropic",
      "bedrock",
      "baseten",
      "together",
      "fireworks",
      "firepass",
      "nvidia",
      "opencode-go",
      "opencode-zen",
      "codex-cli",
    ] as ProviderName[]) {
      expect(seenDefaults.get(provider)).toBe(1);
    }
  });
});

describe("model registry helpers", () => {
  test("describeModelProviderMismatch allows codex-cli for OpenAI-family models", () => {
    expect(describeModelProviderMismatch("codex-cli", "gpt-5.4(xhigh)")).toBeNull();
  });

  test("getSupportedModel returns null for unknown models", () => {
    expect(getSupportedModel("openai", "missing-model")).toBeNull();
  });

  test("supportsImageInput is false when the model is unknown", () => {
    expect(supportsImageInput("google", "missing-model")).toBe(false);
  });
});

describe("legacy model aliases", () => {
  test("removed OpenAI model IDs normalize to gpt-5.4", () => {
    const aliases = ["gpt-5.1", "gpt-5.2-codex"] as const;

    for (const alias of aliases) {
      const model = getSupportedModel("openai", alias);
      expect(model).not.toBeNull();
      expect(model!.id).toBe("gpt-5.4");
    }
  });

  test("removed Codex CLI model IDs normalize to gpt-5.4", () => {
    const aliases = [
      "gpt-5-codex",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5.2-codex",
    ] as const;

    for (const alias of aliases) {
      const model = getSupportedModel("codex-cli", alias);
      expect(model).not.toBeNull();
      expect(model!.id).toBe("gpt-5.4");
    }
  });

  test("getSupportedModel resolves legacy alias gemini-3-pro-preview", () => {
    const model = getSupportedModel("google", "gemini-3-pro-preview");
    expect(model).not.toBeNull();
    expect(model!.id).toBe("gemini-3.1-pro-preview-customtools");
    expect(model!.provider).toBe("google");
  });

  test("Gemini 3.1 Flash-Lite preview normalizes to the canonical model id", () => {
    const model = getSupportedModel("google", "gemini-3.1-flash-lite-preview");
    expect(model).not.toBeNull();
    expect(model?.id).toBe("gemini-3.1-flash-lite");
  });
});
