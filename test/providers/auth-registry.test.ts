import { describe, expect, test, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths, readConnectionStore } from "../../src/connect";
import {
  authorizeProviderAuth,
  callbackProviderAuth,
  listProviderAuthMethods,
  resolveProviderAuthMethod,
  setProviderApiKey,
} from "../../src/providers/authRegistry";

describe("providers/authRegistry", () => {
  test("lists auth methods for all providers", () => {
    const methods = listProviderAuthMethods();
    expect(methods.openai?.some((m) => m.id === "api_key")).toBe(true);
    expect(methods.google?.some((m) => m.id === "exa_api_key")).toBe(true);
    expect(methods["codex-cli"]?.some((m) => m.id === "oauth_cli")).toBe(true);
    expect(methods["codex-cli"]?.some((m) => m.id === "oauth_device")).toBe(true);
  });

  test("resolveProviderAuthMethod returns null for unknown method", () => {
    expect(resolveProviderAuthMethod("openai", "oauth_cli")).toBeNull();
  });

  test("authorizeProviderAuth returns challenge for oauth method", () => {
    const result = authorizeProviderAuth({ provider: "codex-cli", methodId: "oauth_cli" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.challenge.method).toBe("auto");
    expect(result.challenge.url).toBe("https://auth.openai.com/oauth/authorize");
  });

  test("authorizeProviderAuth returns device-code challenge for codex oauth_device", () => {
    const result = authorizeProviderAuth({ provider: "codex-cli", methodId: "oauth_device" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.challenge.method).toBe("auto");
    expect(result.challenge.url).toBe("https://auth.openai.com/codex/device");
  });

  test("authorizeProviderAuth fails for api key method", () => {
    const result = authorizeProviderAuth({ provider: "openai", methodId: "api_key" });
    expect(result.ok).toBe(false);
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
    expect(result.message).toContain("Exa API key saved");
    expect(connect).toHaveBeenCalledTimes(0);

    const store = await readConnectionStore(paths);
    expect(store.toolApiKeys?.exa).toBe("exa-secret-key");
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

  test("callbackProviderAuth forwards code to connect handler", async () => {
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
      code: "auth-code-123",
      connect,
      oauthStdioMode: "pipe",
    });

    expect(result.ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[0]?.code).toBe("auth-code-123");
  });
});
