import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listCommands } from "../src/server/commands";
import { discoverSkillsForConfig } from "../src/skills";
import { loadSkillBodyByName } from "../src/skills/loadSkillBody";
import { getSkillCatalog } from "../src/skills/operations";
import type { AgentConfig } from "../src/types";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

async function makeGatedConfig(overrides: Partial<AgentConfig> = {}): Promise<AgentConfig> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-gates-"));
  const projectSkills = path.join(dir, ".cowork", "skills");
  const globalSkills = path.join(dir, "home", ".cowork", "skills");
  await fs.mkdir(projectSkills, { recursive: true });
  await fs.mkdir(globalSkills, { recursive: true });
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(dir, ".cowork"),
    userCoworkDir: path.join(dir, "home", ".cowork"),
    builtInDir: repoRoot(),
    builtInConfigDir: path.join(repoRoot(), "config"),
    skillsDirs: [projectSkills, globalSkills, path.join(repoRoot(), "skills")],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

function skillDoc(name: string, description: string, body: string): string {
  return ["---", `name: "${name}"`, `description: "${description}"`, "---", "", body].join("\n");
}

describe("feature-gated built-in skills", () => {
  test("task skill is hidden from discovery when tasks are disabled", async () => {
    const config = await makeGatedConfig();
    const discovered = await discoverSkillsForConfig(config);
    expect(discovered.find((skill) => skill.name === "task")).toBeUndefined();
    expect(await loadSkillBodyByName(config, "task")).toBeNull();
  });

  test("task skill is discoverable when tasks are enabled", async () => {
    const config = await makeGatedConfig({ tasksEnabled: true });
    const discovered = await discoverSkillsForConfig(config);
    expect(discovered.find((skill) => skill.name === "task")).toMatchObject({
      name: "task",
      enabled: true,
    });
    const loaded = await loadSkillBodyByName(config, "task");
    expect(loaded?.body).toContain("createTask");
  });

  test("memories skill is hidden from discovery unless advanced memory is on", async () => {
    const offConfig = await makeGatedConfig();
    const discoveredOff = await discoverSkillsForConfig(offConfig);
    expect(discoveredOff.find((skill) => skill.name === "memories")).toBeUndefined();
    expect(await loadSkillBodyByName(offConfig, "memories")).toBeNull();

    const onConfig = await makeGatedConfig({ advancedMemory: true });
    const discoveredOn = await discoverSkillsForConfig(onConfig);
    expect(discoveredOn.find((skill) => skill.name === "memories")).toMatchObject({
      name: "memories",
      enabled: true,
    });
    const loaded = await loadSkillBodyByName(onConfig, "memories");
    expect(loaded?.body).toContain("manageMemory");
  });

  test("/task slash command follows the tasks feature flag", async () => {
    const disabled = await makeGatedConfig();
    const disabledNames = (await listCommands(disabled)).map((command) => command.name);
    expect(disabledNames).not.toContain("task");

    const enabled = await makeGatedConfig({ tasksEnabled: true });
    const enabledNames = (await listCommands(enabled)).map((command) => command.name);
    expect(enabledNames).toContain("task");
  });

  test("built-in task and memories never appear in the management catalog", async () => {
    const config = await makeGatedConfig({ tasksEnabled: true, advancedMemory: true });
    const catalog = await getSkillCatalog(config);
    const names = catalog.installations.map((installation) => installation.name);
    expect(names).not.toContain("task");
    expect(names).not.toContain("memories");
    expect(
      catalog.effectiveSkills.find(
        (installation) => installation.name === "task" || installation.name === "memories",
      ),
    ).toBeUndefined();
  });

  test("user-installed skills sharing a gated name are not gated", async () => {
    const config = await makeGatedConfig();
    const globalSkillsDir = config.skillsDirs[1];
    if (!globalSkillsDir) throw new Error("expected a global skills dir");
    const customTaskDir = path.join(globalSkillsDir, "task");
    await fs.mkdir(customTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(customTaskDir, "SKILL.md"),
      skillDoc("task", "A custom user task skill.", "Custom task instructions."),
      "utf-8",
    );

    const discovered = await discoverSkillsForConfig(config);
    expect(discovered.find((skill) => skill.name === "task")).toMatchObject({
      name: "task",
      description: "A custom user task skill.",
    });

    const catalog = await getSkillCatalog(config);
    const taskInstallations = catalog.installations.filter(
      (installation) => installation.name === "task",
    );
    expect(taskInstallations).toHaveLength(1);
    expect(taskInstallations[0]?.rootDir).toBe(customTaskDir);
  });
});
