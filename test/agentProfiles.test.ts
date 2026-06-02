import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  copyAgentProfile,
  deleteAgentProfile,
  getAgentProfileDir,
  readAgentProfilesCatalog,
  resolveAgentProfileSnapshot,
  upsertAgentProfile,
} from "../src/server/agents/profiles";
import type { AgentProfileUpsertInput } from "../src/shared/agentProfiles";
import type { AgentConfig } from "../src/types";

async function makeConfig(): Promise<AgentConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-profile-test-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
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
    expect(catalog.profiles).toHaveLength(2);
    expect(catalog.profiles.find((entry) => entry.scope === "global")).toMatchObject({
      effective: false,
      shadowed: true,
      profile: {
        id: "qa-reviewer",
        allowedBuiltInTools: ["read", "grep"],
      },
    });
    expect(catalog.effectiveProfiles).toHaveLength(1);
    expect(catalog.effectiveProfiles[0]).toMatchObject({
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

    expect(catalog.effectiveProfiles.map((entry) => entry.profile.id)).toEqual(["qa-reviewer"]);
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

    expect(catalog.effectiveProfiles.map((entry) => entry.profile.id).sort()).toEqual([
      "qa-reviewer",
      "qa-reviewer-copy",
    ]);
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
    expect(catalog.effectiveProfiles.map((entry) => entry.profile.id)).toEqual(["qa-reviewer"]);
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
