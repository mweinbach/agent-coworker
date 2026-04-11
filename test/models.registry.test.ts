import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_REGISTRY_ENTRIES,
  defaultSupportedModel,
  listSupportedModels,
  getSupportedModel,
  assertSupportedModel,
  describeModelProviderMismatch,
  supportsImageInput,
  providerOptionsDefaultsForModel,
} from "../src/models/registry";
import { normalizeModelIdForProvider } from "../src/models/metadata";
import { parseChildModelRef } from "../src/models/childModelRouting";
import { listMissingChildAgentModelInfo } from "../src/models/childAgentModelInfo";
import { isUserFacingProviderEnabled } from "../src/providers/catalog";
import type { ProviderName } from "../src/types";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

describe("model registry invariants", () => {
  test("every provider has a default supported model", () => {
    for (const provider of ["google", "openai", "anthropic", "baseten", "together", "fireworks", "nvidia", "opencode-go", "opencode-zen", "codex-cli"] as ProviderName[]) {
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

    for (const provider of ["google", "openai", "anthropic", "baseten", "together", "fireworks", "nvidia", "opencode-go", "opencode-zen", "codex-cli"] as ProviderName[]) {
      expect(seenDefaults.get(provider)).toBe(1);
    }
  });
});

describe("model registry helpers", () => {
  test("assertSupportedModel throws for unknown model", () => {
    expect(() => assertSupportedModel("openai", "missing-model")).toThrow(/Unsupported model/);
  });

  test("assertSupportedModel includes OpenAI mismatch guidance for anthropic provider", () => {
    expect(() => assertSupportedModel("anthropic", "gpt-5.4(xhigh)")).toThrow(/looks like an OpenAI model/);
    expect(() => assertSupportedModel("anthropic", "gpt-5.4(xhigh)")).toThrow(/use provider openai instead/);
  });

  test("assertSupportedModel includes Anthropic mismatch guidance for openai provider", () => {
    expect(() => assertSupportedModel("openai", "claude-sonnet-4-5")).toThrow(/looks like an Anthropic model/);
    expect(() => assertSupportedModel("openai", "claude-sonnet-4-5")).toThrow(/use provider anthropic instead/);
  });

  test("describeModelProviderMismatch allows codex-cli for OpenAI-family models", () => {
    expect(describeModelProviderMismatch("codex-cli", "gpt-5.4(xhigh)")).toBeNull();
  });

  test("getSupportedModel returns null for unknown models", () => {
    expect(getSupportedModel("openai", "missing-model")).toBeNull();
  });

  test("supportsImageInput is false when the model is unknown", () => {
    expect(supportsImageInput("google", "missing-model")).toBe(false);
  });

  test("providerOptionsDefaultsForModel returns an empty object for unknown models", () => {
    expect(providerOptionsDefaultsForModel("anthropic", "missing-model")).toEqual({});
  });

  test("every user-facing model has child-agent guidance metadata", () => {
    const userFacingProviders = (
      ["google", "openai", "anthropic", "baseten", "together", "fireworks", "nvidia", "opencode-go", "opencode-zen", "codex-cli"] as ProviderName[]
    ).filter((provider) => isUserFacingProviderEnabled(provider));
    expect(listMissingChildAgentModelInfo(userFacingProviders)).toEqual([]);
  });
});

describe("legacy model aliases", () => {
  test("getSupportedModel resolves legacy alias gemini-3-pro-preview", () => {
    const model = getSupportedModel("google", "gemini-3-pro-preview");
    expect(model).not.toBeNull();
    expect(model!.id).toBe("gemini-3.1-pro-preview-customtools");
    expect(model!.provider).toBe("google");
  });

  test("assertSupportedModel accepts legacy alias gemini-3-pro-preview", () => {
    const model = assertSupportedModel("google", "gemini-3-pro-preview");
    expect(model.id).toBe("gemini-3.1-pro-preview-customtools");
    expect(model.provider).toBe("google");
  });

  test("normalizeModelIdForProvider resolves legacy alias gemini-3-pro-preview", () => {
    const normalized = normalizeModelIdForProvider("google", "gemini-3-pro-preview");
    expect(normalized).toBe("gemini-3.1-pro-preview-customtools");
  });

  test("parseChildModelRef normalizes legacy alias in child model ref", () => {
    const parsed = parseChildModelRef("google:gemini-3-pro-preview", "google");
    expect(parsed.modelId).toBe("gemini-3.1-pro-preview-customtools");
    expect(parsed.provider).toBe("google");
    expect(parsed.ref).toBe("google:gemini-3.1-pro-preview-customtools");
  });
});
