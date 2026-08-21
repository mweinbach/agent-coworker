import { describe, expect, test } from "bun:test";

import { jsonRpcControlRequestSchemas as mobileJsonRpcControlRequestSchemas } from "../apps/mobile/src/cowork-shared/jsonrpcControlSchemas";
import { jsonRpcRequestSchemas } from "../src/server/jsonrpc/schema";
import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

function expectReject(
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown,
) {
  expect(schema.safeParse(value).success).toBe(false);
}

function expectAccept(
  schema: { parse: (value: unknown) => unknown },
  value: unknown,
  expected: unknown = value,
) {
  expect(schema.parse(value)).toEqual(expected);
}

describe("creation, import, and provider request schemas", () => {
  test("creation preflight accepts known kinds and rejects unknown kind or provider", () => {
    const schema = jsonRpcRequestSchemas["cowork/creation/preflight"];
    expectAccept(schema, { kind: "chat" });
    expectAccept(schema, { kind: "research", cwd: "/workspace/project" });
    expectAccept(schema, { kind: "task", provider: "google", model: "gemini-2.5-flash" });

    expectReject(schema, { kind: "note" });
    expectReject(schema, { kind: "chat", provider: "chatgpt" });
    expectReject(schema, { kind: "chat", model: "" });
    expectReject(schema, { kind: "chat", cwd: "   " });
    expectReject(schema, { kind: "chat", extra: true });
    expectReject(schema, {});
  });

  test("import list/plugin/skill reject unknown source, kind, or scope", () => {
    const list = jsonRpcRequestSchemas["cowork/import/list"];
    const plugin = jsonRpcRequestSchemas["cowork/import/plugin"];
    const skill = jsonRpcRequestSchemas["cowork/import/skill"];

    expectAccept(list, { source: "claude", kind: "plugin" });
    expectAccept(plugin, {
      source: "codex",
      sourcePath: "/tmp/plugin",
      conversionRequired: false,
      targetScope: "user",
    });
    expectAccept(skill, {
      source: "claude",
      sourcePath: "/tmp/skill",
      targetScope: "workspace",
    });

    expectReject(list, { source: "cursor", kind: "plugin" });
    expectReject(list, { source: "claude", kind: "mcp" });
    expectReject(plugin, {
      source: "claude",
      sourcePath: "/tmp/plugin",
      targetScope: "user",
    });
    expectReject(plugin, {
      source: "claude",
      sourcePath: "   ",
      conversionRequired: true,
      targetScope: "workspace",
    });
    expectReject(skill, {
      source: "claude",
      sourcePath: "/tmp/skill",
      targetScope: "project",
    });
    expectReject(list, { source: "claude", kind: "plugin", extra: true });
  });

  test("plugin and skill install keep distinct targetScope enums", () => {
    const pluginInstall = jsonRpcRequestSchemas["cowork/plugins/install"];
    const skillInstall = jsonRpcRequestSchemas["cowork/skills/install"];

    expectAccept(pluginInstall, { sourceInput: "owner/repo", targetScope: "workspace" });
    expectAccept(pluginInstall, { sourceInput: "owner/repo", targetScope: "user" });
    expectReject(pluginInstall, { sourceInput: "owner/repo", targetScope: "project" });
    expectReject(pluginInstall, { sourceInput: "owner/repo", targetScope: "global" });
    expectReject(pluginInstall, {
      sourceInput: "owner/repo",
      targetScope: "workspace",
      extra: true,
    });

    expectAccept(skillInstall, { sourceInput: "owner/repo", targetScope: "project" });
    expectAccept(skillInstall, { sourceInput: "owner/repo", targetScope: "global" });
    expectReject(skillInstall, { sourceInput: "owner/repo", targetScope: "workspace" });
    expectReject(skillInstall, { sourceInput: "owner/repo", targetScope: "user" });
  });

  test("marketplace add/remove reject blank identifiers and extras", () => {
    const add = jsonRpcRequestSchemas["cowork/marketplaces/add"];
    const remove = jsonRpcRequestSchemas["cowork/marketplaces/remove"];

    expectAccept(add, { sourceInput: "acme/skills" });
    expectAccept(remove, { id: "acme-skills" });
    expectReject(add, { sourceInput: "   " });
    expectReject(add, { sourceInput: "acme/skills", extra: true });
    expectReject(remove, { id: "" });
    expectReject(remove, { id: "acme-skills", extra: true });
  });

  test("provider auth and custom-model mutations reject unknown providers and incomplete payloads", () => {
    const setApiKey = jsonRpcRequestSchemas["cowork/provider/auth/setApiKey"];
    const setConfig = jsonRpcRequestSchemas["cowork/provider/auth/setConfig"];
    const copyApiKey = jsonRpcRequestSchemas["cowork/provider/auth/copyApiKey"];
    const customModel = jsonRpcRequestSchemas["cowork/provider/customModel/add"];
    const setEnabled = jsonRpcRequestSchemas["cowork/provider/model/setEnabled"];
    const lmStudioStart = jsonRpcRequestSchemas["cowork/provider/lmstudio/local/start"];

    expectAccept(setApiKey, { provider: "openai", methodId: "api-key", apiKey: "sk-test" });
    expectAccept(setConfig, {
      provider: "bedrock",
      methodId: "iam",
      values: { region: "us-east-1" },
    });
    expectAccept(copyApiKey, { provider: "openai", sourceProvider: "google" });
    expectAccept(customModel, { provider: "openai", modelId: "ft:custom" });
    expectAccept(setEnabled, {
      provider: "google",
      models: [{ id: "gemini-2.5-flash", enabled: false }],
    });
    expectAccept(lmStudioStart, { timeoutMs: 60_000 });

    expectReject(setApiKey, { provider: "chatgpt", methodId: "api-key", apiKey: "sk-test" });
    expectReject(setApiKey, { provider: "openai", methodId: "api-key" });
    expectReject(setApiKey, { provider: "openai", methodId: "   ", apiKey: "sk-test" });
    expectReject(setConfig, {
      provider: "openai",
      methodId: "api-key",
      values: { timeout: 30 },
    });
    expectReject(copyApiKey, { provider: "openai" });
    expectReject(copyApiKey, { provider: "openai", sourceProvider: "chatgpt" });
    expectReject(customModel, { provider: "openai", modelId: "   " });
    expectReject(setEnabled, { provider: "google", models: [] });
    expectReject(setEnabled, {
      provider: "google",
      models: [{ id: "gemini-2.5-flash", enabled: "no" }],
    });
    expectReject(lmStudioStart, { timeoutMs: 0 });
    expectReject(lmStudioStart, { timeoutMs: 60_001 });
    expectReject(lmStudioStart, { timeoutMs: 1.5 });
    expectReject(customModel, { provider: "openai", modelId: "ft:custom", extra: true });
  });

  test("connector setEnabled requires a non-blank connector id", () => {
    const schema = jsonRpcRequestSchemas["cowork/connectors/openai-native/setEnabled"];
    expectAccept(schema, { connectorId: "connector_gmail", enabled: true });
    expectReject(schema, { connectorId: "   ", enabled: true });
    expectReject(schema, { connectorId: "connector_gmail" });
    expectReject(schema, { enabled: true });
  });

  test("agent wait rejects empty ids, negative timeouts, and unknown modes", () => {
    const schema = jsonRpcRequestSchemas["cowork/session/agent/wait"];
    expectAccept(schema, { threadId: "thread-1", agentIds: ["agent-1"], mode: "all" });
    expectAccept(schema, { threadId: "thread-1", agentIds: ["agent-1"], timeoutMs: 0 });

    expectReject(schema, { threadId: "thread-1", agentIds: [] });
    expectReject(schema, { threadId: "thread-1", agentIds: ["   "] });
    expectReject(schema, { threadId: "thread-1", agentIds: ["agent-1"], timeoutMs: -1 });
    expectReject(schema, { threadId: "thread-1", agentIds: ["agent-1"], timeoutMs: 1.5 });
    expectReject(schema, { threadId: "thread-1", agentIds: ["agent-1"], mode: "race" });
    expectReject(schema, { threadId: "thread-1", agentIds: ["agent-1"], extra: true });
    expectReject(schema, { agentIds: ["agent-1"] });
  });

  test("keeps mobile provider-auth copies aligned for setApiKey and copyApiKey", () => {
    const setApiKey = { provider: "openai" as const, methodId: "api-key", apiKey: "sk-test" };
    expect(jsonRpcControlRequestSchemas["cowork/provider/auth/setApiKey"].parse(setApiKey)).toEqual(
      setApiKey,
    );
    expect(
      mobileJsonRpcControlRequestSchemas["cowork/provider/auth/setApiKey"].parse(setApiKey),
    ).toEqual(setApiKey);
    expect(
      mobileJsonRpcControlRequestSchemas["cowork/provider/auth/copyApiKey"].safeParse({
        provider: "openai",
      }).success,
    ).toBe(false);
    expect(
      jsonRpcControlRequestSchemas["cowork/marketplaces/add"].safeParse({ sourceInput: "   " })
        .success,
    ).toBe(false);
  });
});
