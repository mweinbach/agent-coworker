import { describe, expect, test } from "bun:test";
import { getAgentRoleDefinition } from "../src/server/agents/roles";
import { filterToolsForProfile, filterToolsForRole } from "../src/server/agents/toolPolicy";
import type { AgentProfileSnapshot } from "../src/shared/agentProfiles";

function snapshot(overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    id: "readonly-github",
    ref: "workspace:readonly-github",
    scope: "workspace",
    displayName: "Read-only GitHub",
    description: "Read local files and selected GitHub MCP tools.",
    baseRole: "explorer",
    prompt: "",
    allowedBuiltInTools: ["read", "write"],
    allowedMcpServers: ["github"],
    skillNames: [],
    resolvedAt: "2026-06-02T12:00:00.000Z",
    ...overrides,
  };
}

describe("agent profile tool policy", () => {
  test("narrows built-ins after role filtering and grants selected MCP servers", () => {
    const allTools = {
      read: { type: "builtin" },
      write: { type: "builtin" },
      grep: { type: "builtin" },
      mcp__github__search: { type: "mcp" },
      mcp__drive_docs__read: { type: "mcp" },
    };

    const roleFiltered = filterToolsForRole(allTools, getAgentRoleDefinition("explorer"), {
      allowProfileMcp: true,
    });
    const profileFiltered = filterToolsForProfile(roleFiltered, snapshot());

    expect(Object.keys(roleFiltered).sort()).toEqual([
      "grep",
      "mcp__drive_docs__read",
      "mcp__github__search",
      "read",
    ]);
    expect(Object.keys(profileFiltered).sort()).toEqual(["mcp__github__search", "read"]);
  });

  test("normalizes MCP server names before prefix matching", () => {
    const tools = {
      mcp__linear_server__issue: { type: "mcp" },
      mcp__linear__server__issue: { type: "mcp" },
      mcp__linear__issue: { type: "mcp" },
    };

    expect(
      Object.keys(
        filterToolsForProfile(
          tools,
          snapshot({
            allowedBuiltInTools: [],
            allowedMcpServers: ["linear  server"],
          }),
        ),
      ),
    ).toEqual(["mcp__linear_server__issue"]);
  });
});
