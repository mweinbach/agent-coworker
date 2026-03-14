import { describe, expect, test } from "bun:test";
import path from "node:path";

import { createRuntime, resolveRuntimeName } from "../src/runtime";
import type { AgentConfig } from "../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = "/tmp/runtime-selection";
  return {
    provider: "openai",
    model: "gpt-5.2",
    subAgentModel: "gpt-5.2",
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
      subAgentModel: "gpt-5.4",
    });
    expect(resolveRuntimeName(config)).toBe("openai-responses");
    expect(createRuntime(config).name).toBe("openai-responses");
  });

  test("treats legacy pi runtime config as the OpenAI Responses runtime for codex-cli", () => {
    const config = makeConfig({
      provider: "codex-cli",
      model: "gpt-5.4",
      subAgentModel: "gpt-5.4",
      runtime: "pi",
    });
    expect(resolveRuntimeName(config)).toBe("openai-responses");
    expect(createRuntime(config).name).toBe("openai-responses");
  });

  test("routes opencode-go through the pi runtime", () => {
    const config = makeConfig({
      provider: "opencode-go",
      model: "glm-5",
      subAgentModel: "glm-5",
    });
    expect(resolveRuntimeName(config)).toBe("pi");
    expect(createRuntime(config).name).toBe("pi");
  });

  test("routes opencode-zen through the pi runtime", () => {
    const config = makeConfig({
      provider: "opencode-zen",
      model: "glm-5",
      subAgentModel: "glm-5",
    });
    expect(resolveRuntimeName(config)).toBe("pi");
    expect(createRuntime(config).name).toBe("pi");
  });

  test("rejects unsupported providers explicitly configured to use the OpenAI Responses runtime", () => {
    const config = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      subAgentModel: "gemini-3-flash-preview",
      runtime: "openai-responses",
    });

    expect(resolveRuntimeName(config)).toBe("openai-responses");
    expect(() => createRuntime(config)).toThrow(
      "Provider google does not support the OpenAI Responses runtime.",
    );
  });
});
