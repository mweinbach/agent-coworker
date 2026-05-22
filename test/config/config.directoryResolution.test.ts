import { describe, expect, mock, test } from "bun:test";
import { defaultModelForProvider, getModel } from "../../src/config";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers";
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

describe("directory resolution", () => {
  test("relative outputDirectory resolved against cwd", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      outputDirectory: "my-output",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.outputDirectory).toBe(path.join(cwd, "my-output"));
  });

  test("absolute outputDirectory inside workspace used as-is", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      outputDirectory: path.join(cwd, "deep", "output"),
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.outputDirectory).toBe(path.join(cwd, "deep", "output"));
  });

  test("absolute outputDirectory outside workspace falls back to cwd", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      outputDirectory: "/absolute/output/path",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.outputDirectory).toBe(cwd);
  });

  test("relative outputDirectory with traversal falls back to cwd", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      outputDirectory: "../../../etc",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.outputDirectory).toBe(cwd);
  });

  test("relative uploadsDirectory resolved against cwd", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      uploadsDirectory: "my-uploads",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.uploadsDirectory).toBe(path.join(cwd, "my-uploads"));
  });

  test("absolute uploadsDirectory outside workspace falls back to cwd", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_UPLOADS_DIR: "/abs/uploads" },
    });

    expect(cfg.uploadsDirectory).toBe(cwd);
  });

  test("relative uploadsDirectory with traversal falls back to cwd", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      uploadsDirectory: "../../sensitive",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.uploadsDirectory).toBe(cwd);
  });

  test("default outputDirectory is undefined when not configured", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.outputDirectory).toBeUndefined();
  });

  test("default uploadsDirectory is undefined when not configured", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.uploadsDirectory).toBeUndefined();
  });

  test("skillsDirs populated with 3 paths (project, user-global, built-in)", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.skillsDirs).toHaveLength(3);
    expect(cfg.skillsDirs[0]).toBe(path.join(cwd, ".cowork", "skills"));
    expect(cfg.skillsDirs[1]).toBe(path.join(home, ".cowork", "skills"));
    expect(cfg.skillsDirs[2]).toBe(path.join(repoRoot(), "skills"));
  });

  test("skillsDirs omit built-in skills when COWORK_DISABLE_BUILTIN_SKILLS is enabled", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { COWORK_DISABLE_BUILTIN_SKILLS: "1" },
    });

    expect(cfg.skillsDirs).toHaveLength(2);
    expect(cfg.skillsDirs[0]).toBe(path.join(cwd, ".cowork", "skills"));
    expect(cfg.skillsDirs[1]).toBe(path.join(home, ".cowork", "skills"));
  });

  test("memoryDirs populated correctly", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.memoryDirs).toHaveLength(2);
    expect(cfg.memoryDirs[0]).toBe(path.join(cwd, ".cowork", "memory"));
    expect(cfg.memoryDirs[1]).toBe(path.join(home, ".cowork", "memory"));
  });

  test("configDirs populated correctly", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.configDirs).toHaveLength(3);
    expect(cfg.configDirs[0]).toBe(path.join(cwd, ".cowork"));
    expect(cfg.configDirs[1]).toBe(path.join(home, ".cowork", "config"));
    expect(cfg.configDirs[2]).toBe(path.join(repoRoot(), "config"));
  });

  test("projectCoworkDir and userCoworkDir set correctly", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.projectCoworkDir).toBe(path.join(cwd, ".cowork"));
    expect(cfg.userCoworkDir).toBe(path.join(home, ".cowork"));
  });

  test("builtInDir and builtInConfigDir set correctly", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.builtInDir).toBe(repoRoot());
    expect(cfg.builtInConfigDir).toBe(path.join(repoRoot(), "config"));
  });
});

// ---------------------------------------------------------------------------
// getModel
// ---------------------------------------------------------------------------
