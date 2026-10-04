import { describe, expect, test } from "bun:test";
import { buildMcpToolName, normalizeMcpNamePart } from "../src/mcp/names";

describe("mcp/names", () => {
  test("normalizes name parts and builds prefixed tool names", () => {
    for (const [raw, expected] of [
      ["  My Server  ", "My_Server"],
      ["github", "github"],
      ["a--b", "a--b"],
      ["docs.v2", "docs_v2"],
      ["slack/chat", "slack_chat"],
      ["", "_"],
      ["   ", "_"],
      ["!!!", "_"],
    ] as const) {
      expect(normalizeMcpNamePart(raw)).toBe(expected);
    }

    expect(buildMcpToolName("My Server", "list repos")).toBe("mcp__My_Server__list_repos");
    expect(buildMcpToolName("github", "get_issue")).toBe("mcp__github__get_issue");
    expect(buildMcpToolName("", "")).toBe("mcp______");
    expect(buildMcpToolName("   ", "!!!")).toBe("mcp______");
  });
});
