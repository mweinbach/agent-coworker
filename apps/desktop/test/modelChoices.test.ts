import { describe, expect, test } from "bun:test";

import {
  availableProvidersFromCatalog,
  configuredProvidersForModelChoices,
  decodeProviderModelSelection,
  encodeProviderModelSelection,
  isUiDisabledProvider,
  MODEL_CHOICES,
  modelChoicesFromCatalog,
  modelDisplayNamesFromCatalog,
  modelOptionsForProvider,
  modelOptionsFromCatalog,
  reasoningConfigFromCatalog,
  resolveModelDisplayLabel,
} from "../src/lib/modelChoices";
import type { ProviderName } from "../src/lib/wsProtocol";

test("Antigravity is UI-disabled on Windows only", () => {
  expect(isUiDisabledProvider("antigravity", "windows")).toBe(true);
  expect(isUiDisabledProvider("antigravity", "macos")).toBe(false);
  expect(isUiDisabledProvider("antigravity", "linux")).toBe(false);
});

describe("encodeProviderModelSelection / decodeProviderModelSelection", () => {
  test("round-trips model ids that contain colons (e.g. Fireworks serverless paths)", () => {
    const provider = "fireworks" as ProviderName;
    const modelId = "accounts/fireworks/models/glm-5p1";
    const encoded = encodeProviderModelSelection(provider, modelId);
    expect(encoded).toBe("fireworks:accounts/fireworks/models/glm-5p1");
    const decoded = decodeProviderModelSelection(encoded);
    expect(decoded).toEqual({ provider, modelId });
  });

  test("decode rejects unknown provider prefix", () => {
    expect(decodeProviderModelSelection("unknown:foo")).toBeNull();
  });
});

describe("modelDisplayNamesFromCatalog", () => {
  test("resolveModelDisplayLabel uses catalog displayName when present", () => {
    const map = modelDisplayNamesFromCatalog([
      {
        id: "fireworks",
        name: "Fireworks AI",
        models: [
          {
            id: "accounts/fireworks/models/glm-5p1",
            displayName: "GLM 5.1",
            knowledgeCutoff: "Mid 2025",
            supportsImageInput: false,
          },
        ],
        defaultModel: "accounts/fireworks/models/glm-5p1",
      },
    ]);
    expect(resolveModelDisplayLabel("fireworks", "accounts/fireworks/models/glm-5p1", map)).toBe(
      "GLM 5.1",
    );
  });
});

describe("reasoningConfigFromCatalog", () => {
  const catalog = [
    {
      id: "openai" as const,
      name: "OpenAI",
      models: [
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
          reasoning: { defaultEffort: "high" as const },
        },
        {
          id: "gpt-4.1",
          displayName: "GPT-4.1",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
      ],
      defaultModel: "gpt-5.4",
    },
  ];

  test("returns reasoning metadata for the exact selected model", () => {
    expect(reasoningConfigFromCatalog(catalog, "openai", "gpt-5.4")).toEqual({
      defaultEffort: "high",
    });
  });

  test("returns null for models without reasoning configuration", () => {
    expect(reasoningConfigFromCatalog(catalog, "openai", "gpt-4.1")).toBeNull();
    expect(reasoningConfigFromCatalog(catalog, "google", "gemini-3.1-pro-preview")).toBeNull();
  });

  test("uses exact static model metadata while the live catalog is loading", () => {
    expect(reasoningConfigFromCatalog([], "codex-cli", "gpt-5.4")).toEqual({
      defaultEffort: "high",
    });
    expect(reasoningConfigFromCatalog([], "google", "gemini-3.5-flash")).toBeNull();
    expect(reasoningConfigFromCatalog([], "codex-cli", "future-model")).toBeNull();
  });
});

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
    expect(
      modelChoicesFromCatalog([
        {
          id: "baseten",
          name: "Baseten",
          models: [
            {
              id: "moonshotai/Kimi-K2.5",
              displayName: "Kimi K2.5",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
          ],
          defaultModel: "moonshotai/Kimi-K2.5",
        },
        {
          id: "openai",
          name: "OpenAI",
          models: [
            {
              id: "gpt-5.4",
              displayName: "GPT-5.4",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
            },
          ],
          defaultModel: "gpt-5.4",
        },
      ]).baseten,
    ).toBeUndefined();
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
          defaultModel: "gemini-3.1-pro-preview",
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
          models: [
            {
              id: "gemini-3-pro",
              displayName: "Gemini 3 Pro",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
            },
          ],
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
            {
              id: "model-a",
              displayName: "Model A",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
            {
              id: "model-b",
              displayName: "Model B",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
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

  test("filters catalog model choices to configured providers", () => {
    const choices = modelChoicesFromCatalog(
      [
        {
          id: "google",
          name: "Google",
          models: [
            {
              id: "gemini-3.5-flash",
              displayName: "Gemini 3.5 Flash",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
            },
          ],
          defaultModel: "gemini-3.5-flash",
        },
        {
          id: "bedrock",
          name: "Amazon Bedrock",
          models: [
            {
              id: "amazon.nova-lite-v1:0",
              displayName: "Amazon Nova Lite",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
          ],
          defaultModel: "amazon.nova-lite-v1:0",
        },
      ],
      { includedProviders: ["google"] },
    );

    expect(choices.google).toEqual(["gemini-3.5-flash"]);
    expect(choices.bedrock).toBeUndefined();
  });

  test("derives configured model providers from connected/status signals, not catalog presence", () => {
    const providers = configuredProvidersForModelChoices({
      catalog: [
        {
          id: "google",
          name: "Google",
          models: [],
          defaultModel: "gemini-3.5-flash",
        },
        {
          id: "bedrock",
          name: "Amazon Bedrock",
          models: [
            {
              id: "amazon.nova-lite-v1:0",
              displayName: "Amazon Nova Lite",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
          ],
          defaultModel: "amazon.nova-lite-v1:0",
        },
      ],
      connected: ["google"],
      providerStatusByName: {
        bedrock: { authorized: false, verified: false },
      },
    });

    expect(providers).toEqual(["google"]);
  });

  test("preserves the current hidden LM Studio model in model options", () => {
    const options = modelOptionsFromCatalog(
      [
        {
          id: "lmstudio",
          name: "LM Studio",
          models: [
            {
              id: "model-a",
              displayName: "Model A",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
            {
              id: "model-b",
              displayName: "Model B",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
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
          models: [
            {
              id: "model-a",
              displayName: "Model A",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
          ],
          defaultModel: "model-a",
        },
        {
          id: "openai",
          name: "OpenAI",
          models: [
            {
              id: "gpt-5.4",
              displayName: "GPT-5.4",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
            },
          ],
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
