import { describe, expect, mock, test } from "bun:test";

import { loadMCPTools } from "../src/mcp";
import type { MCPServerConfig } from "../src/types";

describe("loadMCPTools invalid client shapes", () => {
  test("collects invalid runtime shape errors for optional servers", async () => {
    const createClient = mock(async () => ({}));
    const servers: MCPServerConfig[] = [
      { name: "broken-shape", transport: { type: "stdio", command: "echo" }, retries: 0 },
    ];

    const result = await loadMCPTools(servers, { createClient: createClient as never });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(result.tools).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("broken-shape");
    expect(result.errors[0]).toContain("invalid runtime shape");
  });

  test("collects invalid tool definition errors for optional servers", async () => {
    const close = mock(async () => {});
    const createClient = mock(async () => ({
      tools: mock(async () => null),
      close,
    }));
    const servers: MCPServerConfig[] = [
      { name: "broken-tools", transport: { type: "stdio", command: "echo" }, retries: 0 },
    ];

    const result = await loadMCPTools(servers, { createClient: createClient as never });
    expect(result.tools).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("broken-tools");
    expect(result.errors[0]).toContain("invalid tool definitions");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("required invalid runtime shape tears down peer clients and throws", async () => {
    const close = mock(async () => {});
    const createClient = mock(async (opts: { name: string }) => {
      if (opts.name === "required-broken") {
        return {};
      }
      return {
        tools: mock(async () => ({ ping: { description: "ok" } })),
        close,
      };
    });
    const servers: MCPServerConfig[] = [
      { name: "optional-ok", transport: { type: "stdio", command: "echo" } },
      {
        name: "required-broken",
        transport: { type: "stdio", command: "echo" },
        retries: 0,
        required: true,
      },
      { name: "also-ok", transport: { type: "stdio", command: "echo" } },
    ];

    await expect(loadMCPTools(servers, { createClient: createClient as never })).rejects.toThrow(
      /Failed to connect to required-broken after 1 attempts:.*invalid runtime shape/,
    );
    expect(close).toHaveBeenCalledTimes(2);
  });
});
