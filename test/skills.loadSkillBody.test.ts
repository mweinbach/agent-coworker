import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadSkillBodyByName } from "../src/skills/loadSkillBody";
import type { AgentConfig } from "../src/types";

let workspaceRoot: string;
let userHome: string;

function makeConfig(skillsDirs: string[]): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: workspaceRoot,
    outputDirectory: path.join(workspaceRoot, "output"),
    uploadsDirectory: path.join(workspaceRoot, "uploads"),
    userName: "tester",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(workspaceRoot, ".cowork"),
    userCoworkDir: path.join(userHome, ".cowork"),
    workspaceAgentsDir: path.join(workspaceRoot, ".agents"),
    userAgentsDir: path.join(userHome, ".agents"),
    workspacePluginsDir: path.join(workspaceRoot, ".agents", "plugins"),
    userPluginsDir: path.join(userHome, ".agents", "plugins"),
    builtInDir: path.join(workspaceRoot, "builtin"),
    builtInConfigDir: path.join(workspaceRoot, "builtin", "config"),
    skillsDirs,
    memoryDirs: [],
    configDirs: [],
    enableMcp: false,
  } as unknown as AgentConfig;
}

async function createSkill(parentDir: string, name: string, body: string): Promise<void> {
  const skillDir = path.join(parentDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  const content = [
    "---",
    `name: "${name}"`,
    `description: "${name} description"`,
    "---",
    "",
    body,
  ].join("\n");
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loadskill-ws-"));
  userHome = await fs.mkdtemp(path.join(os.tmpdir(), "loadskill-home-"));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(userHome, { recursive: true, force: true });
});

describe("loadSkillBodyByName", () => {
  test("returns the body with front matter stripped", async () => {
    const skillsDir = path.join(workspaceRoot, "skills");
    await createSkill(skillsDir, "documents", "# Documents\nUse the doc workflow.");
    const config = makeConfig([skillsDir]);

    const loaded = await loadSkillBodyByName(config, "documents");
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe("documents");
    expect(loaded?.body).toContain("# Documents");
    expect(loaded?.body).not.toContain("---");
    expect(loaded?.body).not.toContain('name: "documents"');
  });

  test("frames a project-scope skill body as untrusted but not a higher-tier one", async () => {
    const projectDir = path.join(workspaceRoot, "project-skills");
    const globalDir = path.join(workspaceRoot, "global-skills");
    await createSkill(projectDir, "proj-skill", "# Project\nDo the thing.");
    await createSkill(globalDir, "global-skill", "# Global\nDo the other thing.");
    // skillsDirs index 0 -> project (untrusted), index 1 -> global (trusted).
    const config = makeConfig([projectDir, globalDir]);

    const projectLoaded = await loadSkillBodyByName(config, "proj-skill");
    expect(projectLoaded?.source).toBe("project");
    expect(projectLoaded?.body).toContain("UNTRUSTED PROJECT SKILL");
    expect(projectLoaded?.body).toContain("# Project");

    const globalLoaded = await loadSkillBodyByName(config, "global-skill");
    expect(globalLoaded?.source).toBe("global");
    expect(globalLoaded?.body).not.toContain("UNTRUSTED PROJECT SKILL");
    expect(globalLoaded?.body).toContain("# Global");
  });

  test("appends the policy overlay for the presentations skill", async () => {
    const skillsDir = path.join(workspaceRoot, "skills");
    await createSkill(skillsDir, "presentations", "# Slides\nBuild a deck.");
    const config = makeConfig([skillsDir]);

    const loaded = await loadSkillBodyByName(config, "presentations");
    expect(loaded?.body).toContain("# Slides");
    expect(loaded?.body).toContain("## Cowork Addendum");
  });

  test("returns null for an unknown skill", async () => {
    const skillsDir = path.join(workspaceRoot, "skills");
    await createSkill(skillsDir, "documents", "# Documents\n");
    const config = makeConfig([skillsDir]);

    expect(await loadSkillBodyByName(config, "does-not-exist")).toBeNull();
  });

  test("returns null for a2ui when the workspace feature flag disables it", async () => {
    const skillsDir = path.join(workspaceRoot, "skills");
    await createSkill(skillsDir, "a2ui", "# A2UI\nHidden guidance.");
    const config = {
      ...makeConfig([skillsDir]),
      enableA2ui: true,
      featureFlags: { workspace: { a2ui: false } },
    } as unknown as AgentConfig;

    expect(await loadSkillBodyByName(config, "a2ui")).toBeNull();
  });
});
