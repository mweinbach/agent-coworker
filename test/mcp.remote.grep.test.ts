import { describe, expect, test } from "bun:test";

import type { MCPServerConfig } from "../src/types";
import { loadMCPTools } from "../src/mcp";

const RUN_REMOTE =
  process.env.RUN_REMOTE_MCP_TESTS === "1" ||
  process.env.RUN_REMOTE_MCP_TESTS === "true" ||
  process.env.RUN_REMOTE_MCP_TESTS === "yes";

const it = RUN_REMOTE ? test : test.skip;

describe("remote MCP (mcp.grep.app)", () => {
  it(
    "connects, discovers tools, and executes searchGitHub",
    async () => {
      const servers: MCPServerConfig[] = [
        {
          name: "grep",
          transport: { type: "http", url: "https://mcp.grep.app" },
          required: true,
          retries: 0,
        },
      ];

      const loaded = await loadMCPTools(servers, { log: () => {} });
      try {
        expect(loaded.errors).toEqual([]);

        const toolName = "mcp__grep__searchGitHub";
        expect(loaded.tools).toHaveProperty(toolName);

        const tool: any = (loaded.tools as any)[toolName];
        expect(typeof tool.execute).toBe("function");

        const res = await tool.execute({
          query: "createMCPClient(",
          language: ["TypeScript", "JavaScript"],
        });

        expect(res).toBeDefined();
        expect(Array.isArray(res.content)).toBe(true);
        expect(res.content.length).toBeGreaterThan(0);

        const firstText = res.content.find((c: any) => c?.type === "text")?.text;
        expect(typeof firstText).toBe("string");
        expect(firstText.length).toBeGreaterThan(0);
      } finally {
        await loaded.close();
      }
    },
    30_000
  );
});

