import { describe, expect, test } from "bun:test";
import type { AgentRoleDefinition } from "../../../src/server/agents/roles";
import { filterToolsForProfile, filterToolsForRole } from "../../../src/server/agents/toolPolicy";
import type { AgentProfileSnapshot } from "../../../src/shared/agentProfiles";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRole(overrides: Partial<AgentRoleDefinition> = {}): AgentRoleDefinition {
  return {
    id: "default",
    description: "Test role",
    promptFile: "default.md",
    defaultMode: "collaborative",
    readOnly: false,
    shellPolicy: "full",
    allowTools: ["bash", "read", "write", "edit", "glob", "grep"],
    canAskUser: false,
    canSpawnChildren: false,
    maxDepth: 0,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    id: "test-profile",
    ref: "global:test-profile",
    scope: "global",
    displayName: "Test Profile",
    description: "",
    baseRole: "default",
    prompt: "",
    allowedBuiltInTools: ["bash", "read", "glob", "grep"],
    allowedMcpServers: [],
    skillNames: [],
    resolvedAt: new Date().toISOString(),
    ...overrides,
  };
}

// A representative set of tools: some built-ins, some MCP tools.
function makeTools(): Record<string, { type: string }> {
  return {
    bash: { type: "builtin" },
    read: { type: "builtin" },
    write: { type: "builtin" },
    edit: { type: "builtin" },
    glob: { type: "builtin" },
    grep: { type: "builtin" },
    webSearch: { type: "builtin" },
    mcp__github__list_repos: { type: "mcp" },
    mcp__slack__send_message: { type: "mcp" },
    mcp__filesystem__readFile: { type: "mcp" },
  };
}

// ---------------------------------------------------------------------------
// filterToolsForRole
// ---------------------------------------------------------------------------

