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
  test("defaults to pi runtime when config.runtime is missing", () => {
    const config = makeConfig();
    expect(resolveRuntimeName(config)).toBe("pi");
    expect(createRuntime(config).name).toBe("pi");
  });

  test("respects explicit ai-sdk runtime in config", () => {
    const config = makeConfig({ runtime: "ai-sdk" });
    expect(resolveRuntimeName(config)).toBe("ai-sdk");
    expect(createRuntime(config).name).toBe("ai-sdk");
  });

  test("forceRuntime override takes precedence over config runtime", () => {
    const config = makeConfig({ runtime: "pi" });
    expect(resolveRuntimeName(config, "ai-sdk")).toBe("ai-sdk");
    expect(createRuntime(config, { forceRuntime: "ai-sdk" }).name).toBe("ai-sdk");
  });
});
