import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../../src/config";
import { scratchRoots } from "../../../src/platform/sandbox/policy";
import {
  mergeConfigPatch,
  type ProjectConfigPatch,
  persistProjectConfigPatch,
} from "../../../src/server/runtime/ConfigPatchStore";
import { defaultRuntimeNameForProvider } from "../../../src/types";
import { pinHome } from "../../helpers/platform";
import { makeConfig, makeSession } from "../../session/agentSession.harness";

const testScratchRoot = scratchRoots()[0];
if (!testScratchRoot) {
  throw new Error("Expected at least one platform scratch root");
}

describe("ConfigPatchStore", () => {
  let configTestHome: string;
  let restoreHome: () => void;

  beforeAll(async () => {
    configTestHome = await fs.mkdtemp(path.join(testScratchRoot, "cowork-config-test-home-"));
    restoreHome = pinHome(configTestHome);
  });

  afterAll(async () => {
    restoreHome?.();
    if (configTestHome) await fs.rm(configTestHome, { recursive: true, force: true });
  });

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

  test.each([true, false])(
    "persists explicit observability consent (%s) to user config across reloads",
    async (enabled) => {
      const dir = await fs.mkdtemp(path.join(testScratchRoot, "cowork-observability-consent-"));
      const cwd = path.join(dir, "project");
      const home = path.join(dir, "home");
      const projectCoworkDir = path.join(cwd, ".cowork");
      const globalConfigDir = path.join(home, ".cowork", "config");
      const projectConfigPath = path.join(projectCoworkDir, "config.json");
      const userConfigPath = path.join(globalConfigDir, "config.json");
      const configOptions = {
        cwd,
        homedir: home,
        builtInDir: path.resolve(import.meta.dir, "../../.."),
        env: {},
      };

      try {
        await fs.mkdir(projectCoworkDir, { recursive: true });
        await fs.mkdir(globalConfigDir, { recursive: true });
        await fs.writeFile(
          projectConfigPath,
          JSON.stringify({ observabilityEnabled: !enabled, userName: "Project User" }),
        );
        await fs.writeFile(userConfigPath, JSON.stringify({ observabilityEnabled: !enabled }));
        const config = await loadConfig(configOptions);
        const { session, events } = makeSession({
          config,
          persistProjectConfigPatchImpl: (patch) =>
            persistProjectConfigPatch(projectCoworkDir, patch, undefined, { globalConfigDir }),
        });

        await session.setConfig({ observabilityEnabled: enabled });

        expect(events.filter((event) => event.type === "error")).toEqual([]);
        expect(session.getSessionConfigEvent().config.observabilityEnabled).toBe(enabled);
        expect(JSON.parse(await fs.readFile(userConfigPath, "utf8"))).toEqual({
          observabilityEnabled: enabled,
        });
        expect(JSON.parse(await fs.readFile(projectConfigPath, "utf8"))).toEqual({
          userName: "Project User",
        });
        expect((await loadConfig(configOptions)).observabilityEnabled).toBe(enabled);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("rejects observability consent without a trusted user config directory", async () => {
    const dir = await fs.mkdtemp(path.join(testScratchRoot, "cowork-observability-missing-home-"));
    const projectCoworkDir = path.join(dir, ".cowork");
    const configPath = path.join(projectCoworkDir, "config.json");
    const original = JSON.stringify({ observabilityEnabled: false, userName: "Unchanged" });

    try {
      await fs.mkdir(projectCoworkDir);
      await fs.writeFile(configPath, original);

      await expect(
        persistProjectConfigPatch(projectCoworkDir, {
          observabilityEnabled: true,
          userName: "Changed",
        }),
      ).rejects.toThrow("user config directory");

      expect(await fs.readFile(configPath, "utf8")).toBe(original);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves a workspace telemetry restriction if the user consent write fails", async () => {
    const dir = await fs.mkdtemp(path.join(testScratchRoot, "cowork-observability-write-failure-"));
    const projectCoworkDir = path.join(dir, "project", ".cowork");
    const globalConfigDir = path.join(dir, "home", ".cowork", "config");
    const configPath = path.join(projectCoworkDir, "config.json");
    const original = JSON.stringify({ observabilityEnabled: false, userName: "Unchanged" });

    try {
      await fs.mkdir(projectCoworkDir, { recursive: true });
      await fs.mkdir(globalConfigDir, { recursive: true });
      await fs.writeFile(configPath, original);
      await fs.writeFile(path.join(globalConfigDir, "config.json"), "invalid json");

      await expect(
        persistProjectConfigPatch(projectCoworkDir, { observabilityEnabled: true }, undefined, {
          globalConfigDir,
        }),
      ).rejects.toThrow("Invalid JSON");

      expect(await fs.readFile(configPath, "utf8")).toBe(original);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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

  test("preserves independent concurrent project config updates", async () => {
    const dir = await fs.mkdtemp(path.join(testScratchRoot, "cowork-config-concurrent-"));
    const projectCoworkDir = path.join(dir, "project", ".cowork");
    try {
      await Promise.all([
        persistProjectConfigPatch(projectCoworkDir, { enableMemory: false }),
        persistProjectConfigPatch(projectCoworkDir, { enableMcp: true }),
        persistProjectConfigPatch(projectCoworkDir, { backupsEnabled: true }),
      ]);

      const persisted = JSON.parse(
        await fs.readFile(path.join(projectCoworkDir, "config.json"), "utf-8"),
      );
      expect(persisted).toEqual({
        enableMemory: false,
        enableMcp: true,
        backupsEnabled: true,
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves concurrent global config updates from different workspaces", async () => {
    const dir = await fs.mkdtemp(path.join(testScratchRoot, "cowork-config-concurrent-global-"));
    const globalConfigDir = path.join(dir, "home", ".cowork", "config");
    try {
      await Promise.all([
        persistProjectConfigPatch(
          path.join(dir, "project-a", ".cowork"),
          { advancedMemory: true },
          undefined,
          { globalConfigDir },
        ),
        persistProjectConfigPatch(
          path.join(dir, "project-b", ".cowork"),
          { skillImprovementEnabled: true },
          undefined,
          { globalConfigDir },
        ),
      ]);

      const persisted = JSON.parse(
        await fs.readFile(path.join(globalConfigDir, "config.json"), "utf-8"),
      );
      expect(persisted).toEqual({ advancedMemory: true, skillImprovementEnabled: true });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
