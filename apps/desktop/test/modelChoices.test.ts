import { describe, expect, test } from "bun:test";

import {
  availableProvidersFromCatalog,
  MODEL_CHOICES,
  modelChoicesFromCatalog,
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
});
