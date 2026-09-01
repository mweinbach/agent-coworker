import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  copyAgentProfile,
  deleteAgentProfile,
  getAgentProfileDir,
  readAgentProfilesCatalog,
  resolveAgentProfileSnapshot,
  setAgentProfileWorkspaceAvailability,
  upsertAgentProfile,
} from "../src/server/agents/profiles";
import type { AgentProfileUpsertInput } from "../src/shared/agentProfiles";
import type { AgentConfig } from "../src/types";

async function makeConfig(): Promise<AgentConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-profile-test-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const subAgentPrompts = path.join(root, "prompts", "sub-agents");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(subAgentPrompts, { recursive: true });
  await Promise.all(
    ["default", "explorer", "research", "worker", "reviewer"].map(async (role) => {
      await fs.writeFile(
        path.join(subAgentPrompts, `${role}.md`),
        `${role} built-in profile prompt.`,
        "utf-8",
      );
    }),
  );
  return {
    provider: "openai",
    model: "gpt-5.4",
    preferredChildModel: "gpt-5-mini",
    workingDirectory: workspace,
    outputDirectory: path.join(workspace, "output"),
    uploadsDirectory: path.join(workspace, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(workspace, ".cowork"),
    userCoworkDir: path.join(home, ".cowork"),
    builtInDir: root,
    builtInConfigDir: path.join(root, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
  };
}

function profile(overrides: Partial<AgentProfileUpsertInput> = {}): AgentProfileUpsertInput {
  return {
    version: 1,
    scope: "global",
    id: "qa-reviewer",
    displayName: "QA Reviewer",
    description: "Checks completed work.",
    enabled: true,
    baseRole: "reviewer",
    prompt: "Only report concrete defects.",
    allowedBuiltInTools: ["read", "grep", "read"],
    allowedMcpServers: ["github"],
    skillNames: ["code-review"],
    ...overrides,
  };
}

describe("agent profile catalog", () => {
  test("surfaces built-in subagent profiles without seeding profile files", async () => {
    const config = await makeConfig();

    const catalog = await readAgentProfilesCatalog(config);

    expect(catalog.profiles.map((entry) => entry.profile.id)).toEqual([
      "default",
      "explorer",
      "research",
      "worker",
      "reviewer",
    ]);
    expect(catalog.profiles.every((entry) => entry.scope === "global")).toBe(true);
    expect(catalog.profiles.every((entry) => entry.builtIn === true)).toBe(true);
    expect(catalog.effectiveProfiles).toHaveLength(5);
    expect(catalog.profiles.find((entry) => entry.profile.id === "default")).toMatchObject({
      builtIn: true,
      locked: true,
      effective: true,
      profile: {
        displayName: "Main Agent",
        enabled: true,
        prompt: "default built-in profile prompt.",
        defaultContextMode: "full",
      },
    });
    expect(catalog.profiles.find((entry) => entry.profile.id === "explorer")).toMatchObject({
      builtIn: true,
      profile: {
        displayName: "Explorer",
        description: "Read-only discovery and synthesis for focused knowledge work.",
        prompt: "explorer built-in profile prompt.",
      },
    });
    expect(catalog.profiles.find((entry) => entry.profile.id === "worker")).toMatchObject({
      builtIn: true,
      profile: {
        displayName: "Worker",
        description: "Execution-focused knowledge work with bounded ownership.",
      },
    });
  });

  test("keeps the built-in main agent enabled when edited", async () => {
    const config = await makeConfig();

    await upsertAgentProfile(
      config,
      profile({
        scope: "global",
        id: "default",
        displayName: "Customized Main",
        description: "Customized clone.",
        enabled: false,
        baseRole: "default",
        allowedBuiltInTools: ["read", "write"],
      }),
    );

    const catalog = await readAgentProfilesCatalog(config);
    const defaultProfiles = catalog.profiles.filter((entry) => entry.profile.id === "default");

    expect(defaultProfiles).toHaveLength(1);
    expect(defaultProfiles[0]).toMatchObject({
      scope: "global",
      locked: true,
      effective: true,
      profile: {
        displayName: "Customized Main",
        enabled: true,
      },
    });
    await expect(resolveAgentProfileSnapshot(config, "default")).resolves.toMatchObject({
      id: "default",
      ref: "global:default",
      displayName: "Customized Main",
      baseRole: "default",
    });
  });

  test("fills empty customized built-in role prompts from role defaults", async () => {
    const config = await makeConfig();

    await upsertAgentProfile(
      config,
      profile({
        scope: "global",
        id: "explorer",
        displayName: "Customized Explorer",
        description: "Customized discovery agent.",
        baseRole: "explorer",
        prompt: "",
        allowedBuiltInTools: ["read", "grep"],
      }),
    );

    const catalog = await readAgentProfilesCatalog(config);
    const explorer = catalog.profiles.find((entry) => entry.profile.id === "explorer");

    expect(explorer).toMatchObject({
      scope: "global",
      effective: true,
      profile: {
        displayName: "Customized Explorer",
        prompt: "explorer built-in profile prompt.",
      },
    });
    expect(explorer?.builtIn).toBeUndefined();
    await expect(resolveAgentProfileSnapshot(config, "explorer")).resolves.toMatchObject({
      id: "explorer",
      prompt: "explorer built-in profile prompt.",
    });
  });

  test("disabled user profile overrides can hide a built-in profile", async () => {
    const config = await makeConfig();

    await upsertAgentProfile(
      config,
      profile({
        scope: "workspace",
        id: "reviewer",
        displayName: "Reviewer Override",
        enabled: false,
        baseRole: "reviewer",
      }),
    );

    const catalog = await readAgentProfilesCatalog(config);

    expect(
      catalog.profiles.find((entry) => entry.profile.id === "reviewer" && entry.builtIn),
    ).toMatchObject({
      scope: "global",
      shadowed: true,
      effective: false,
    });
    await expect(resolveAgentProfileSnapshot(config, "reviewer")).rejects.toThrow(
      "Subagent profile is disabled: workspace:reviewer",
    );
    await expect(resolveAgentProfileSnapshot(config, "global:reviewer")).resolves.toMatchObject({
      id: "reviewer",
      ref: "global:reviewer",
      displayName: "Reviewer",
    });
  });

  test("reads global and workspace profiles with workspace precedence", async () => {
    const config = await makeConfig();

    await upsertAgentProfile(config, profile());
    await upsertAgentProfile(
      config,
      profile({
        scope: "workspace",
        displayName: "Workspace QA",
        description: "Workspace-specific checks.",
        enabled: true,
        baseRole: "worker",
        model: "gpt-5.4-mini",
        reasoningEffort: "high",
        defaultTaskType: "verify",
        defaultContextMode: "brief",
        allowedBuiltInTools: ["read", "edit"],
        allowedMcpServers: ["linear"],
        skillNames: ["visual-verdict"],
      }),
    );

    const catalog = await readAgentProfilesCatalog(config);
    expect(catalog.roots).toEqual({
      globalDir: getAgentProfileDir(config, "global"),
      workspaceDir: getAgentProfileDir(config, "workspace"),
    });
    expect(catalog.profiles).toHaveLength(7);
    expect(catalog.profiles.find((entry) => entry.scope === "global")).toMatchObject({
      effective: false,
      shadowed: true,
      profile: {
        id: "qa-reviewer",
        allowedBuiltInTools: ["read", "grep"],
      },
    });
    expect(catalog.effectiveProfiles).toHaveLength(6);
    expect(
      catalog.effectiveProfiles.find((entry) => entry.profile.id === "qa-reviewer"),
    ).toMatchObject({
      scope: "workspace",
      effective: true,
      shadowed: false,
      profile: {
        id: "qa-reviewer",
        displayName: "Workspace QA",
        baseRole: "worker",
      },
    });

    const snapshot = await resolveAgentProfileSnapshot(config, "qa-reviewer");
    expect(snapshot).toMatchObject({
      id: "qa-reviewer",
      ref: "workspace:qa-reviewer",
      scope: "workspace",
      baseRole: "worker",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      defaultTaskType: "verify",
      defaultContextMode: "brief",
      skillNames: ["visual-verdict"],
    });
  });

  test("reports invalid profile files without hiding valid profiles", async () => {
    const config = await makeConfig();
    await upsertAgentProfile(config, profile());
    const badPath = path.join(getAgentProfileDir(config, "workspace"), "bad.json");
    await fs.mkdir(path.dirname(badPath), { recursive: true });
    await fs.writeFile(badPath, "{ nope", "utf-8");

    const catalog = await readAgentProfilesCatalog(config);

    expect(catalog.effectiveProfiles.map((entry) => entry.profile.id)).toEqual([
      "qa-reviewer",
      "default",
      "explorer",
      "research",
      "worker",
      "reviewer",
    ]);
    expect(catalog.diagnostics).toEqual([
      expect.objectContaining({
        scope: "workspace",
        path: badPath,
        severity: "error",
        message: expect.stringContaining("Invalid agent profile"),
      }),
    ]);
  });

  test("copy and delete update scoped profile files", async () => {
    const config = await makeConfig();
    await upsertAgentProfile(config, profile());

    let catalog = await copyAgentProfile(config, {
      sourceRef: "global:qa-reviewer",
      targetScope: "workspace",
      targetId: "qa-reviewer-copy",
      targetDisplayName: "QA Reviewer Copy",
    });

    expect(
      catalog.effectiveProfiles
        .map((entry) => entry.profile.id)
        .filter((id) => id.startsWith("qa-reviewer"))
        .sort(),
    ).toEqual(["qa-reviewer", "qa-reviewer-copy"]);
    expect(
      catalog.effectiveProfiles.find((entry) => entry.profile.id === "qa-reviewer-copy"),
    ).toMatchObject({
      scope: "workspace",
      profile: {
        displayName: "QA Reviewer Copy",
        prompt: "Only report concrete defects.",
      },
    });

    catalog = await deleteAgentProfile(config, "workspace", "qa-reviewer-copy");
    expect(
      catalog.effectiveProfiles
        .map((entry) => entry.profile.id)
        .filter((id) => id.startsWith("qa-reviewer")),
    ).toEqual(["qa-reviewer"]);
  });

  test("copy allows disabled source profiles without enabling them for spawn", async () => {
    const config = await makeConfig();
    await upsertAgentProfile(config, profile({ enabled: false }));

    const catalog = await copyAgentProfile(config, {
      sourceRef: "global:qa-reviewer",
      targetScope: "workspace",
      targetId: "qa-reviewer-copy",
      targetDisplayName: "QA Reviewer Copy",
    });

    const copied = catalog.effectiveProfiles.find(
      (entry) => entry.profile.id === "qa-reviewer-copy",
    );
    expect(copied).toMatchObject({
      scope: "workspace",
      profile: {
        enabled: true,
        prompt: "Only report concrete defects.",
      },
    });
    await expect(resolveAgentProfileSnapshot(config, "global:qa-reviewer")).rejects.toThrow(
      "Subagent profile is disabled: global:qa-reviewer",
    );
  });

  for (const mutation of ["upsert", "copy", "availability"] as const) {
    test(`${mutation} preserves the existing file when a replacement write fails`, async () => {
      const config = await makeConfig();
      await upsertAgentProfile(config, profile());
      await upsertAgentProfile(config, profile({ scope: "workspace", displayName: "Original" }));
      await setAgentProfileWorkspaceAvailability(config, "research", true);
      const dir = getAgentProfileDir(config, "workspace");
      const filePath = path.join(
        dir,
        mutation === "availability" ? "workspace-overrides.json" : "qa-reviewer.json",
      );
      const before = await fs.readFile(filePath, "utf-8");
      const filesBefore = (await fs.readdir(dir)).sort();
      const mutate = () => {
        if (mutation === "availability") {
          return setAgentProfileWorkspaceAvailability(config, "explorer", true);
        }
        if (mutation === "copy") {
          return copyAgentProfile(config, {
            sourceRef: "global:qa-reviewer",
            targetScope: "workspace",
          });
        }
        return upsertAgentProfile(config, profile({ scope: "workspace", displayName: "Updated" }));
      };
      const writeFile = fs.writeFile.bind(fs);
      const write = spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
        if (typeof target === "string" && path.dirname(target) === dir) {
          await writeFile(target, '{"partial":', options);
          throw new Error("Injected profile write failure");
        }
        return await writeFile(target, data, options);
      });
      try {
        await expect(mutate()).rejects.toThrow("Injected profile write failure");
      } finally {
        write.mockRestore();
      }

      expect(await fs.readFile(filePath, "utf-8")).toBe(before);
      expect((await fs.readdir(dir)).sort()).toEqual(filesBefore);
      expect((await mutate()).diagnostics).toEqual([]);
    });
  }

  test("deleting a profile waits for its pending save instead of resurrecting it", async () => {
    const config = await makeConfig();
    await upsertAgentProfile(config, profile());
    const dir = getAgentProfileDir(config, "global");
    const filePath = path.join(dir, "qa-reviewer.json");
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let reportWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      reportWriteStarted = resolve;
    });
    const writeFile = fs.writeFile.bind(fs);
    const write = spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
      if (typeof target === "string" && path.dirname(target) === dir) {
        reportWriteStarted();
        await writeReleased;
      }
      return await writeFile(target, data, options);
    });
    const unlinkFile = fs.unlink.bind(fs);
    const deletionAttempt: { promise?: Promise<void> } = {};
    const unlink = spyOn(fs, "unlink").mockImplementation((target) => {
      const promise = unlinkFile(target);
      if (target === filePath) deletionAttempt.promise = promise;
      return promise;
    });
    const saving = upsertAgentProfile(config, profile({ displayName: "Pending save" }));
    let deleting: ReturnType<typeof deleteAgentProfile> | undefined;
    try {
      await writeStarted;
      deleting = deleteAgentProfile(config, "global", "qa-reviewer");
      // An unlocked delete reaches unlink immediately. Let it finish before the
      // pending save so the resurrection regression has a deterministic order.
      await deletionAttempt.promise;
      releaseWrite();
      await Promise.all([saving, deleting]);

      await expect(fs.access(filePath)).rejects.toThrow();
      const catalog = await readAgentProfilesCatalog(config);
      expect(catalog.profiles.some((entry) => entry.profile.id === "qa-reviewer")).toBe(false);
    } finally {
      releaseWrite();
      await Promise.allSettled([saving, deleting]);
      write.mockRestore();
      unlink.mockRestore();
    }
  });

  test("workspace availability overrides disable global profiles for one workspace", async () => {
    const config = await makeConfig();
    await upsertAgentProfile(config, profile());

    let catalog = await setAgentProfileWorkspaceAvailability(config, "qa-reviewer", true);
    expect(
      catalog.profiles.find(
        (entry) => entry.scope === "global" && entry.profile.id === "qa-reviewer",
      ),
    ).toMatchObject({
      workspaceDisabled: true,
      shadowed: false,
      effective: false,
    });
    expect(catalog.effectiveProfiles.some((entry) => entry.profile.id === "qa-reviewer")).toBe(
      false,
    );

    await expect(resolveAgentProfileSnapshot(config, "qa-reviewer")).rejects.toThrow(
      "Subagent profile is disabled in this workspace: global:qa-reviewer",
    );
    await expect(resolveAgentProfileSnapshot(config, "global:qa-reviewer")).rejects.toThrow(
      "Subagent profile is disabled in this workspace: global:qa-reviewer",
    );

    catalog = await setAgentProfileWorkspaceAvailability(config, "qa-reviewer", false);
    expect(
      catalog.profiles.find(
        (entry) => entry.scope === "global" && entry.profile.id === "qa-reviewer",
      ),
    ).toMatchObject({
      workspaceDisabled: false,
      effective: true,
    });
    await expect(resolveAgentProfileSnapshot(config, "qa-reviewer")).resolves.toMatchObject({
      id: "qa-reviewer",
      ref: "global:qa-reviewer",
    });
  });

  test("workspace availability overrides apply to built-in profiles", async () => {
    const config = await makeConfig();

    const catalog = await setAgentProfileWorkspaceAvailability(config, "research", true);
    expect(catalog.profiles.find((entry) => entry.profile.id === "research")).toMatchObject({
      builtIn: true,
      workspaceDisabled: true,
      effective: false,
    });
    expect(catalog.effectiveProfiles.map((entry) => entry.profile.id)).toEqual([
      "default",
      "explorer",
      "worker",
      "reviewer",
    ]);
    await expect(resolveAgentProfileSnapshot(config, "research")).rejects.toThrow(
      "Subagent profile is disabled in this workspace: global:research",
    );
  });

  test("workspace availability override file round-trips and clears when empty", async () => {
    const config = await makeConfig();
    const overridesPath = path.join(
      getAgentProfileDir(config, "workspace"),
      "workspace-overrides.json",
    );

    await setAgentProfileWorkspaceAvailability(config, "research", true);
    await setAgentProfileWorkspaceAvailability(config, "explorer", true);
    expect(JSON.parse(await fs.readFile(overridesPath, "utf-8"))).toEqual({
      version: 1,
      disabledGlobalProfileIds: ["explorer", "research"],
    });

    // The overrides file must not surface as a broken profile.
    const catalog = await readAgentProfilesCatalog(config);
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.profiles.some((entry) => entry.path?.endsWith("workspace-overrides.json"))).toBe(
      false,
    );

    await setAgentProfileWorkspaceAvailability(config, "research", false);
    await setAgentProfileWorkspaceAvailability(config, "explorer", false);
    await expect(fs.access(overridesPath)).rejects.toThrow();
  });

  test("concurrent availability changes preserve every disabled profile", async () => {
    const config = await makeConfig();
    const ids = ["explorer", "research", "reviewer", "worker"];

    await Promise.all(ids.map((id) => setAgentProfileWorkspaceAvailability(config, id, true)));

    const catalog = await readAgentProfilesCatalog(config);
    expect(
      catalog.profiles
        .filter((entry) => entry.workspaceDisabled)
        .map((entry) => entry.profile.id)
        .sort(),
    ).toEqual(ids);
    expect(catalog.diagnostics).toEqual([]);
  });

  test("concurrent enable and disable changes do not clear unrelated availability", async () => {
    const config = await makeConfig();
    await setAgentProfileWorkspaceAvailability(config, "research", true);

    await Promise.all([
      setAgentProfileWorkspaceAvailability(config, "research", false),
      setAgentProfileWorkspaceAvailability(config, "explorer", true),
    ]);

    const catalog = await readAgentProfilesCatalog(config);
    expect(
      catalog.profiles.filter((entry) => entry.workspaceDisabled).map((entry) => entry.profile.id),
    ).toEqual(["explorer"]);
    expect(catalog.diagnostics).toEqual([]);
  });

  test("availability changes preserve an invalid overrides file instead of resetting it", async () => {
    const config = await makeConfig();
    const dir = getAgentProfileDir(config, "workspace");
    const filePath = path.join(dir, "workspace-overrides.json");
    const malformed = '{"version":1,"disabledGlobalProfileIds":["research"';
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, malformed, "utf-8");

    await expect(setAgentProfileWorkspaceAvailability(config, "explorer", true)).rejects.toThrow(
      "Invalid workspace subagent overrides",
    );

    expect(await fs.readFile(filePath, "utf-8")).toBe(malformed);
  });

  test("rejects the reserved workspace overrides profile id", async () => {
    const config = await makeConfig();
    await upsertAgentProfile(config, profile());
    const overridesPath = path.join(
      getAgentProfileDir(config, "workspace"),
      "workspace-overrides.json",
    );
    await setAgentProfileWorkspaceAvailability(config, "research", true);

    await expect(
      upsertAgentProfile(config, profile({ scope: "workspace", id: "workspace-overrides" })),
    ).rejects.toThrow("Reserved subagent profile id: workspace-overrides");
    await expect(
      copyAgentProfile(config, {
        sourceRef: "global:qa-reviewer",
        targetScope: "workspace",
        targetId: "workspace-overrides",
      }),
    ).rejects.toThrow("Reserved subagent profile id: workspace-overrides");
    await expect(deleteAgentProfile(config, "workspace", "workspace-overrides")).rejects.toThrow(
      "Reserved subagent profile id: workspace-overrides",
    );

    expect(JSON.parse(await fs.readFile(overridesPath, "utf-8"))).toEqual({
      version: 1,
      disabledGlobalProfileIds: ["research"],
    });
  });

  test("workspace availability rejects the locked main profile and unknown ids", async () => {
    const config = await makeConfig();

    await expect(setAgentProfileWorkspaceAvailability(config, "default", true)).rejects.toThrow(
      "The main agent profile is always available and cannot be disabled.",
    );
    await expect(setAgentProfileWorkspaceAvailability(config, "missing", true)).rejects.toThrow(
      "Unknown global subagent profile: missing",
    );
  });

  test("rejects missing and disabled profile refs", async () => {
    const config = await makeConfig();
    await upsertAgentProfile(config, profile({ enabled: false }));

    await expect(resolveAgentProfileSnapshot(config, "missing-profile")).rejects.toThrow(
      "Unknown subagent profile",
    );
    await expect(resolveAgentProfileSnapshot(config, "qa-reviewer")).rejects.toThrow(
      "Subagent profile is disabled: global:qa-reviewer",
    );
  });
});
