import { describe, expect, test } from "bun:test";
import { jsonRpcControlRequestSchemas as mobileJsonRpcControlRequestSchemas } from "../apps/mobile/src/cowork-shared/jsonrpcControlSchemas";
import { jsonRpcRequestSchemas } from "../src/server/jsonrpc/schema";
import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

const stdioServer = {
  name: "docs",
  transport: { type: "stdio" as const, command: "uvx", args: ["docs-mcp"] },
};

describe("MCP upsert and memory mutation request schemas", () => {
  test("MCP upsert accepts stdio and http transports and keeps mobile parity", () => {
    const request = {
      cwd: "/tmp/project",
      server: stdioServer,
    };
    const httpRequest = {
      cwd: "/tmp/project",
      server: {
        name: "remote",
        transport: { type: "http" as const, url: "https://mcp.example.com" },
        auth: { type: "oauth" as const, oauthMode: "code" as const },
      },
    };

    expect(jsonRpcRequestSchemas["cowork/mcp/server/upsert"].parse(request)).toEqual(request);
    expect(jsonRpcControlRequestSchemas["cowork/mcp/server/upsert"].parse(request)).toEqual(
      request,
    );
    expect(mobileJsonRpcControlRequestSchemas["cowork/mcp/server/upsert"].parse(request)).toEqual(
      request,
    );
    expect(jsonRpcRequestSchemas["cowork/mcp/server/upsert"].parse(httpRequest).server.name).toBe(
      "remote",
    );
    expect(
      jsonRpcRequestSchemas["cowork/mcp/server/upsert"].parse({
        ...request,
        source: "workspace",
      }).source,
    ).toBe("workspace");
  });

  test("MCP upsert rejects blank names, unknown transports, mixed fields, and extras", () => {
    const schema = jsonRpcRequestSchemas["cowork/mcp/server/upsert"];
    const mobile = mobileJsonRpcControlRequestSchemas["cowork/mcp/server/upsert"];
    const cases = [
      { server: { name: "   ", transport: { type: "stdio", command: "echo" } } },
      { server: { name: "docs", transport: { type: "stdio", command: "   " } } },
      { server: { name: "docs", transport: { type: "ftp", url: "https://x" } } },
      {
        server: {
          name: "docs",
          transport: { type: "stdio", command: "echo", url: "https://x" },
        },
      },
      { server: { name: "docs", transport: { type: "http", url: "   " } } },
      { server: { name: "docs", transport: { type: "http", url: "https://x", command: "echo" } } },
      { server: { name: "docs", transport: { type: "stdio", command: "echo" }, retries: -1 } },
      {
        server: {
          name: "docs",
          transport: { type: "http", url: "https://x" },
          auth: { type: "bearer" },
        },
      },
      { server: stdioServer, extra: true },
    ];

    for (const params of cases) {
      expect(schema.safeParse(params).success).toBe(false);
      expect(mobile.safeParse(params).success).toBe(false);
    }
  });

  test("memory upsert and delete reject unknown scopes, blank ids, and extras", () => {
    const upsert = jsonRpcRequestSchemas["cowork/memory/upsert"];
    const del = jsonRpcRequestSchemas["cowork/memory/delete"];
    const mobileUpsert = mobileJsonRpcControlRequestSchemas["cowork/memory/upsert"];

    expect(upsert.parse({ scope: "workspace", content: "remember this" }).scope).toBe("workspace");
    expect(mobileUpsert.parse({ scope: "user", id: "hot", content: "x" }).id).toBe("hot");

    expect(upsert.safeParse({ scope: "global", content: "x" }).success).toBe(false);
    expect(upsert.safeParse({ scope: "workspace", content: "x", extra: true }).success).toBe(false);
    expect(upsert.safeParse({ content: "x" }).success).toBe(false);
    expect(del.safeParse({ scope: "workspace", id: "   " }).success).toBe(false);
    expect(del.safeParse({ scope: "workspace", id: "hot", extra: true }).success).toBe(false);
  });

  test("session file upload rejects blank names, empty payloads, and extras", () => {
    const schema = jsonRpcRequestSchemas["cowork/session/file/upload"];
    expect(
      schema.safeParse({
        filename: "notes.txt",
        contentBase64: "aGVsbG8=",
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ filename: "   ", contentBase64: "aGVsbG8=" }).success).toBe(false);
    expect(schema.safeParse({ filename: "notes.txt", contentBase64: "" }).success).toBe(false);
    expect(
      schema.safeParse({
        filename: "notes.txt",
        contentBase64: "aGVsbG8=",
        extra: true,
      }).success,
    ).toBe(false);
  });
});
