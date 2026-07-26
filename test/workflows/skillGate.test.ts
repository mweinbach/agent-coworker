import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { isSkillDiscoveryAllowed, isSkillVisibleInCatalog } from "../../src/skills/featureGates";
import type { AgentConfig } from "../../src/types";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

function configWithWorkflows(enabled: boolean): AgentConfig {
  return { builtInDir: REPO_ROOT, workflowsEnabled: enabled } as AgentConfig;
}

const bundledWorkflowSkill = {
  name: "workflow",
  rootDir: path.join(REPO_ROOT, "skills"),
};

describe("bundled workflow skill", () => {
  test("ships with the app", async () => {
    const body = await fs.readFile(path.join(REPO_ROOT, "skills", "workflow", "SKILL.md"), "utf-8");
    expect(body.startsWith("---")).toBe(true);
    expect(body).toContain("name: workflow");
    // The description drives when the model loads it, so keep the trigger wording
    // pinned rather than letting an edit silently narrow it.
    expect(body).toContain("deterministic multi-agent workflow");
    expect(body).toContain("export default async function run(");
  });

  test("is discoverable only while the workflows feature is on", () => {
    expect(isSkillDiscoveryAllowed(configWithWorkflows(true), bundledWorkflowSkill)).toBe(true);
    expect(isSkillDiscoveryAllowed(configWithWorkflows(false), bundledWorkflowSkill)).toBe(false);
  });

  test("is hidden from the user-facing skill catalog", () => {
    // It is agent-facing infrastructure owned by the feature flag, not a skill a
    // user should be able to disable independently.
    expect(isSkillVisibleInCatalog(configWithWorkflows(true), bundledWorkflowSkill)).toBe(false);
  });

  test("a user-installed skill named `workflow` is unaffected by the gate", async () => {
    const userSkill = { name: "workflow", rootDir: path.join(REPO_ROOT, "..", "elsewhere") };
    expect(isSkillDiscoveryAllowed(configWithWorkflows(false), userSkill)).toBe(true);
    expect(isSkillVisibleInCatalog(configWithWorkflows(false), userSkill)).toBe(true);
  });
});
