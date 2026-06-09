import { describe, expect, test } from "bun:test";

import { AGENT_ROLE_VALUES } from "../../../src/shared/agents";
import {
  AGENT_ROLE_DEFINITIONS,
  buildSpawnAgentRolePromptLines,
  getAgentRoleDefinition,
  getAgentRoleShellPolicy,
} from "../../../src/server/agents/roles";

describe("getAgentRoleDefinition", () => {
  test("returns a definition for every AgentRole value", () => {
    for (const role of AGENT_ROLE_VALUES) {
      const def = getAgentRoleDefinition(role);
      expect(def).toBeDefined();
      expect(def.id).toBe(role);
    }
  });

  test("default role is not readOnly and has write-capable tools", () => {
    const def = getAgentRoleDefinition("default");
    expect(def.readOnly).toBe(false);
    expect(def.allowTools).toContain("write");
    expect(def.allowTools).toContain("edit");
  });

  test("explorer role is readOnly", () => {
    const def = getAgentRoleDefinition("explorer");
    expect(def.readOnly).toBe(true);
    expect(def.allowTools).not.toContain("write");
    expect(def.allowTools).not.toContain("edit");
  });

  test("research role is readOnly", () => {
    const def = getAgentRoleDefinition("research");
    expect(def.readOnly).toBe(true);
  });

  test("worker role is not readOnly", () => {
    const def = getAgentRoleDefinition("worker");
    expect(def.readOnly).toBe(false);
    expect(def.allowTools).toContain("write");
    expect(def.allowTools).toContain("edit");
  });

  test("reviewer role is readOnly", () => {
    const def = getAgentRoleDefinition("reviewer");
    expect(def.readOnly).toBe(true);
    expect(def.allowTools).not.toContain("write");
    expect(def.allowTools).not.toContain("edit");
  });

  test("every definition has a non-empty id, description, and promptFile", () => {
    for (const role of AGENT_ROLE_VALUES) {
      const def = getAgentRoleDefinition(role);
      expect(def.id.trim().length).toBeGreaterThan(0);
      expect(def.description.trim().length).toBeGreaterThan(0);
      expect(def.promptFile.trim().length).toBeGreaterThan(0);
    }
  });

  test("every definition has a defaultMode of 'collaborative' or 'delegate'", () => {
    for (const role of AGENT_ROLE_VALUES) {
      const def = getAgentRoleDefinition(role);
      expect(["collaborative", "delegate"]).toContain(def.defaultMode);
    }
  });

  test("canSpawnChildren is false for all current roles", () => {
    for (const role of AGENT_ROLE_VALUES) {
      const def = getAgentRoleDefinition(role);
      expect(def.canSpawnChildren).toBe(false);
    }
  });

  test("AGENT_ROLE_DEFINITIONS covers all AgentRole values", () => {
    for (const role of AGENT_ROLE_VALUES) {
      expect(AGENT_ROLE_DEFINITIONS).toHaveProperty(role);
    }
  });
});

describe("getAgentRoleShellPolicy", () => {
  test("null returns full policy", () => {
    expect(getAgentRoleShellPolicy(null)).toBe("full");
  });

  test("undefined returns full policy", () => {
    expect(getAgentRoleShellPolicy(undefined)).toBe("full");
  });

  test("default role returns full policy", () => {
    expect(getAgentRoleShellPolicy("default")).toBe("full");
  });

  test("worker role returns full policy", () => {
    expect(getAgentRoleShellPolicy("worker")).toBe("full");
  });

  test("explorer role returns no_project_write policy", () => {
    expect(getAgentRoleShellPolicy("explorer")).toBe("no_project_write");
  });

  test("research role returns no_project_write policy", () => {
    expect(getAgentRoleShellPolicy("research")).toBe("no_project_write");
  });

  test("reviewer role returns no_project_write policy", () => {
    expect(getAgentRoleShellPolicy("reviewer")).toBe("no_project_write");
  });

  test("readOnly roles all return no_project_write", () => {
    for (const role of AGENT_ROLE_VALUES) {
      const def = getAgentRoleDefinition(role);
      if (def.readOnly) {
        expect(getAgentRoleShellPolicy(role)).toBe("no_project_write");
      }
    }
  });

  test("write-capable roles all return full", () => {
    for (const role of AGENT_ROLE_VALUES) {
      const def = getAgentRoleDefinition(role);
      if (!def.readOnly) {
        expect(getAgentRoleShellPolicy(role)).toBe("full");
      }
    }
  });
});

describe("buildSpawnAgentRolePromptLines", () => {
  test("returns an array with one entry per role", () => {
    const lines = buildSpawnAgentRolePromptLines();
    expect(lines.length).toBe(AGENT_ROLE_VALUES.length);
  });

  test("every role id appears in the prompt lines", () => {
    const lines = buildSpawnAgentRolePromptLines();
    for (const role of AGENT_ROLE_VALUES) {
      const found = lines.some((line) => line.includes(role));
      expect(found).toBe(true);
    }
  });

  test("each line starts with '- **'", () => {
    const lines = buildSpawnAgentRolePromptLines();
    for (const line of lines) {
      expect(line).toMatch(/^- \*\*/);
    }
  });

  test("readOnly roles mention 'Read-only'", () => {
    const lines = buildSpawnAgentRolePromptLines();
    const linesByRole = Object.fromEntries(
      AGENT_ROLE_VALUES.map((role) => [
        role,
        lines.find((l) => l.includes(`**${role}**`)) ?? "",
      ]),
    );
    for (const role of AGENT_ROLE_VALUES) {
      const def = getAgentRoleDefinition(role);
      if (def.readOnly) {
        expect(linesByRole[role]).toContain("Read-only");
      } else {
        expect(linesByRole[role]).toContain("Write-capable");
      }
    }
  });

  test("lines contain default mode description", () => {
    const lines = buildSpawnAgentRolePromptLines();
    for (const role of AGENT_ROLE_VALUES) {
      const def = getAgentRoleDefinition(role);
      const line = lines.find((l) => l.includes(`**${role}**`)) ?? "";
      expect(line).toContain(`Default mode: ${def.defaultMode}`);
    }
  });

  test("lines contain 'Cannot spawn child agents' since no role allows it", () => {
    const lines = buildSpawnAgentRolePromptLines();
    for (const line of lines) {
      expect(line).toContain("Cannot spawn child agents");
    }
  });
});
