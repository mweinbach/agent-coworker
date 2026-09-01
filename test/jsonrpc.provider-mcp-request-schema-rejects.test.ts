import { describe, expect, test } from "bun:test";

import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

function expectReject(method: keyof typeof jsonRpcControlRequestSchemas, value: unknown) {
  expect(jsonRpcControlRequestSchemas[method].safeParse(value).success).toBe(false);
}

describe("provider mutation request schemas", () => {
  test("custom model add/delete require a known provider and non-blank model id", () => {
    expect(
      jsonRpcControlRequestSchemas["cowork/provider/customModel/add"].parse({
        cwd: " /tmp/project ",
        provider: "openai",
        modelId: " my-model ",
      }),
    ).toEqual({
      cwd: "/tmp/project",
      provider: "openai",
      modelId: "my-model",
    });

    expectReject("cowork/provider/customModel/add", {
      provider: "chatgpt",
      modelId: "gpt-x",
    });
    expectReject("cowork/provider/customModel/delete", {
      provider: "openai",
      modelId: "  ",
    });
    expectReject("cowork/provider/customModel/add", {
      provider: "openai",
      modelId: "ok",
      extra: true,
    });
  });

  test("auth setApiKey/setConfig and copyApiKey reject malformed credentials", () => {
    expect(
      jsonRpcControlRequestSchemas["cowork/provider/auth/setApiKey"].parse({
        provider: "google",
        methodId: "api_key",
        apiKey: "notareal-google-key",
      }),
    ).toMatchObject({ provider: "google", methodId: "api_key" });

    expectReject("cowork/provider/auth/setApiKey", {
      provider: "google",
      methodId: "api_key",
    });
    expectReject("cowork/provider/auth/setApiKey", {
      provider: "unknown",
      methodId: "api_key",
      apiKey: "x",
    });
    expectReject("cowork/provider/auth/setConfig", {
      provider: "bedrock",
      methodId: "aws_keys",
      values: { accessKeyId: 1 },
    });
    expectReject("cowork/provider/auth/setConfig", {
      provider: "bedrock",
      methodId: "aws_keys",
    });
    expectReject("cowork/provider/auth/copyApiKey", {
      provider: "openai",
      sourceProvider: "google",
      extra: true,
    });
    expectReject("cowork/provider/auth/copyApiKey", {
      provider: "openai",
      sourceProvider: "chatgpt",
    });
  });

  test("model enable lists and LM Studio start timeouts stay bounded", () => {
    expect(
      jsonRpcControlRequestSchemas["cowork/provider/model/setEnabled"].parse({
        provider: "openai",
        models: [{ id: " gpt-5.4 ", enabled: false }],
      }),
    ).toEqual({
      provider: "openai",
      models: [{ id: "gpt-5.4", enabled: false }],
    });

    expectReject("cowork/provider/model/setEnabled", { provider: "openai", models: [] });
    expectReject("cowork/provider/model/setEnabled", {
      provider: "openai",
      models: [{ id: "gpt-5.4" }],
    });
    expectReject("cowork/provider/lmstudio/local/start", { timeoutMs: 0 });
    expectReject("cowork/provider/lmstudio/local/start", { timeoutMs: 60_001 });
    expectReject("cowork/provider/lmstudio/local/start", { timeoutMs: 1.5 });
  });
});

describe("MCP server request schemas", () => {
  test("upsert accepts stdio/http transports and trims the server name", () => {
    expect(
      jsonRpcControlRequestSchemas["cowork/mcp/server/upsert"].parse({
        source: "user",
        server: {
          name: " docs ",
          transport: { type: "stdio", command: " uvx ", args: ["docs-mcp"] },
          retries: 2,
          auth: { type: "none" },
        },
      }),
    ).toMatchObject({
      source: "user",
      server: {
        name: "docs",
        transport: { type: "stdio", command: "uvx", args: ["docs-mcp"] },
        retries: 2,
        auth: { type: "none" },
      },
    });

    expect(
      jsonRpcControlRequestSchemas["cowork/mcp/server/upsert"].parse({
        server: {
          name: "remote",
          transport: {
            type: "sse",
            url: " https://example.test/mcp ",
            headers: { Authorization: "Bearer notarealtoken" },
          },
          auth: { type: "oauth", oauthMode: "code" },
        },
      }).server.transport,
    ).toEqual({
      type: "sse",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer notarealtoken" },
    });
  });

  test("upsert rejects invalid transports, auth, retries, and request extras", () => {
    expectReject("cowork/mcp/server/upsert", {
      server: { name: "docs", transport: { type: "stdio" } },
    });
    expectReject("cowork/mcp/server/upsert", {
      server: { name: "docs", transport: { type: "http" } },
    });
    expectReject("cowork/mcp/server/upsert", {
      server: { name: "docs", transport: { type: "websocket", url: "wss://example.test" } },
    });
    expectReject("cowork/mcp/server/upsert", {
      server: {
        name: "docs",
        transport: { type: "stdio", command: "uvx", extra: true },
      },
    });
    expectReject("cowork/mcp/server/upsert", {
      server: {
        name: "docs",
        transport: { type: "http", url: "https://example.test", extra: true },
      },
    });
    expectReject("cowork/mcp/server/upsert", {
      server: { name: "  ", transport: { type: "stdio", command: "uvx" } },
    });
    expectReject("cowork/mcp/server/upsert", {
      server: {
        name: "docs",
        transport: { type: "stdio", command: "uvx" },
        retries: -1,
      },
    });
    expectReject("cowork/mcp/server/upsert", {
      server: {
        name: "docs",
        transport: { type: "stdio", command: "uvx" },
        retries: 1.5,
      },
    });
    expectReject("cowork/mcp/server/upsert", {
      server: {
        name: "docs",
        transport: { type: "stdio", command: "uvx" },
        auth: { type: "bearer" },
      },
    });
    expectReject("cowork/mcp/server/upsert", {
      source: "plugin",
      server: { name: "docs", transport: { type: "stdio", command: "uvx" } },
    });
    expectReject("cowork/mcp/server/upsert", {
      extra: true,
      server: { name: "docs", transport: { type: "stdio", command: "uvx" } },
    });
  });

  test("setEnabled/validate/auth require a known source and non-blank name", () => {
    expect(
      jsonRpcControlRequestSchemas["cowork/mcp/server/setEnabled"].parse({
        name: " docs ",
        source: "plugin",
        enabled: false,
        pluginId: " toolkit ",
        pluginScope: "workspace",
      }),
    ).toEqual({
      name: "docs",
      source: "plugin",
      enabled: false,
      pluginId: "toolkit",
      pluginScope: "workspace",
    });

    expectReject("cowork/mcp/server/setEnabled", {
      name: "docs",
      source: "inherited",
      enabled: true,
    });
    expectReject("cowork/mcp/server/setEnabled", { name: "", source: "user", enabled: true });
    expectReject("cowork/mcp/server/validate", { name: "docs", pluginId: "  " });
    expectReject("cowork/mcp/server/auth/setApiKey", { name: "docs" });
    expectReject("cowork/mcp/server/delete", { name: "docs", source: "system" });
  });
});
