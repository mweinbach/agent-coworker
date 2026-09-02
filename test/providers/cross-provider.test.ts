import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultModelForProvider } from "../../src/config";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers";
import {
  ANTIGRAVITY_UNSUPPORTED_PLATFORM_MESSAGE,
  isAntigravitySupportedPlatform,
} from "../../src/providers/antigravitySupport";
import { createRuntime } from "../../src/runtime";
import { resolveGoogleInteractionsModel } from "../../src/runtime/googleInteractionsModel";
import { resolveOpenAiResponsesModel } from "../../src/runtime/openaiResponsesModel";
import { resolvePiModel } from "../../src/runtime/pi/modelResolution";
import type { ProviderName } from "../../src/types";
import { PROVIDER_NAMES } from "../../src/types";
import { makeConfig, makeRuntimeParams, makeTmpDirs } from "./helpers";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Cross-provider runtime routing", () => {
  const runtimeNames: Record<ProviderName, string> = {
    anthropic: "pi",
    bedrock: "pi",
    baseten: "pi",
    together: "pi",
    fireworks: "pi",
    firepass: "pi",
    nvidia: "pi",
    minimax: "pi",
    "opencode-go": "pi",
    "opencode-zen": "pi",
    lmstudio: "pi",
    openai: "openai-responses",
    google: "google-interactions",
    "codex-cli": "codex-app-server",
    antigravity: "antigravity",
  };
  for (const provider of PROVIDER_NAMES) {
    test(`${provider} respects runtime routing and platform support`, () => {
      const model = defaultModelForProvider(provider);
      expect(model).toBe(PROVIDER_MODEL_CATALOG[provider].defaultModel);
      const config = makeConfig({ provider, model });
      if (provider === "antigravity" && !isAntigravitySupportedPlatform()) {
        expect(() => createRuntime(config)).toThrow(ANTIGRAVITY_UNSUPPORTED_PLATFORM_MESSAGE);
      } else {
        expect(createRuntime(config).name).toBe(runtimeNames[provider]);
      }
    });
  }
});

describe("Runtime model identity", () => {
  for (const { provider, resolve } of [
    { provider: "google", resolve: resolveGoogleInteractionsModel },
    { provider: "openai", resolve: resolveOpenAiResponsesModel },
    { provider: "anthropic", resolve: resolvePiModel },
  ] as const) {
    test.each(PROVIDER_MODEL_CATALOG[provider].availableModels)(
      `${provider} resolves supported model %s`,
      async (modelId) => {
        const { home, tmp } = await makeTmpDirs();
        temporaryDirectories.push(tmp);
        const { model } = await resolve(
          makeRuntimeParams(
            makeConfig({
              provider,
              model: modelId,
              userCoworkDir: path.join(home, ".cowork"),
            }),
          ),
        );
        expect(model.id).toBe(modelId);
      },
    );
  }

  test.each([
    ["gemini-3-pro-preview", "gemini-3.1-pro-preview-customtools"],
    ["gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite"],
  ])("Google resolves legacy alias %s", async (alias, canonical) => {
    const { home, tmp } = await makeTmpDirs();
    temporaryDirectories.push(tmp);
    const { model } = await resolveGoogleInteractionsModel(
      makeRuntimeParams(
        makeConfig({
          provider: "google",
          model: alias,
          userCoworkDir: path.join(home, ".cowork"),
        }),
      ),
    );
    expect(model.id).toBe(canonical);
  });

  test("OpenCode Go rejects Zen-only models", async () => {
    const { home, tmp } = await makeTmpDirs();
    temporaryDirectories.push(tmp);
    await expect(
      resolvePiModel(
        makeRuntimeParams(
          makeConfig({
            provider: "opencode-go",
            model: "big-pickle",
            userCoworkDir: path.join(home, ".cowork"),
          }),
        ),
      ),
    ).rejects.toThrow('Unsupported model "big-pickle" for provider opencode-go.');
  });
});

describe("Provider model catalog invariants", () => {
  for (const provider of PROVIDER_NAMES) {
    test(`${provider}: available model list is non-empty`, () => {
      if (provider === "lmstudio") {
        expect(PROVIDER_MODEL_CATALOG[provider].availableModels).toEqual([]);
        return;
      }
      expect(PROVIDER_MODEL_CATALOG[provider].availableModels.length).toBeGreaterThan(0);
    });

    test(`${provider}: default model exists in available models`, () => {
      if (provider === "lmstudio") {
        expect(PROVIDER_MODEL_CATALOG[provider].defaultModel).toBe("");
        return;
      }
      expect(PROVIDER_MODEL_CATALOG[provider].availableModels).toContain(
        PROVIDER_MODEL_CATALOG[provider].defaultModel,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Session reasoning kind per provider (tests the real function)
// ---------------------------------------------------------------------------
import { reasoningModeForProvider } from "../../src/server/modelStream";

describe("Session reasoning kind mapping", () => {
  test("openai provider maps to 'summary' reasoning kind", () => {
    expect(reasoningModeForProvider("openai")).toBe("summary");
  });

  test("anthropic provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("anthropic")).toBe("reasoning");
  });

  test("google provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("google")).toBe("reasoning");
  });

  test("baseten provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("baseten")).toBe("reasoning");
  });

  test("together provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("together")).toBe("reasoning");
  });

  test("fireworks provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("fireworks")).toBe("reasoning");
  });

  test("firepass provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("firepass")).toBe("reasoning");
  });

  test("nvidia provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("nvidia")).toBe("reasoning");
  });

  test("minimax provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("minimax")).toBe("reasoning");
  });

  test("opencode-go provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("opencode-go")).toBe("reasoning");
  });

  test("opencode-zen provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("opencode-zen")).toBe("reasoning");
  });

  test("codex-cli provider maps to 'summary' reasoning kind", () => {
    expect(reasoningModeForProvider("codex-cli")).toBe("summary");
  });
});
