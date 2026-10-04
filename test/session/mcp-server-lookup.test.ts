import { describe, expect, test } from "bun:test";

import { mcpServerLookupFromServer } from "../../src/server/session/mcp/McpServerLookup";

describe("mcpServerLookupFromServer", () => {
  test("keeps source, forwards non-empty plugin identity, and drops blank pluginId", () => {
    expect(
      mcpServerLookupFromServer({
        source: "plugin",
        pluginId: "grep-toolkit",
        pluginScope: "workspace",
      }),
    ).toEqual({
      source: "plugin",
      pluginId: "grep-toolkit",
      pluginScope: "workspace",
    });
    expect(mcpServerLookupFromServer({ source: "workspace" })).toEqual({ source: "workspace" });
    expect(
      mcpServerLookupFromServer({ source: "plugin", pluginId: "", pluginScope: "user" }),
    ).toEqual({
      source: "plugin",
      pluginScope: "user",
    });
  });
});
