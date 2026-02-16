import { describe, expect, test, mock } from "bun:test";

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
    expect(methods["codex-cli"]?.some((m) => m.id === "oauth_cli")).toBe(true);
    expect(methods["claude-code"]?.some((m) => m.id === "oauth_cli")).toBe(true);
  });

  test("resolveProviderAuthMethod returns null for unknown method", () => {
    expect(resolveProviderAuthMethod("openai", "oauth_cli")).toBeNull();
  });

  test("authorizeProviderAuth returns challenge for oauth method", () => {
    const result = authorizeProviderAuth({ provider: "codex-cli", methodId: "oauth_cli" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.challenge.method).toBe("auto");
    expect(result.challenge.command).toBe("codex login");
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
});
