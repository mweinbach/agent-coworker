import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  mergeConfigPatch,
  persistProjectConfigPatch,
} from "../../../src/server/runtime/ConfigPatchStore";
import { makeConfig } from "../../session/agentSession.harness";

describe("ConfigPatchStore", () => {
  test("persists advanced memory defaults to global config when provided", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-config-patch-"));
    const projectCoworkDir = path.join(dir, "project", ".cowork");
    const globalConfigDir = path.join(dir, "home", ".cowork", "config");

    await persistProjectConfigPatch(
      projectCoworkDir,
      {
        advancedMemory: true,
        memoryGenerationModel: "together:moonshotai/Kimi-K2.5",
        enableMemory: true,
      },
      undefined,
      { globalConfigDir },
    );

    const projectConfig = JSON.parse(
      await fs.readFile(path.join(projectCoworkDir, "config.json"), "utf-8"),
    ) as Record<string, unknown>;
    const globalConfig = JSON.parse(
      await fs.readFile(path.join(globalConfigDir, "config.json"), "utf-8"),
    ) as Record<string, unknown>;

    expect(projectConfig).toEqual({ enableMemory: true });
    expect(globalConfig).toEqual({
      advancedMemory: true,
      memoryGenerationModel: "together:moonshotai/Kimi-K2.5",
    });
  });

  test("clears a persisted memory generation model override", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-config-patch-"));
    const projectCoworkDir = path.join(dir, ".cowork");
    const configPath = path.join(projectCoworkDir, "config.json");
    await fs.mkdir(projectCoworkDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ memoryGenerationModel: "gemini-old", enableMemory: true })}\n`,
    );

    await persistProjectConfigPatch(projectCoworkDir, {
      clearMemoryGenerationModel: true,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    expect(persisted.enableMemory).toBe(true);
    expect("memoryGenerationModel" in persisted).toBe(false);
  });

  test("clears the runtime memory generation model override", () => {
    const merged = mergeConfigPatch(
      {
        ...makeConfig("/tmp/test-session"),
        memoryGenerationModel: "gemini-old",
      },
      { clearMemoryGenerationModel: true },
    );

    expect(merged.memoryGenerationModel).toBeUndefined();
  });
});