describe("filterToolsForRole", () => {
  test("returns only tools listed in allowTools for a non-readOnly role (plus MCP tools)", () => {
    // For a non-readOnly role, MCP tools always pass regardless of allowTools.
    const role = makeRole({
      readOnly: false,
      allowTools: ["bash", "read", "write"],
    });
    const tools = makeTools();
    const filtered = filterToolsForRole(tools, role);
    // Built-in tools in allowTools are included
    expect(filtered).toHaveProperty("bash");
    expect(filtered).toHaveProperty("read");
    expect(filtered).toHaveProperty("write");
    // Built-in tools NOT in allowTools are excluded
    expect(filtered).not.toHaveProperty("glob");
    expect(filtered).not.toHaveProperty("grep");
    expect(filtered).not.toHaveProperty("webSearch");
    // MCP tools pass for non-readOnly roles
    expect(filtered).toHaveProperty("mcp__github__list_repos");
  });

  test("built-in tools not in allowTools are excluded", () => {
    const role = makeRole({ allowTools: ["bash"] });
    const tools = makeTools();
    const filtered = filterToolsForRole(tools, role);
    expect(filtered).toHaveProperty("bash");
    expect(filtered).not.toHaveProperty("read");
    expect(filtered).not.toHaveProperty("write");
    expect(filtered).not.toHaveProperty("webSearch");
  });

  test("MCP tools are included for non-readOnly role even without allowProfileMcp", () => {
    const role = makeRole({ readOnly: false, allowTools: ["bash"] });
    const tools = makeTools();
    const filtered = filterToolsForRole(tools, role);
    expect(filtered).toHaveProperty("mcp__github__list_repos");
    expect(filtered).toHaveProperty("mcp__slack__send_message");
  });

  test("MCP tools are excluded for readOnly role without allowProfileMcp", () => {
    const role = makeRole({ readOnly: true, allowTools: ["bash", "read"] });
    const tools = makeTools();
    const filtered = filterToolsForRole(tools, role);
    expect(filtered).not.toHaveProperty("mcp__github__list_repos");
    expect(filtered).not.toHaveProperty("mcp__slack__send_message");
    expect(filtered).not.toHaveProperty("mcp__filesystem__readFile");
  });

  test("MCP tools are included for readOnly role when allowProfileMcp is true", () => {
    const role = makeRole({ readOnly: true, allowTools: ["bash", "read"] });
    const tools = makeTools();
    const filtered = filterToolsForRole(tools, role, { allowProfileMcp: true });
    expect(filtered).toHaveProperty("mcp__github__list_repos");
    expect(filtered).toHaveProperty("mcp__slack__send_message");
  });

  test("MCP tools in allowTools are always included regardless of readOnly", () => {
    const mcpTool = "mcp__github__list_repos";
    const role = makeRole({ readOnly: true, allowTools: [mcpTool] });
    const tools = makeTools();
    const filtered = filterToolsForRole(tools, role);
    expect(filtered).toHaveProperty(mcpTool);
  });

  test("returns only MCP tools when allowTools is empty and role is not readOnly", () => {
    const role = makeRole({ readOnly: false, allowTools: [] });
    const tools = makeTools();
    const filtered = filterToolsForRole(tools, role);
    // No built-ins allowed, readOnly = false so MCP tools pass through.
    const keys = Object.keys(filtered);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/^mcp__/);
    }
  });

  test("returns empty object when allowTools is empty and role is readOnly", () => {
    const role = makeRole({ readOnly: true, allowTools: [] });
    const tools = makeTools();
    const filtered = filterToolsForRole(tools, role);
    expect(Object.keys(filtered)).toHaveLength(0);
  });

  test("allowProfileMcp false (explicitly) on non-readOnly role still allows MCP", () => {
    const role = makeRole({ readOnly: false, allowTools: [] });
    const tools = makeTools();
    const filtered = filterToolsForRole(tools, role, { allowProfileMcp: false });
    // Non-readOnly: MCP passes because `!role.readOnly` is true
    expect(filtered).toHaveProperty("mcp__github__list_repos");
  });

  test("allowProfileMcp false (explicitly) on readOnly role blocks MCP", () => {
    const role = makeRole({ readOnly: true, allowTools: [] });
    const tools = makeTools();
    const filtered = filterToolsForRole(tools, role, { allowProfileMcp: false });
    expect(Object.keys(filtered)).toHaveLength(0);
  });

  test("works with an empty tool map", () => {
    const role = makeRole({ allowTools: ["bash", "read"] });
    const filtered = filterToolsForRole({}, role);
    expect(Object.keys(filtered)).toHaveLength(0);
  });

  test("tool that starts with mcp__ passes for non-readOnly role even without double-underscore server separator", () => {
    // "mcp__github" has no second __ separator, so extractMcpServerName returns null
    // but the filterToolsForRole check is: if (!name.startsWith("mcp__")) return false;
    // It does start with "mcp__", so for non-readOnly roles it passes via !role.readOnly.
    const role = makeRole({ readOnly: false, allowTools: [] });
    const tools: Record<string, unknown> = {
      mcp__github: { type: "mcp_malformed" },
    };
    const filtered = filterToolsForRole(tools, role);
    // Passes because startsWith("mcp__") is true and role is not readOnly
    expect(filtered).toHaveProperty("mcp__github");
  });

  test("tool that starts with mcp__ is blocked for readOnly role with no double-underscore server separator", () => {
    const role = makeRole({ readOnly: true, allowTools: [] });
    const tools: Record<string, unknown> = {
      mcp__github: { type: "mcp_malformed" },
    };
    const filtered = filterToolsForRole(tools, role);
    expect(filtered).not.toHaveProperty("mcp__github");
  });
});

// ---------------------------------------------------------------------------
// filterToolsForProfile
// ---------------------------------------------------------------------------

