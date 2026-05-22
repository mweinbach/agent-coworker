import { describe, expect, test } from "bun:test";

import { defaultModelForProvider, getModel } from "../../src/config";
import { normalizeModelIdForProvider } from "../../src/models/metadata";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers";
import { makeConfig } from "./helpers";

describe("Antigravity provider", () => {
  test("defaults to the Gemini 3.1 Pro preview API model id", () => {
    expect(defaultModelForProvider("antigravity")).toBe("gemini-3.1-pro-preview");
    expect(PROVIDER_MODEL_CATALOG.antigravity.availableModels).toContain("gemini-3.1-pro-preview");
    expect(PROVIDER_MODEL_CATALOG.antigravity.availableModels).not.toContain("gemini-3.1-pro");
  });

  test("legacy Gemini 3.1 Pro shorthand normalizes before adapter creation", () => {
    const normalized = normalizeModelIdForProvider("antigravity", "gemini-3.1-pro");
    expect(normalized).toBe("gemini-3.1-pro-preview");

    const cfg = makeConfig({ provider: "antigravity", model: "gemini-3.1-pro" });
    const model = getModel(cfg);

    expect(model.modelId).toBe("gemini-3.1-pro-preview");
    expect(model.provider).toBe("antigravity");
  });
});
