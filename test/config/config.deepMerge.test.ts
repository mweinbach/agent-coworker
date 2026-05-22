import {
  fs,
  loadConfig,
  makeTmpDirs,
  os,
  path,
  repoRoot,
  withEnv,
  withMockedFetch,
  writeJson,
} from "./config.harness";
import { describe, expect, mock, test } from "bun:test";
import { defaultModelForProvider, getModel } from "../../src/config";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers";

describe("deepMerge (tested indirectly through recognized fields)", () => {
  test("project config overrides user config for same field", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".cowork", "config", "config.json"), {
      userName: "UserLevel",
      knowledgeCutoff: "2024",
    });

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      userName: "ProjectLevel",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    // Project overrides user for userName
    expect(cfg.userName).toBe("ProjectLevel");
    // Model metadata remains registry-backed.
    expect(cfg.knowledgeCutoff).toBe("January 2025");
  });

  test("project config can explicitly clear an inherited userName", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".cowork", "config", "config.json"), {
      userName: "UserLevel",
    });

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      userName: "",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.userName).toBe("");
  });

  test("does not mutate original objects (verified by loading twice)", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".cowork", "config", "config.json"), {
      userName: "Alice",
    });

    const cfg1 = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      userName: "Bob",
    });

    const cfg2 = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg1.userName).toBe("Alice");
    expect(cfg2.userName).toBe("Bob");
  });

  test("built-in defaults are used when no overrides exist", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    // Provider should come from built-in defaults
    expect(cfg.provider).toBe("google");
    expect(cfg.model).toBeTruthy();
  });
});