describe("filterToolsForProfile", () => {
  test("allows only built-in tools listed in allowedBuiltInTools", () => {
    const profile = makeProfile({ allowedBuiltInTools: ["bash", "read"], allowedMcpServers: [] });
    const tools = makeTools();
    const filtered = filterToolsForProfile(tools, profile);
    expect(Object.keys(filtered).sort()).toEqual(["bash", "read"]);
  });

  test("blocks built-in tools not in allowedBuiltInTools", () => {
    const profile = makeProfile({ allowedBuiltInTools: ["bash"], allowedMcpServers: [] });
    const tools = makeTools();
    const filtered = filterToolsForProfile(tools, profile);
    expect(filtered).toHaveProperty("bash");
    expect(filtered).not.toHaveProperty("read");
    expect(filtered).not.toHaveProperty("write");
  });

  test("allows MCP tools from servers in allowedMcpServers", () => {
    const profile = makeProfile({
      allowedBuiltInTools: [],
      allowedMcpServers: ["github"],
    });
    const tools = makeTools();
    const filtered = filterToolsForProfile(tools, profile);
    expect(filtered).toHaveProperty("mcp__github__list_repos");
    expect(filtered).not.toHaveProperty("mcp__slack__send_message");
    expect(filtered).not.toHaveProperty("mcp__filesystem__readFile");
  });

  test("blocks MCP tools not from allowed servers", () => {
    const profile = makeProfile({
      allowedBuiltInTools: [],
      allowedMcpServers: ["slack"],
    });
    const tools = makeTools();
    const filtered = filterToolsForProfile(tools, profile);
    expect(filtered).toHaveProperty("mcp__slack__send_message");
    expect(filtered).not.toHaveProperty("mcp__github__list_repos");
  });

  test("allows multiple MCP servers simultaneously", () => {
    const profile = makeProfile({
      allowedBuiltInTools: [],
      allowedMcpServers: ["github", "slack"],
    });
    const tools = makeTools();
    const filtered = filterToolsForProfile(tools, profile);
    expect(filtered).toHaveProperty("mcp__github__list_repos");
    expect(filtered).toHaveProperty("mcp__slack__send_message");
    expect(filtered).not.toHaveProperty("mcp__filesystem__readFile");
  });

  test("MCP server name normalization: spaces and special chars are replaced with underscores", () => {
    // normalizeMcpServerName replaces non-alphanumeric/non-dash/non-underscore with _
    const profile = makeProfile({
      allowedBuiltInTools: [],
      allowedMcpServers: ["my server"], // space → underscore → "my_server"
    });
    const tools: Record<string, unknown> = {
      mcp__my_server__do_thing: { type: "mcp" },
      mcp__other__do_thing: { type: "mcp" },
    };
    const filtered = filterToolsForProfile(tools, profile);
    expect(filtered).toHaveProperty("mcp__my_server__do_thing");
    expect(filtered).not.toHaveProperty("mcp__other__do_thing");
  });

  test("MCP server name matching is case-sensitive after normalization", () => {
    const profile = makeProfile({
      allowedBuiltInTools: [],
      allowedMcpServers: ["GitHub"], // G uppercase
    });
    const tools: Record<string, unknown> = {
      mcp__GitHub__repo: { type: "mcp" },
      mcp__github__repo: { type: "mcp" },
    };
    const filtered = filterToolsForProfile(tools, profile);
    // Both "GitHub" and "github" normalize the same way (letters kept as-is),
    // so they should match if profile has "GitHub" and tool server is "GitHub".
    // "github" (lowercase) won't match "GitHub" since normalization preserves case.
    expect(filtered).toHaveProperty("mcp__GitHub__repo");
    expect(filtered).not.toHaveProperty("mcp__github__repo");
  });

  test("returns empty object when allowedBuiltInTools and allowedMcpServers are empty", () => {
    const profile = makeProfile({ allowedBuiltInTools: [], allowedMcpServers: [] });
    const tools = makeTools();
    const filtered = filterToolsForProfile(tools, profile);
    expect(Object.keys(filtered)).toHaveLength(0);
  });

  test("combined: allows both built-in and MCP tools", () => {
    const profile = makeProfile({
      allowedBuiltInTools: ["bash", "read"],
      allowedMcpServers: ["github"],
    });
    const tools = makeTools();
    const filtered = filterToolsForProfile(tools, profile);
    expect(filtered).toHaveProperty("bash");
    expect(filtered).toHaveProperty("read");
    expect(filtered).toHaveProperty("mcp__github__list_repos");
    expect(filtered).not.toHaveProperty("write");
    expect(filtered).not.toHaveProperty("mcp__slack__send_message");
  });

  test("works with empty tool map", () => {
    const profile = makeProfile({
      allowedBuiltInTools: ["bash"],
      allowedMcpServers: ["github"],
    });
    const filtered = filterToolsForProfile({}, profile);
    expect(Object.keys(filtered)).toHaveLength(0);
  });

  test("MCP tool with separator at position 0 (server name empty) is not matched", () => {
    // "mcp____tool" has an empty server name segment after extractMcpServerName returns null
    // because separatorIndex <= 0 (separator is at index 0 of rest)
    const profile = makeProfile({
      allowedBuiltInTools: [],
      allowedMcpServers: [""],
    });
    const tools: Record<string, unknown> = {
      mcp____tool: { type: "mcp" },
    };
    const filtered = filterToolsForProfile(tools, profile);
    expect(filtered).not.toHaveProperty("mcp____tool");
  });

  test("MCP server name with leading/trailing spaces is normalized via trim", () => {
    const profile = makeProfile({
      allowedBuiltInTools: [],
      allowedMcpServers: ["  github  "], // trimmed to "github" → no change
    });
    const tools: Record<string, unknown> = {
      mcp__github__list_repos: { type: "mcp" },
    };
    const filtered = filterToolsForProfile(tools, profile);
    expect(filtered).toHaveProperty("mcp__github__list_repos");
  });
});
