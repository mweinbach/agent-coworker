import { describe, expect, test } from "bun:test";

import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("provider request schema rejects", () => {
  test("customModel requires a known provider and trims the model id", () => {
    const schema = jsonRpcControlRequestSchemas["cowork/provider/customModel/add"];
    expect(schema.parse({ provider: "google", modelId: "  custom-1  " })).toEqual({
      provider: "google",
      modelId: "custom-1",
    });
    rejects(schema, { provider: "chatgpt", modelId: "custom-1" });
    rejects(schema, { provider: "google", modelId: "   " });
    rejects(schema, { provider: "google" });
  });

  test("setApiKey requires an apiKey and setConfig values must be string records", () => {
    const setApiKey = jsonRpcControlRequestSchemas["cowork/provider/auth/setApiKey"];
    const setConfig = jsonRpcControlRequestSchemas["cowork/provider/auth/setConfig"];
    expect(
      setApiKey.parse({
        provider: "openai",
        methodId: "api-key",
        apiKey: "",
      }),
    ).toEqual({
      provider: "openai",
      methodId: "api-key",
      apiKey: "",
    });
    rejects(setApiKey, { provider: "openai", methodId: "api-key" });
    rejects(setConfig, {
      provider: "openai",
      methodId: "api-key",
      values: { timeout: 30 },
    });
    rejects(setConfig, {
      provider: "openai",
      methodId: "api-key",
    });
  });

  test("copyApiKey rejects extras and unknown sources", () => {
    const schema = jsonRpcControlRequestSchemas["cowork/provider/auth/copyApiKey"];
    rejects(schema, {
      provider: "openai",
      sourceProvider: "google",
      extra: true,
    });
    rejects(schema, {
      provider: "openai",
      sourceProvider: "chatgpt",
    });
  });

  test("model setEnabled requires at least one enabled boolean", () => {
    const schema = jsonRpcControlRequestSchemas["cowork/provider/model/setEnabled"];
    expect(
      schema.parse({
        provider: "google",
        models: [{ id: "gemini-2.5-flash", enabled: false }],
      }),
    ).toEqual({
      provider: "google",
      models: [{ id: "gemini-2.5-flash", enabled: false }],
    });
    rejects(schema, { provider: "google", models: [] });
    rejects(schema, {
      provider: "google",
      models: [{ id: "gemini-2.5-flash" }],
    });
  });

  test("LM Studio start timeout must be a positive integer up to 60000", () => {
    const schema = jsonRpcControlRequestSchemas["cowork/provider/lmstudio/local/start"];
    expect(schema.parse({ timeoutMs: 1 })).toEqual({ timeoutMs: 1 });
    expect(schema.parse({ timeoutMs: 60_000 })).toEqual({ timeoutMs: 60_000 });
    rejects(schema, { timeoutMs: 0 });
    rejects(schema, { timeoutMs: 60_001 });
    rejects(schema, { timeoutMs: 1.5 });
  });
});

describe("MCP request schema rejects", () => {
  const upsert = jsonRpcControlRequestSchemas["cowork/mcp/server/upsert"];
  const setEnabled = jsonRpcControlRequestSchemas["cowork/mcp/server/setEnabled"];
  const remove = jsonRpcControlRequestSchemas["cowork/mcp/server/delete"];

  test("upsert trims stdio, http, and sse transports", () => {
    expect(
      upsert.parse({
        source: "user",
        server: {
          name: "  docs  ",
          transport: { type: "stdio", command: "  uvx  " },
        },
      }),
    ).toMatchObject({
      source: "user",
      server: {
        name: "docs",
        transport: { type: "stdio", command: "uvx" },
      },
    });
    expect(
      upsert.parse({
        server: {
          name: "remote",
          transport: { type: "http", url: "  https://example.test  " },
        },
      }),
    ).toMatchObject({
      server: { transport: { type: "http", url: "https://example.test" } },
    });
    expect(
      upsert.parse({
        server: {
          name: "events",
          transport: { type: "sse", url: "  https://example.test/sse  " },
        },
      }),
    ).toMatchObject({
      server: { transport: { type: "sse", url: "https://example.test/sse" } },
    });
  });

  test("upsert rejects missing command/url, websocket, extras, and invalid auth", () => {
    rejects(upsert, {
      server: { name: "docs", transport: { type: "stdio" } },
    });
    rejects(upsert, {
      server: { name: "remote", transport: { type: "http" } },
    });
    rejects(upsert, {
      server: { name: "remote", transport: { type: "websocket", url: "wss://example.test" } },
    });
    rejects(upsert, {
      server: {
        name: "docs",
        transport: { type: "stdio", command: "uvx", extra: true },
      },
    });
    rejects(upsert, {
      server: { name: "   ", transport: { type: "stdio", command: "uvx" } },
    });
    rejects(upsert, {
      server: {
        name: "docs",
        transport: { type: "stdio", command: "uvx" },
        retries: -1,
      },
    });
    rejects(upsert, {
      server: {
        name: "docs",
        transport: { type: "stdio", command: "uvx" },
        retries: 1.5,
      },
    });
    rejects(upsert, {
      server: {
        name: "docs",
        transport: { type: "stdio", command: "uvx" },
        auth: { type: "bearer", token: "secret" },
      },
    });
    rejects(upsert, {
      source: "plugin",
      server: { name: "docs", transport: { type: "stdio", command: "uvx" } },
    });
    rejects(upsert, {
      extra: true,
      server: { name: "docs", transport: { type: "stdio", command: "uvx" } },
    });
  });

  test("setEnabled accepts plugin source while delete rejects system source", () => {
    expect(
      setEnabled.parse({
        name: "docs",
        source: "plugin",
        enabled: false,
        pluginId: "docs-pack",
      }),
    ).toEqual({
      name: "docs",
      source: "plugin",
      enabled: false,
      pluginId: "docs-pack",
    });
    rejects(remove, { name: "docs", source: "system" });
    expect(remove.parse({ name: "  docs  ", source: "user" })).toEqual({
      name: "docs",
      source: "user",
    });
  });
});
