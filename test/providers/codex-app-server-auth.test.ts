import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loginCodexAppServerChatGpt,
  logoutCodexAppServer,
  readCodexAppServerAccount,
  readCodexAppServerRateLimits,
} from "../../src/providers/codexAppServerAuth";
import {
  type CodexAppServerClient,
  __internal as clientInternal,
  closePooledCodexAppServerClients,
  getPooledCodexAppServerClient,
} from "../../src/providers/codexAppServerClient";

describe("codex app-server auth", () => {
  afterEach(async () => {
    clientInternal.setClientFactoryForTests(undefined);
    await closePooledCodexAppServerClients();
  });

  test("returns not logged in without starting process if auth.json is missing", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-missing-"));
    let clientStarted = false;

    clientInternal.setClientFactoryForTests(async () => {
      clientStarted = true;
      throw new Error("Should not start client");
    });

    const result = await readCodexAppServerAccount({ codexHome });
    expect(result).toEqual({ account: null, requiresOpenaiAuth: true });
    expect(clientStarted).toBe(false);
  });

  test("reads account information when auth.json exists", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-existing-"));
    await fs.writeFile(path.join(codexHome, "auth.json"), "{}", "utf8");

    let requestedMethod = "";

    clientInternal.setClientFactoryForTests(async () => {
      return {
        command: { command: "node", args: [], source: "managed" },
        isClosed: () => false,
        request: async (method) => {
          requestedMethod = method;
          if (method === "initialize") return {};
          if (method === "account/read") {
            return {
              account: { type: "chatgpt", email: "test@example.com", planType: "Pro" },
              requiresOpenaiAuth: false,
            };
          }
          return {};
        },
        notify: () => {},
        interruptTurn: async () => {},
        onNotification: () => () => {},
        onServerRequest: () => () => {},
        onJsonRpcMessage: () => () => {},
        close: async () => {},
      };
    });

    const result = await readCodexAppServerAccount({ codexHome });
    expect(requestedMethod).toBe("account/read");
    expect(result).toEqual({
      account: { type: "chatgpt", email: "test@example.com", planType: "Pro" },
      requiresOpenaiAuth: false,
    });
  });

  test("reads rate limits", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-limits-"));
    await fs.writeFile(path.join(codexHome, "auth.json"), "{}", "utf8");

    clientInternal.setClientFactoryForTests(async () => {
      return {
        command: { command: "node", args: [], source: "managed" },
        isClosed: () => false,
        request: async (method) => {
          if (method === "account/rateLimits/read") {
            return {
              rateLimits: {
                primary: { usedPercent: 42, windowDurationMins: 15 },
              },
            };
          }
          return {};
        },
        notify: () => {},
        interruptTurn: async () => {},
        onNotification: () => () => {},
        onServerRequest: () => () => {},
        onJsonRpcMessage: () => () => {},
        close: async () => {},
      };
    });

    const result = await readCodexAppServerRateLimits({ codexHome });
    expect(result).toEqual({
      primary: { usedPercent: 42, windowDurationMins: 15 },
    });
  });

  test("login closes pooled clients for the same Codex home so turns reload fresh auth", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-login-pool-"));
    const clients: CodexAppServerClient[] = [];
    let closeCount = 0;

    clientInternal.setClientFactoryForTests(async () => {
      const listeners = new Set<Parameters<CodexAppServerClient["onNotification"]>[0]>();
      let closed = false;
      const client: CodexAppServerClient = {
        command: { command: "node", args: [], source: "system" },
        isClosed: () => closed,
        request: async (method) => {
          if (method === "initialize") return {};
          if (method === "account/login/start") {
            setTimeout(() => {
              for (const listener of listeners) {
                listener({
                  method: "account/login/completed",
                  params: { loginId: "login-1", success: true },
                });
              }
            }, 0);
            return { authUrl: "https://example.test/login", loginId: "login-1" };
          }
          if (method === "account/read") {
            return {
              account: { type: "chatgpt", email: "fresh@example.com", planType: "Pro" },
              requiresOpenaiAuth: false,
            };
          }
          return {};
        },
        notify: () => {},
        interruptTurn: async () => {},
        onNotification: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        onServerRequest: () => () => {},
        onJsonRpcMessage: () => () => {},
        close: async () => {
          closed = true;
          closeCount += 1;
        },
      };
      clients.push(client);
      return client;
    });

    const runtimeClient = await getPooledCodexAppServerClient({
      cwd: "/tmp/workspace",
      codexHome,
    });

    const login = await loginCodexAppServerChatGpt({
      codexHome,
      openUrl: async () => true,
    });

    expect(login.account?.email).toBe("fresh@example.com");
    expect(runtimeClient.isClosed()).toBe(true);
    expect(closeCount).toBe(2);
    expect(clients).toHaveLength(2);
  });

  test("logoutCodexAppServer deletes auth.json and closes pooled clients", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-logout-"));
    const authFile = path.join(codexHome, "auth.json");
    await fs.writeFile(authFile, "{}", "utf8");

    let logoutCalled = false;
    clientInternal.setClientFactoryForTests(async () => {
      return {
        command: { command: "node", args: [], source: "managed" },
        isClosed: () => false,
        request: async (method) => {
          if (method === "initialize") return {};
          if (method === "account/logout") {
            logoutCalled = true;
            return {};
          }
          return {};
        },
        notify: () => {},
        interruptTurn: async () => {},
        onNotification: () => () => {},
        onServerRequest: () => () => {},
        onJsonRpcMessage: () => () => {},
        close: async () => {},
      };
    });

    const result = await logoutCodexAppServer({ codexHome });
    expect(result.revoked).toBe(true);
    expect(logoutCalled).toBe(true);
    await expect(fs.readFile(authFile, "utf8")).rejects.toThrow();
  });

  test("logoutCodexAppServer deletes auth.json even if app-server connection throws", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-logout-fail-"));
    const authFile = path.join(codexHome, "auth.json");
    await fs.writeFile(authFile, "{}", "utf8");

    clientInternal.setClientFactoryForTests(async () => {
      throw new Error("Connection refused");
    });

    await expect(logoutCodexAppServer({ codexHome })).rejects.toThrow("Connection refused");
    await expect(fs.readFile(authFile, "utf8")).rejects.toThrow();
  });
});
