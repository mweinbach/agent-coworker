import { describe, expect, test } from "bun:test";

import type { MCPServerConfig } from "../src/types";
import { loadMCPTools } from "../src/mcp";

const RUN_REMOTE_SMOKE =
  process.env.RUN_REMOTE_MCP_TESTS === "1" ||
  process.env.RUN_REMOTE_MCP_TESTS === "true" ||
  process.env.RUN_REMOTE_MCP_TESTS === "yes";

const RUN_REMOTE_DEEP =
  process.env.RUN_REMOTE_MCP_AGENT_TESTS === "1" ||
  process.env.RUN_REMOTE_MCP_AGENT_TESTS === "true" ||
  process.env.RUN_REMOTE_MCP_AGENT_TESTS === "yes";

const smoke = RUN_REMOTE_SMOKE ? test : test.skip;
const deep = RUN_REMOTE_DEEP ? test : test.skip;

function grepServerConfig(): MCPServerConfig[] {
  return [
    {
      name: "grep",
      transport: { type: "http", url: "https://mcp.grep.app" },
      required: true,
      retries: 2,
    },
  ];
}

function isRetryableRemoteMcpError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (
    /Streamable HTTP error/i.test(message) ||
    /Internal Server Error/i.test(message) ||
    /\b50[0-4]\b/.test(message)
  );
}

async function retryRemoteMcpOperation<T>(
  operation: () => Promise<T>,
  opts: {
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts || !isRetryableRemoteMcpError(error)) {
        throw error;
      }
      await sleep(500 * attempt);
    }
  }

  throw new Error("retryRemoteMcpOperation exhausted without returning or throwing");
}

describe("remote MCP retry helper", () => {
  test("retries transient upstream 5xx failures before succeeding", async () => {
    let attempts = 0;
    const sleepCalls: number[] = [];

    const result = await retryRemoteMcpOperation(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("Streamable HTTP error: Error POSTing to endpoint: 500 Internal Server Error");
      }
      return "ok";
    }, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleepCalls).toEqual([500, 1000]);
  });

  test("does not retry non-transient failures", async () => {
    let attempts = 0;

    await expect(retryRemoteMcpOperation(async () => {
      attempts += 1;
      throw new Error("401 Unauthorized");
    }, {
      sleep: async () => {},
    })).rejects.toThrow("401 Unauthorized");

    expect(attempts).toBe(1);
  });
});

describe("remote MCP (mcp.grep.app)", () => {
  smoke(
    "connects and discovers tools",
    async () => {
      const loaded = await loadMCPTools(grepServerConfig(), { log: () => {} });
      try {
        expect(loaded.errors).toEqual([]);

        const toolName = "mcp__grep__searchGitHub";
        expect(loaded.tools).toHaveProperty(toolName);

        const tool: any = (loaded.tools as any)[toolName];
        expect(typeof tool.execute).toBe("function");
      } finally {
        await loaded.close();
      }
    },
    30_000
  );

  deep(
    "executes searchGitHub",
    async () => {
      const loaded = await loadMCPTools(grepServerConfig(), { log: () => {} });
      try {
        expect(loaded.errors).toEqual([]);

        const toolName = "mcp__grep__searchGitHub";
        expect(loaded.tools).toHaveProperty(toolName);

        const tool: any = (loaded.tools as any)[toolName];
        expect(typeof tool.execute).toBe("function");

        const res = await retryRemoteMcpOperation(async () => await tool.execute({
          query: "createMCPClient(",
          language: ["TypeScript", "JavaScript"],
        }));

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
