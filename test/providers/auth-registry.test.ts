import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths, readConnectionStore } from "../../src/connect";
import {
  authorizeProviderAuth,
  callbackProviderAuth,
  copyProviderApiKey,
  listProviderAuthMethods,
  logoutProviderAuth,
  requiresProviderAuthCode,
  resolveProviderAuthMethod,
  setProviderApiKey,
} from "../../src/providers/authRegistry";
import { __clearAwsBedrockProxyDiscoveryCacheForTests } from "../../src/providers/awsBedrockProxyShared";

describe("providers/authRegistry", () => {
  beforeEach(() => {
    __clearAwsBedrockProxyDiscoveryCacheForTests();
  });

  test("lists auth methods for all providers", () => {
    const methods = listProviderAuthMethods();
    expect(methods.openai?.some((m) => m.id === "api_key")).toBe(true);
    expect(methods.google?.some((m) => m.id === "exa_api_key")).toBe(true);
    expect(methods.baseten?.some((m) => m.id === "api_key")).toBe(true);
    expect(methods.together?.some((m) => m.id === "api_key")).toBe(true);
    expect(methods.nvidia?.some((m) => m.id === "api_key")).toBe(true);
    expect(methods["opencode-go"]?.some((m) => m.id === "api_key")).toBe(true);
    expect(methods["opencode-zen"]?.some((m) => m.id === "api_key")).toBe(true);
    expect(methods["codex-cli"]?.some((m) => m.id === "oauth_cli")).toBe(true);
    expect(methods["codex-cli"]?.some((m) => m.id === "oauth_device")).toBe(false);
  });

  test("resolveProviderAuthMethod returns null for unknown method", () => {
    expect(resolveProviderAuthMethod("openai", "oauth_cli")).toBeNull();
  });

  test("requiresProviderAuthCode stays false for auto oauth and unknown methods", () => {
    expect(requiresProviderAuthCode("codex-cli", "oauth_cli")).toBe(false);
    expect(requiresProviderAuthCode("openai", "missing")).toBe(false);
  });

  test("authorizeProviderAuth returns challenge for oauth method", () => {
    const result = authorizeProviderAuth({ provider: "codex-cli", methodId: "oauth_cli" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.challenge.method).toBe("auto");
    expect(result.challenge.url).toBeUndefined();
    expect(result.challenge.instructions).toContain("save the returned token locally");
  });

  test("authorizeProviderAuth fails for api key method", () => {
    const result = authorizeProviderAuth({ provider: "openai", methodId: "api_key" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe('Auth method "api_key" does not support authorization.');
    }
  });

  test("setProviderApiKey validates and calls connect handler", async () => {
    const connect = mock(async (opts: any) => ({
      ok: true as const,
      provider: opts.provider,
      mode: "api_key" as const,
      storageFile: "/tmp/connections.json",
      message: "saved",
      maskedApiKey: "sk-t...est",
    }));

    const result = await setProviderApiKey({
      provider: "openai",
      methodId: "api_key",
      apiKey: "sk-test",
      connect,
    });

    expect(result.ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[0]?.apiKey).toBe("sk-test");
  });

  test("setProviderApiKey refuses oauth methods", async () => {
    const connect = mock(async () => ({
      ok: true as const,
      provider: "codex-cli" as const,
      mode: "api_key" as const,
      storageFile: "/tmp/connections.json",
      message: "saved",
      maskedApiKey: "sk-t...est",
    }));

    const result = await setProviderApiKey({
      provider: "codex-cli",
      methodId: "oauth_cli",
      apiKey: "unused",
      connect,
    });

    expect(result.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(result.message).toContain("not an API key method");
  });

  test("setProviderApiKey trims whitespace before forwarding and rejects blank keys", async () => {
    const connect = mock(async (opts: any) => ({
      ok: true as const,
      provider: opts.provider,
      mode: "api_key" as const,
      storageFile: "/tmp/connections.json",
      message: "saved",
      maskedApiKey: "sk-t...est",
    }));

    const trimmed = await setProviderApiKey({
      provider: "openai",
      methodId: "api_key",
      apiKey: "  sk-test-trimmed  ",
      connect,
    });

    expect(trimmed.ok).toBe(true);
    expect(connect.mock.calls[0]?.[0]?.apiKey).toBe("sk-test-trimmed");

    const blank = await setProviderApiKey({
      provider: "openai",
      methodId: "api_key",
      apiKey: "   ",
      connect,
    });

    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.message).toBe("API key is required.");
    }
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("setProviderApiKey stores Exa key for google exa_api_key method", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-registry-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const connect = mock(async (_opts: any) => ({
      ok: false as const,
      provider: "google" as const,
      message: "should not be called",
    }));

    const result = await setProviderApiKey({
      provider: "google",
      methodId: "exa_api_key",
      apiKey: "exa-secret-key",
      paths,
      connect,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("api_key");
    expect(result.message).toContain("Google webSearch");
    expect(connect).toHaveBeenCalledTimes(0);

    const store = await readConnectionStore(paths);
    expect(store.toolApiKeys?.exa).toBe("exa-secret-key");
  });

  test("setProviderApiKey for aws-bedrock-proxy requires a proxy base URL", async () => {
    const connect = mock(async (opts: any) => ({
      ok: true as const,
      provider: opts.provider,
      mode: "api_key" as const,
      storageFile: "/tmp/connections.json",
      message: "saved",
      maskedApiKey: "prox...oken",
    }));

    const result = await setProviderApiKey({
      provider: "aws-bedrock-proxy",
      methodId: "api_key",
      apiKey: "proxy-token",
      providerOptions: {},
      connect,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Set the AWS Bedrock Proxy URL before saving a proxy token.");
    }
    expect(connect).toHaveBeenCalledTimes(0);
  });

  test("setProviderApiKey for aws-bedrock-proxy surfaces unauthorized guidance and skips connect", async () => {
    const connect = mock(async (opts: any) => ({
      ok: true as const,
      provider: opts.provider,
      mode: "api_key" as const,
      storageFile: "/tmp/connections.json",
      message: "saved",
      maskedApiKey: "prox...oken",
    }));

    const result = await setProviderApiKey({
      provider: "aws-bedrock-proxy",
      methodId: "api_key",
      apiKey: "proxy-token",
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.example.com",
        },
      },
      fetchImpl: (async () => new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
      connect,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Proxy token rejected by /models");
      expect(result.message).toContain("Use your LiteLLM proxy token");
    }
    expect(connect).toHaveBeenCalledTimes(0);
  });

  test("setProviderApiKey for aws-bedrock-proxy validates /models before saving", async () => {
    const connect = mock(async (opts: any) => ({
      ok: true as const,
      provider: opts.provider,
      mode: "api_key" as const,
      storageFile: "/tmp/connections.json",
      message: "saved",
      maskedApiKey: "prox...oken",
    }));

    const result = await setProviderApiKey({
      provider: "aws-bedrock-proxy",
      methodId: "api_key",
      apiKey: "  proxy-token  ",
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.example.com",
        },
      },
      fetchImpl: (async () => new Response(JSON.stringify({
        object: "list",
        data: [{ id: "router", object: "model" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
      connect,
    });

    expect(result.ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[0]?.provider).toBe("aws-bedrock-proxy");
    expect(connect.mock.calls[0]?.[0]?.apiKey).toBe("proxy-token");
  });

  test("callbackProviderAuth calls connect handler for oauth method", async () => {
    const connect = mock(async (opts: any) => ({
      ok: true as const,
      provider: opts.provider,
      mode: "oauth" as const,
      storageFile: "/tmp/connections.json",
      message: "oauth complete",
    }));

    const result = await callbackProviderAuth({
      provider: "codex-cli",
      methodId: "oauth_cli",
      connect,
      oauthStdioMode: "pipe",
    });

    expect(result.ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("callbackProviderAuth rejects pasted codes for auto oauth methods", async () => {
    const connect = mock(async (opts: any) => ({
      ok: true as const,
      provider: opts.provider,
      mode: "oauth" as const,
      storageFile: "/tmp/connections.json",
      message: "oauth complete",
    }));

    const result = await callbackProviderAuth({
      provider: "codex-cli",
      methodId: "oauth_cli",
      code: "  auth-code-123  ",
      connect,
    });

    expect(result.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(result.message).toContain("does not accept a pasted authorization code");
  });

  test("copyProviderApiKey reuses a saved sibling key without exposing it", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-registry-copy-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const now = new Date().toISOString();
    await fs.mkdir(path.dirname(paths.connectionsFile), { recursive: true });
    await fs.writeFile(paths.connectionsFile, JSON.stringify({
      version: 1,
      updatedAt: now,
      services: {
        "opencode-go": {
          service: "opencode-go",
          mode: "api_key",
          apiKey: "opencode-go-key-1234",
          updatedAt: now,
        },
      },
    }), "utf-8");

    const connect = mock(async (opts: any) => ({
      ok: true as const,
      provider: opts.provider,
      mode: "api_key" as const,
      storageFile: paths.connectionsFile,
      message: "saved",
      maskedApiKey: "open...1234",
    }));

    const result = await copyProviderApiKey({
      provider: "opencode-zen",
      sourceProvider: "opencode-go",
      methodId: "api_key",
      paths,
      connect,
    });

    expect(result.ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[0]?.provider).toBe("opencode-zen");
    expect(connect.mock.calls[0]?.[0]?.apiKey).toBe("opencode-go-key-1234");
  });

  test("copyProviderApiKey fails when the source provider has no saved api key", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-registry-copy-missing-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const connect = mock(async (opts: any) => ({
      ok: true as const,
      provider: opts.provider,
      mode: "api_key" as const,
      storageFile: paths.connectionsFile,
      message: "saved",
      maskedApiKey: "masked",
    }));

    const result = await copyProviderApiKey({
      provider: "opencode-zen",
      sourceProvider: "opencode-go",
      methodId: "api_key",
      paths,
      connect,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("No saved API key found for opencode-go.");
    }
    expect(connect).toHaveBeenCalledTimes(0);
  });

  test("copyProviderApiKey refuses to overwrite an existing target api key", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-registry-copy-target-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const now = new Date().toISOString();
    await fs.mkdir(path.dirname(paths.connectionsFile), { recursive: true });
    await fs.writeFile(paths.connectionsFile, JSON.stringify({
      version: 1,
      updatedAt: now,
      services: {
        "opencode-go": {
          service: "opencode-go",
          mode: "api_key",
          apiKey: "opencode-go-key-1234",
          updatedAt: now,
        },
        "opencode-zen": {
          service: "opencode-zen",
          mode: "api_key",
          apiKey: "opencode-zen-key-5678",
          updatedAt: now,
        },
      },
    }), "utf-8");

    const connect = mock(async (opts: any) => ({
      ok: true as const,
      provider: opts.provider,
      mode: "api_key" as const,
      storageFile: paths.connectionsFile,
      message: "saved",
      maskedApiKey: "masked",
    }));

    const result = await copyProviderApiKey({
      provider: "opencode-zen",
      sourceProvider: "opencode-go",
      methodId: "api_key",
      paths,
      connect,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("opencode-zen already has a saved API key.");
    }
    expect(connect).toHaveBeenCalledTimes(0);
  });

  test("logoutProviderAuth calls disconnect handler", async () => {
    const disconnect = mock(async (opts: any) => ({
      ok: true as const,
      provider: opts.provider,
      storageFile: "/tmp/connections.json",
      message: "Codex OAuth credentials cleared.",
    }));

    const result = await logoutProviderAuth({
      provider: "codex-cli",
      disconnect,
    });

    expect(result.ok).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect.mock.calls[0]?.[0]?.provider).toBe("codex-cli");
  });

  test("copyProviderApiKey reports missing saved key and skips connect", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-registry-copy-none-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const now = new Date().toISOString();
    await fs.mkdir(path.dirname(paths.connectionsFile), { recursive: true });
    await fs.writeFile(paths.connectionsFile, JSON.stringify({
      version: 1,
      updatedAt: now,
      services: {
        openai: {
          service: "openai",
          mode: "oauth_pending",
          updatedAt: now,
        },
      },
    }), "utf-8");

    const connect = mock(async () => ({
      ok: true as const,
      provider: "anthropic" as const,
      mode: "api_key" as const,
      storageFile: paths.connectionsFile,
      message: "saved",
      maskedApiKey: "sk...",
    }));

    const result = await copyProviderApiKey({
      provider: "anthropic",
      sourceProvider: "openai",
      methodId: "api_key",
      paths,
      connect,
    });

    expect(result.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(result.message).toContain("No saved API key");
  });

  test("callbackProviderAuth rejects non-oauth methods", async () => {
    const connect = mock(async () => ({
      ok: true as const,
      provider: "openai" as const,
      mode: "api_key" as const,
      storageFile: "/tmp/connections.json",
      message: "saved",
      maskedApiKey: "sk...",
    }));

    const result = await callbackProviderAuth({
      provider: "openai",
      methodId: "api_key",
      connect,
    });

    expect(result.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(result.message).toContain("not an OAuth method");
  });
});
