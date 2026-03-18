import { describe, expect, test } from "bun:test";

import {
  availableProvidersFromCatalog,
  MODEL_CHOICES,
  modelChoicesFromCatalog,
  modelOptionsFromCatalog,
  modelOptionsForProvider,
} from "../src/lib/modelChoices";

describe("modelOptionsForProvider", () => {
  test("includes a custom current model as a selectable option", () => {
    const provider = "openai" as const;
    const curated = MODEL_CHOICES[provider];
    expect(curated.length).toBeGreaterThan(0);

    const custom = `custom-model-${crypto.randomUUID()}`;
    const opts = modelOptionsForProvider(provider, custom);
    expect(opts[0]).toBe(custom);
    expect(opts).toContain(custom);
  });

  test("does not duplicate curated models", () => {
    const provider = "openai" as const;
    const curated = MODEL_CHOICES[provider];
    expect(curated.length).toBeGreaterThan(0);

    const existing = curated[0]!;
    const opts = modelOptionsForProvider(provider, `  ${existing}  `);
    const count = opts.filter((m) => m === existing).length;
    expect(count).toBe(1);
  });

  test("omits baseten from user-facing choices", () => {
    expect(MODEL_CHOICES.baseten).toEqual([]);
    expect(modelChoicesFromCatalog([
      {
        id: "baseten",
        name: "Baseten",
        models: [{ id: "moonshotai/Kimi-K2.5", displayName: "Kimi K2.5", knowledgeCutoff: "Unknown", supportsImageInput: false }],
        defaultModel: "moonshotai/Kimi-K2.5",
      },
      {
        id: "openai",
        name: "OpenAI",
        models: [{ id: "gpt-5.4", displayName: "GPT-5.4", knowledgeCutoff: "Unknown", supportsImageInput: true }],
        defaultModel: "gpt-5.4",
      },
    ]).baseten).toBeUndefined();
  });

  test("filters provider options down to connected user-facing providers", () => {
    const providers = availableProvidersFromCatalog(
      [
        {
          id: "baseten",
          name: "Baseten",
          models: [],
          defaultModel: "moonshotai/Kimi-K2.5",
        },
        {
          id: "google",
          name: "Google",
          models: [],
          defaultModel: "gemini-3-pro-preview",
        },
        {
          id: "openai",
          name: "OpenAI",
          models: [],
          defaultModel: "gpt-5.4",
        },
      ],
      ["baseten", "openai"],
    );

    expect(providers).toEqual(["openai"]);
  });

  test("preserves disconnected provider in provider options", () => {
    const providers = availableProvidersFromCatalog(
      [
        {
          id: "google",
          name: "Google",
          models: [],
          defaultModel: "gemini-3-pro",
        },
        {
          id: "openai",
          name: "OpenAI",
          models: [],
          defaultModel: "gpt-5.4",
        },
      ],
      ["google"],
      "openai",
    );

    expect(providers).toEqual(["google", "openai"]);
  });

  test("preserves the current provider even when it disappears from the live catalog", () => {
    const providers = availableProvidersFromCatalog(
      [
        {
          id: "google",
          name: "Google",
          models: [{ id: "gemini-3-pro", displayName: "Gemini 3 Pro", knowledgeCutoff: "Unknown", supportsImageInput: true }],
          defaultModel: "gemini-3-pro",
        },
      ],
      ["google"],
      "lmstudio",
    );

    expect(providers).toEqual(["google", "lmstudio"]);
  });

  test("preserves disabled current provider for existing workspaces", () => {
    const providers = availableProvidersFromCatalog(
      [
        {
          id: "google",
          name: "Google",
          models: [],
          defaultModel: "gemini-3-pro",
        },
        {
          id: "openai",
          name: "OpenAI",
          models: [],
          defaultModel: "gpt-5.4",
        },
      ],
      ["openai"],
      "baseten",
    );

    expect(providers).toEqual(["openai", "baseten"]);
  });

  test("filters hidden LM Studio models from live catalog choices", () => {
    const choices = modelChoicesFromCatalog(
      [
        {
          id: "lmstudio",
          name: "LM Studio",
          models: [
            { id: "model-a", displayName: "Model A", knowledgeCutoff: "Unknown", supportsImageInput: false },
            { id: "model-b", displayName: "Model B", knowledgeCutoff: "Unknown", supportsImageInput: false },
          ],
          defaultModel: "model-a",
        },
      ],
      {
        hiddenModelsByProvider: {
          lmstudio: ["model-b"],
        },
      },
    );

    expect(choices.lmstudio).toEqual(["model-a"]);
  });

  test("preserves the current hidden LM Studio model in model options", () => {
    const options = modelOptionsFromCatalog(
      [
        {
          id: "lmstudio",
          name: "LM Studio",
          models: [
            { id: "model-a", displayName: "Model A", knowledgeCutoff: "Unknown", supportsImageInput: false },
            { id: "model-b", displayName: "Model B", knowledgeCutoff: "Unknown", supportsImageInput: false },
          ],
          defaultModel: "model-a",
        },
      ],
      "lmstudio",
      "model-b",
      {
        hiddenModelsByProvider: {
          lmstudio: ["model-b"],
        },
      },
    );

    expect(options).toEqual(["model-b", "model-a"]);
  });

  test("hides LM Studio from provider choices when the local provider is disabled", () => {
    const providers = availableProvidersFromCatalog(
      [
        {
          id: "lmstudio",
          name: "LM Studio",
          models: [{ id: "model-a", displayName: "Model A", knowledgeCutoff: "Unknown", supportsImageInput: false }],
          defaultModel: "model-a",
        },
        {
          id: "openai",
          name: "OpenAI",
          models: [{ id: "gpt-5.4", displayName: "GPT-5.4", knowledgeCutoff: "Unknown", supportsImageInput: true }],
          defaultModel: "gpt-5.4",
        },
      ],
      ["lmstudio", "openai"],
      undefined,
      {
        hiddenProviders: ["lmstudio"],
        visibleModelsByProvider: {
          lmstudio: [],
          openai: ["gpt-5.4"],
        },
      },
    );

    expect(providers).toEqual(["openai"]);
  });
});
