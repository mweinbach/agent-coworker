import { describe, expect, mock, test } from "bun:test";

import { loadMCPTools } from "../src/mcp";
import { buildMcpToolName, normalizeMcpNamePart } from "../src/mcp/names";
import type { MCPServerConfig } from "../src/types";

function stdioServer(name: string): MCPServerConfig {
  return { name, transport: { type: "stdio", command: "echo" } };
}

function clientWithTools(tools: Record<string, { description: string }>) {
  return {
    tools: mock(async () => tools),
    close: mock(async () => {}),
  };
}

describe("MCP tool name normalization", () => {
  test("replaces unsafe characters and refuses empty name parts", () => {
    expect(normalizeMcpNamePart("Diligence  Stack")).toBe("Diligence_Stack");
    expect(normalizeMcpNamePart("search__reports")).toBe("search_reports");
    expect(normalizeMcpNamePart("local!!")).toBe("local_");
    expect(normalizeMcpNamePart("   ")).toBe("_");
    expect(normalizeMcpNamePart("!!!")).toBe("_");
    expect(buildMcpToolName("local!!", "ping")).toBe("mcp__local___ping");
    expect(buildMcpToolName("", "")).toBe("mcp______");
  });
});

describe("loadMCPTools tool-name collisions", () => {
  test("remaps tools that collapse to the same provider-safe id", async () => {
    const logs: string[] = [];
    const result = await loadMCPTools([stdioServer("local")], {
      log: (line) => logs.push(line),
      createClient: async () =>
        clientWithTools({
          "search reports": { description: "first" },
          search__reports: { description: "second" },
          "search.reports": { description: "third" },
        }),
    });

    expect(Object.keys(result.tools)).toEqual([
      "mcp__local__search_reports",
      "mcp__local__search_reports_2",
      "mcp__local__search_reports_3",
    ]);
    expect(
      (result.tools["mcp__local__search_reports"] as { description: string }).description,
    ).toBe("first");
    expect(
      (result.tools["mcp__local__search_reports_2"] as { description: string }).description,
    ).toBe("second");
    expect(
      (result.tools["mcp__local__search_reports_3"] as { description: string }).description,
    ).toBe("third");
    expect(
      logs.some(
        (line) => line.includes("Tool name collision") && line.includes("search_reports_2"),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (line) => line.includes("Tool name collision") && line.includes("search_reports_3"),
      ),
    ).toBe(true);
  });

  test("remaps colliding servers in config order even when they finish out of order", async () => {
    const release = new Map<string, () => void>();
    const createClient = mock(async (opts: { name: string }) => {
      await new Promise<void>((resolve) => release.set(opts.name, resolve));
      return clientWithTools({ ping: { description: opts.name } });
    });

    const pending = loadMCPTools([stdioServer("alpha"), stdioServer("  alpha  ")], {
      createClient: createClient as never,
    });

    expect([...release.keys()].sort()).toEqual(["  alpha  ", "alpha"]);
    release.get("  alpha  ")?.();
    release.get("alpha")?.();

    const result = await pending;
    expect(Object.keys(result.tools)).toEqual(["mcp__alpha__ping", "mcp__alpha__ping_2"]);
    expect((result.tools["mcp__alpha__ping"] as { description: string }).description).toBe("alpha");
    expect((result.tools["mcp__alpha__ping_2"] as { description: string }).description).toBe(
      "  alpha  ",
    );
  });
});
