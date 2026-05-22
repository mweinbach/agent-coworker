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

describe("loadJsonSafe (tested indirectly)", () => {
  test("returns {} for missing files (config loads without error)", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg).toBeDefined();
    expect(cfg.provider).toBe("google");
  });

  test("throws for invalid JSON config files", async () => {
    const { cwd, home } = await makeTmpDirs();

    const configPath = path.join(cwd, ".cowork", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "NOT VALID JSON {{{", "utf-8");

    await expect(
      loadConfig({
        cwd,
        homedir: home,
        builtInDir: repoRoot(),
        env: {},
      }),
    ).rejects.toThrow("Invalid JSON in config file");
  });

  test("parses valid JSON correctly", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-5");
  });
});
