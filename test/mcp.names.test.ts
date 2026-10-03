import { describe, expect, test } from "bun:test";

import { buildMcpToolName, normalizeMcpNamePart } from "../src/mcp/names";

describe("normalizeMcpNamePart", () => {
  test("trims and replaces non-alphanumeric characters except dashes", () => {
    expect(normalizeMcpNamePart("  My Server  ")).toBe("My_Server");
    expect(normalizeMcpNamePart("github")).toBe("github");
    expect(normalizeMcpNamePart("a--b")).toBe("a--b");
    expect(normalizeMcpNamePart("docs.v2")).toBe("docs_v2");
    expect(normalizeMcpNamePart("slack/chat")).toBe("slack_chat");
  });

  test("empty or punctuation-only names collapse to a single underscore", () => {
    expect(normalizeMcpNamePart("")).toBe("_");
    expect(normalizeMcpNamePart("   ")).toBe("_");
    expect(normalizeMcpNamePart("!!!")).toBe("_");
  });
});

describe("buildMcpToolName", () => {
  test("joins normalized server and tool parts with the mcp prefix", () => {
    expect(buildMcpToolName("My Server", "list repos")).toBe("mcp__My_Server__list_repos");
    expect(buildMcpToolName("github", "get_issue")).toBe("mcp__github__get_issue");
  });

  test("blank server and tool names share one colliding identity", () => {
    expect(buildMcpToolName("", "")).toBe("mcp______");
    expect(buildMcpToolName("   ", "!!!")).toBe("mcp______");
  });
});
