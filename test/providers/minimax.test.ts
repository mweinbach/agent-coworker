import { describe, expect, test } from "bun:test";
import path from "node:path";

import { defaultModelForProvider, loadConfig } from "../../src/config";
import {
  getMinimaxModelSpec,
  isMiniMaxModelId,
  resolveMinimaxApiKey,
} from "../../src/providers/minimaxShared";
import { makeTmpDirs, repoRoot, writeJson } from "./helpers";

describe("MiniMax provider", () => {
  test("defaultModelForProvider returns MiniMax-M3", () => {
    expect(defaultModelForProvider("minimax")).toBe("MiniMax-M3");
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
