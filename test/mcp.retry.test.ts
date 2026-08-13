import { describe, expect, mock, test } from "bun:test";

import { loadMCPTools } from "../src/mcp";
import type { MCPServerConfig } from "../src/types";

describe("loadMCPTools retry/backoff", () => {
  test("retries transient connect failures with increasing sleep backoff", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const logs: string[] = [];
    const createClient = mock(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("transient");
      }
      return {
        tools: mock(async () => ({ ping: { description: "ping" } })),
        close: mock(async () => {}),
      };
    });

    const servers: MCPServerConfig[] = [
      { name: "flaky", transport: { type: "stdio", command: "echo" }, retries: 2 },
    ];
    const result = await loadMCPTools(servers, {
      createClient: createClient as never,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (line) => logs.push(line),
    });

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(logs.some((line) => line.includes("[MCP] Retrying flaky (attempt 2)"))).toBe(true);
    expect(logs.some((line) => line.includes("[MCP] Retrying flaky (attempt 3)"))).toBe(true);
    expect(result.tools).toHaveProperty("mcp__flaky__ping");
    expect(result.errors).toEqual([]);
  });

  test("exhausts retries and reports the full attempt count", async () => {
    const createClient = mock(async () => {
      throw new Error("still down");
    });
    const sleeps: number[] = [];
    const servers: MCPServerConfig[] = [
      { name: "dead", transport: { type: "stdio", command: "echo" }, retries: 2 },
    ];

    const result = await loadMCPTools(servers, {
      createClient: createClient as never,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(createClient).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(result.tools).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Failed to connect to dead after 3 attempts");
    expect(result.errors[0]).toContain("still down");
  });

  test("treats invalid retries as the default of 3", async () => {
    const createClient = mock(async () => {
      throw new Error("refused");
    });
    const sleeps: number[] = [];
    const servers = [
      {
        name: "bad-retries",
        transport: { type: "stdio", command: "echo" },
        retries: "nope",
      },
    ] as unknown as MCPServerConfig[];

    const result = await loadMCPTools(servers, {
      createClient: createClient as never,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(createClient).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1000, 2000, 3000]);
    expect(result.errors[0]).toContain("after 4 attempts");
  });
});
