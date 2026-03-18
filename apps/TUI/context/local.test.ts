import { describe, expect, test } from "bun:test";

import {
  availableProvidersFromCatalogState,
  modelChoicesFromSyncState,
} from "./local";
import type { ProviderCatalogState } from "./syncTypes";

describe("local context provider/model helpers", () => {
  const catalog: ProviderCatalogState = [
    {
      id: "openai",
      name: "OpenAI",
      models: [{ id: "gpt-5.4", displayName: "GPT-5.4", knowledgeCutoff: "Unknown", supportsImageInput: true }],
      defaultModel: "gpt-5.4",
    },
    {
      id: "google",
      name: "Google",
      models: [{ id: "gemini-2", displayName: "Gemini 2", knowledgeCutoff: "Unknown", supportsImageInput: true }],
      defaultModel: "gemini-2",
    },
  ];

  test("preserves disconnected current provider in provider choices", () => {
    const providers = availableProvidersFromCatalogState(
      catalog,
      ["google"],
      "openai",
    );

    expect(providers).toEqual(["google", "openai"]);
  });

  test("preserves the current provider even when it disappears from the live catalog", () => {
    const providers = availableProvidersFromCatalogState(
      [
        {
          id: "google",
          name: "Google",
          models: [{ id: "gemini-2", displayName: "Gemini 2", knowledgeCutoff: "Unknown", supportsImageInput: true }],
          defaultModel: "gemini-2",
        },
      ],
      ["google"],
      "lmstudio",
    );

    expect(providers).toEqual(["google", "lmstudio"]);

    const choices = modelChoicesFromSyncState(
      [
        {
          id: "google",
          name: "Google",
          models: [{ id: "gemini-2", displayName: "Gemini 2", knowledgeCutoff: "Unknown", supportsImageInput: true }],
          defaultModel: "gemini-2",
        },
      ] as ProviderCatalogState,
      ["google"],
      "lmstudio",
      "local/qwen-2.5",
    );

    expect(choices).toEqual([
      { provider: "google", model: "gemini-2" },
      { provider: "lmstudio", model: "local/qwen-2.5" },
    ]);
  });

  test("preserves the active model for disconnected provider in model choices", () => {
    const choices = modelChoicesFromSyncState(
      catalog,
      ["google"],
      "openai",
      "custom-openai-model",
    );

    expect(choices).toEqual([
      { provider: "openai", model: "gpt-5.4" },
      { provider: "google", model: "gemini-2" },
      { provider: "openai", model: "custom-openai-model" },
    ]);
  });

  test("never exposes disabled providers even when preserved", () => {
    const providers = availableProvidersFromCatalogState(
      [
        {
          id: "baseten",
          name: "Baseten",
          models: [{ id: "moonshot", displayName: "Moonshot", knowledgeCutoff: "Unknown", supportsImageInput: false }],
          defaultModel: "moonshot",
        },
      ],
      ["baseten"],
      "baseten",
    );

    expect(providers).toEqual([]);

    const choices = modelChoicesFromSyncState(
      [
        {
          id: "baseten",
          name: "Baseten",
          models: [{ id: "moonshot", displayName: "Moonshot", knowledgeCutoff: "Unknown", supportsImageInput: false }],
          defaultModel: "moonshot",
        },
      ] as ProviderCatalogState,
      ["baseten"],
      "baseten",
      "moonshot",
    );

    expect(choices).toEqual([]);
  });
});
