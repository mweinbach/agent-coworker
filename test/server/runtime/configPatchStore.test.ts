import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { scratchRoots } from "../../../src/platform/sandbox/policy";
import {
  mergeConfigPatch,
  type ProjectConfigPatch,
  persistProjectConfigPatch,
} from "../../../src/server/runtime/ConfigPatchStore";
import { defaultRuntimeNameForProvider } from "../../../src/types";
import { makeConfig } from "../../session/agentSession.harness";

const testScratchRoot = scratchRoots()[0];
if (!testScratchRoot) {
  throw new Error("Expected at least one platform scratch root");
}

describe("ConfigPatchStore", () => {
  test("persists model selection defaults and round-trips them through runtime config", async () => {
    const dir = await fs.mkdtemp(path.join(testScratchRoot, "cowork-config-patch-"));
    const projectCoworkDir = path.join(dir, "project", ".cowork");
    const configPath = path.join(projectCoworkDir, "config.json");
    const modelPatch = {
      provider: "openai",
      model: "gpt-5.5",
      preferredChildModel: "claude-opus-4-8",
      childModelRoutingMode: "cross-provider-allowlist",
      preferredChildModelRef: "anthropic:claude-opus-4-8",
      allowedChildModelRefs: ["anthropic:claude-opus-4-8", "google:gemini-3-pro"],
    } satisfies ProjectConfigPatch;

    await persistProjectConfigPatch(projectCoworkDir, modelPatch);

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    expect(persisted).toEqual(modelPatch);

    const merged = mergeConfigPatch(
      {
        ...makeConfig(dir),
        provider: "google",
        runtime: defaultRuntimeNameForProvider("google"),
        model: "gemini-3-flash-preview",
        preferredChildModel: "gemini-3-flash-preview",
      },
      modelPatch,
    );

    expect(merged.provider).toBe("openai");
    expect(merged.runtime).toBe(defaultRuntimeNameForProvider("openai"));
    expect(merged.model).toBe("gpt-5.5");
    expect(merged.preferredChildModel).toBe("claude-opus-4-8");
    expect(merged.childModelRoutingMode).toBe("cross-provider-allowlist");
    expect(merged.preferredChildModelRef).toBe("anthropic:claude-opus-4-8");
    expect(merged.allowedChildModelRefs).toEqual([
      "anthropic:claude-opus-4-8",
      "google:gemini-3-pro",
    ]);
  });

  test("persists advanced memory defaults to global config when provided", async () => {
    const dir = await fs.mkdtemp(path.join(testScratchRoot, "cowork-config-patch-"));
    const projectCoworkDir = path.join(dir, "project", ".cowork");
    const globalConfigDir = path.join(dir, "home", ".cowork", "config");

    await persistProjectConfigPatch(
      projectCoworkDir,
      {
        advancedMemory: true,
        memoryGenerationModel: "together:moonshotai/Kimi-K2.5",
        skillImprovementEnabled: true,
        skillImprovementModel: "openai:gpt-5.5",
        skillImprovementScope: "all",
        skillImprovementExcludedSkills: ["legacy-skill"],
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
      skillImprovementEnabled: true,
      skillImprovementModel: "openai:gpt-5.5",
      skillImprovementScope: "all",
      skillImprovementExcludedSkills: ["legacy-skill"],
    });
  });

  test("clears a persisted memory generation model override", async () => {
    const dir = await fs.mkdtemp(path.join(testScratchRoot, "cowork-config-patch-"));
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
        ...makeConfig(path.join(testScratchRoot, "test-session")),
        memoryGenerationModel: "gemini-old",
      },
      { clearMemoryGenerationModel: true },
    );

    expect(merged.memoryGenerationModel).toBeUndefined();
  });

  test("clears persisted and runtime skill improvement model overrides", async () => {
    const dir = await fs.mkdtemp(path.join(testScratchRoot, "cowork-config-patch-"));
    const projectCoworkDir = path.join(dir, ".cowork");
    const configPath = path.join(projectCoworkDir, "config.json");
    await fs.mkdir(projectCoworkDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ skillImprovementModel: "openai:gpt-5.5", enableMemory: true })}\n`,
    );

    await persistProjectConfigPatch(projectCoworkDir, {
      clearSkillImprovementModel: true,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    expect(persisted.enableMemory).toBe(true);
    expect("skillImprovementModel" in persisted).toBe(false);

    const merged = mergeConfigPatch(
      {
        ...makeConfig(path.join(testScratchRoot, "test-session")),
        skillImprovementModel: "openai:gpt-5.5",
      },
      { clearSkillImprovementModel: true },
    );
    expect(merged.skillImprovementModel).toBeUndefined();
  });
});
