import { describe, expect, test } from "bun:test";

import { mcpServerLookupFromServer } from "../../src/server/session/mcp/McpServerLookup";

describe("mcpServerLookupFromServer", () => {
  test("keeps source and only forwards non-empty plugin identity", () => {
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
  });

  test("drops blank pluginId so validation cannot target an empty plugin bucket", () => {
    expect(
      mcpServerLookupFromServer({
        source: "plugin",
        pluginId: "",
        pluginScope: "user",
      }),
    ).toEqual({
      source: "plugin",
      pluginScope: "user",
    });
  });
});
