import { describe, expect, test } from "bun:test";
import path from "node:path";

import { createRuntime, resolveRuntimeName } from "../src/runtime";
import type { AgentConfig } from "../src/types";

const PI_PROVIDER_CASES = [
  { provider: "anthropic", model: "claude-sonnet-4-6" },
  { provider: "baseten", model: "deepseek-r1-0528" },
  { provider: "together", model: "deepseek-ai/DeepSeek-R1" },
  { provider: "nvidia", model: "meta/llama-4-maverick-17b-128e-instruct" },
  { provider: "lmstudio", model: "local-model" },
  { provider: "opencode-go", model: "glm-5" },
  { provider: "opencode-zen", model: "kimi-k2.5" },
] as const;

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = "/tmp/runtime-selection";
  return {
    provider: "openai",
    model: "gpt-5.2",
    preferredChildModel: "gpt-5.2",
    workingDirectory: base,
    outputDirectory: path.join(base, "output"),
    uploadsDirectory: path.join(base, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(base, ".agent"),
    userAgentDir: path.join(base, ".agent-user"),
    builtInDir: base,
    builtInConfigDir: path.join(base, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

describe("runtime selection", () => {
  test("defaults openai provider to the OpenAI Responses runtime when config.runtime is missing", () => {
    const config = makeConfig();
    expect(resolveRuntimeName(config)).toBe("openai-responses");
    expect(createRuntime(config).name).toBe("openai-responses");
  });

  test("treats legacy pi runtime config as the OpenAI Responses runtime for openai", () => {
    const config = makeConfig({ runtime: "pi" });
    expect(resolveRuntimeName(config)).toBe("openai-responses");
    expect(createRuntime(config).name).toBe("openai-responses");
  });

  test("defaults codex-cli provider to the OpenAI Responses runtime", () => {
    const config = makeConfig({
      provider: "codex-cli",
      model: "gpt-5.4",
      preferredChildModel: "gpt-5.4",
    });
    expect(resolveRuntimeName(config)).toBe("openai-responses");
    expect(createRuntime(config).name).toBe("openai-responses");
  });

  test("treats legacy pi runtime config as the OpenAI Responses runtime for codex-cli", () => {
    const config = makeConfig({
      provider: "codex-cli",
      model: "gpt-5.4",
      preferredChildModel: "gpt-5.4",
      runtime: "pi",
    });
    expect(resolveRuntimeName(config)).toBe("openai-responses");
    expect(createRuntime(config).name).toBe("openai-responses");
  });

  for (const { provider, model } of PI_PROVIDER_CASES) {
    test(`routes ${provider} through the pi runtime`, () => {
      const config = makeConfig({
        provider,
        model,
        preferredChildModel: model,
      });
      expect(resolveRuntimeName(config)).toBe("pi");
      expect(createRuntime(config).name).toBe("pi");
    });
  }

  test("defaults google provider to the Google Interactions runtime", () => {
    const config = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      preferredChildModel: "gemini-3-flash-preview",
    });

    expect(resolveRuntimeName(config)).toBe("google-interactions");
    expect(createRuntime(config).name).toBe("google-interactions");
  });

  test("normalizes stale OpenAI Responses runtime config away for google provider", () => {
    const config = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      preferredChildModel: "gemini-3-flash-preview",
      runtime: "openai-responses",
    });

    expect(resolveRuntimeName(config)).toBe("google-interactions");
    expect(createRuntime(config).name).toBe("google-interactions");
  });

  test("normalizes stale OpenAI Responses runtime config away for pi-family providers", () => {
    const config = makeConfig({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      preferredChildModel: "claude-sonnet-4-6",
      runtime: "openai-responses",
    });

    expect(resolveRuntimeName(config)).toBe("pi");
    expect(createRuntime(config).name).toBe("pi");
  });
});
