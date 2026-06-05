import { describe, expect, test } from "bun:test";
import path from "node:path";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import {
  getMinimaxModelSpec,
  isMiniMaxModelId,
  resolveMinimaxApiKey,
} from "../../src/providers/minimaxShared";
import { createMinimaxModelAdapter } from "../../src/providers/modelAdapter";
import { makeTmpDirs, repoRoot, withEnv, writeJson } from "./helpers";

describe("MiniMax provider", () => {
  test("defaultModelForProvider returns MiniMax-M3", () => {
    expect(defaultModelForProvider("minimax")).toBe("MiniMax-M3");
  });

  test("getModel creates MiniMax model with default MiniMax-M3", () => {
    const model = getModel({
      provider: "minimax",
      runtime: "pi",
      model: "MiniMax-M3",
      preferredChildModel: "MiniMax-M3",
      workingDirectory: "/tmp",
      outputDirectory: "/tmp/output",
      uploadsDirectory: "/tmp/uploads",
      userName: "",
      knowledgeCutoff: "unknown",
      projectCoworkDir: "/tmp/.cowork",
      userCoworkDir: "/tmp/.agent-user",
      builtInDir: "/tmp/built-in",
      builtInConfigDir: "/tmp/built-in/config",
      skillsDirs: [],
      memoryDirs: [],
      configDirs: [],
    });

    expect(model.modelId).toBe("MiniMax-M3");
    expect(model.provider).toBe("minimax.completions");
    expect(model.specificationVersion).toBe("v3");
    expect(model.config.baseUrl).toBe("https://api.minimax.io/v1");
  });

  test("loadConfig with minimax provider returns default minimax model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "minimax" },
    });

    expect(cfg.provider).toBe("minimax");
    expect(cfg.model).toBe("MiniMax-M3");
    expect(cfg.runtime).toBe("pi");
  });

  test("loadConfig accepts the supported minimax model", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "minimax",
      model: "MiniMax-M3",
      preferredChildModel: "MiniMax-M3",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("minimax");
    expect(cfg.model).toBe("MiniMax-M3");
    expect(cfg.runtime).toBe("pi");
  });

  test("MiniMax adapter prefers saved key over env", async () => {
    await withEnv("MINIMAX_API_KEY", "env-key", async () => {
      const adapter = createMinimaxModelAdapter("MiniMax-M3", "saved-key");
      const headers = await adapter.config.headers();
      expect(headers.authorization).toBe("Bearer saved-key");
    });
  });

  test("MiniMax adapter falls back to MINIMAX_API_KEY env", async () => {
    await withEnv("MINIMAX_API_KEY", "env-key", async () => {
      const adapter = createMinimaxModelAdapter("MiniMax-M3");
      const headers = await adapter.config.headers();
      expect(headers.authorization).toBe("Bearer env-key");
    });
  });

  test("MiniMax adapter omits auth header when no key is available", async () => {
    await withEnv("MINIMAX_API_KEY", undefined, async () => {
      const adapter = createMinimaxModelAdapter("MiniMax-M3");
      const headers = await adapter.config.headers();
      expect(headers).toEqual({});
    });
  });

  test("isMiniMaxModelId only accepts the canonical M3 id", () => {
    expect(isMiniMaxModelId("MiniMax-M3")).toBe(true);
    expect(isMiniMaxModelId("MiniMax-M2")).toBe(false);
    expect(isMiniMaxModelId(undefined)).toBe(false);
  });

  test("getMinimaxModelSpec returns the M3 spec with cost and compat metadata", () => {
    const spec = getMinimaxModelSpec("MiniMax-M3");
    expect(spec).toEqual({
      id: "MiniMax-M3",
      name: "MiniMax M3",
      baseUrl: "https://api.minimax.io/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 524_288,
      pricing: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
    });
  });

  test("getMinimaxModelSpec returns null for unknown ids", () => {
    expect(getMinimaxModelSpec("MiniMax-M2")).toBeNull();
  });

  test("resolveMinimaxApiKey prefers saved key then env", () => {
    expect(resolveMinimaxApiKey({ savedKey: "saved", env: { MINIMAX_API_KEY: "env" } })).toBe(
      "saved",
    );
    expect(resolveMinimaxApiKey({ env: { MINIMAX_API_KEY: "env" } })).toBe("env");
    expect(resolveMinimaxApiKey({ env: {} })).toBeUndefined();
    expect(resolveMinimaxApiKey({ savedKey: "  ", env: { MINIMAX_API_KEY: "env" } })).toBe("env");
  });
});
