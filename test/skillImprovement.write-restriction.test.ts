import { describe, expect, test } from "bun:test";

import { skillImprovementWriteRestriction } from "../src/skillImprovement/backups";
import type { SkillInstallationEntry, SkillPluginOwner } from "../src/types";

function installation(overrides: Partial<SkillInstallationEntry> = {}): SkillInstallationEntry {
  return {
    installationId: "inst-1",
    name: "notes",
    description: "Notes skill",
    scope: "user",
    enabled: true,
    writable: true,
    managed: true,
    effective: true,
    state: "effective",
    rootDir: "/skills/notes",
    skillPath: "/skills/notes/SKILL.md",
    path: "/skills/notes/SKILL.md",
    triggers: [],
    descriptionSource: "frontmatter",
    diagnostics: [],
    ...overrides,
  };
}

const pluginOwner: SkillPluginOwner = {
  pluginId: "notes-pack",
  name: "notes-pack",
  displayName: "Notes Pack",
  scope: "user",
  discoveryKind: "marketplace",
  rootDir: "/plugins/notes-pack",
};

describe("skillImprovementWriteRestriction", () => {
  test("plugin-owned skills cannot be improved even when marked writable", () => {
    expect(
      skillImprovementWriteRestriction(installation({ writable: true, plugin: pluginOwner })),
    ).toBe("Plugin-owned skills are read-only and cannot be improved.");
  });

  test("non-writable user and project installs fail closed", () => {
    expect(skillImprovementWriteRestriction(installation({ writable: false }))).toBe(
      "This skill installation is read-only and cannot be improved.",
    );
    expect(
      skillImprovementWriteRestriction(installation({ scope: "project", writable: false })),
    ).toBe("This skill installation is read-only and cannot be improved.");
  });

  test("writable installs and built-in copies remain unrestricted", () => {
    expect(skillImprovementWriteRestriction(installation())).toBeUndefined();
    expect(
      skillImprovementWriteRestriction(installation({ scope: "built-in", writable: false })),
    ).toBeUndefined();
  });
});
