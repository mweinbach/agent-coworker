import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scratchRoots } from "../../src/platform/sandbox/policy";
import {
  listCodexAppServerModels,
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
import { createCodexAppServerModelDiscoveryAdapter } from "../../src/providers/modelDiscoveryAdapters";

async function makeIsolatedCodexHome(): Promise<string> {
  const root = scratchRoots()[0];
  if (!root) throw new Error("No platform scratch root is available for tests");
  return await fs.mkdtemp(path.join(root, "cowork-auth-model-cancel-"));
}

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

  test("normalizes model/list descriptions, reasoning defaults, and runtime options", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-models-"));

    clientInternal.setClientFactoryForTests(async () => {
      return {
        command: { command: "node", args: [], source: "managed" },
        isClosed: () => false,
        request: async (method) => {
          if (method === "model/list") {
            return {
              data: [
                {
                  id: "future-model",
                  model: "future-model",
                  displayName: "Future Model",
                  description: "A future model.",
                  supports_image_input: true,
                  reasoning: {
                    available_efforts: ["low", "medium", "high"],
                    default_effort: "medium",
                  },
                  runtime_options: {
                    webSearchMode: "cached",
                  },
                  runtime_overrides: {
                    reasoningSummary: "concise",
                  },
                  isDefault: true,
                },
                {
                  id: "solstice-alpha",
                  model: "solstice-alpha",
                  displayName: "Solstice Alpha",
                  defaultReasoningEffort: "medium",
                  supportedReasoningEfforts: [
                    { reasoningEffort: "low", description: "Fastest responses" },
                    { reasoningEffort: "medium", description: "Balanced responses" },
                    { reasoningEffort: "high", description: "Deeper reasoning" },
                    { reasoningEffort: "xhigh", description: "Most thorough reasoning" },
                    { reasoningEffort: "high", description: "Duplicate effort" },
                    { reasoningEffort: "unsupported", description: "Unknown effort" },
                  ],
                  isDefault: false,
                },
              ],
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

    await expect(listCodexAppServerModels({ codexHome })).resolves.toEqual([
      {
        id: "future-model",
        model: "future-model",
        displayName: "Future Model",
        description: "A future model.",
        supportsImageInput: true,
        reasoningEfforts: ["low", "medium", "high"],
        reasoningDefaultEffort: "medium",
        runtimeOptions: {
          webSearchMode: "cached",
        },
        runtimeOverrides: {
          reasoningSummary: "concise",
        },
        isDefault: true,
      },
      {
        id: "solstice-alpha",
        model: "solstice-alpha",
        displayName: "Solstice Alpha",
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
        reasoningDefaultEffort: "medium",
        isDefault: false,
      },
    ]);
  });

  test("does not start a client for an already cancelled model listing", async () => {
    const codexHome = await makeIsolatedCodexHome();
    let clientStarted = false;
    clientInternal.setClientFactoryForTests(async () => {
      clientStarted = true;
      throw new Error("Client should not start");
    });
    const controller = new AbortController();
    controller.abort(new Error("catalog cancelled"));

    try {
      await expect(
        listCodexAppServerModels({ codexHome, signal: controller.signal }),
      ).rejects.toThrow("catalog cancelled");
      expect(clientStarted).toBe(false);
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  test("catalog cancellation stops model pagination without closing the pooled client", async () => {
    const codexHome = await makeIsolatedCodexHome();
    const controller = new AbortController();
    let pageStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pageStarted = resolve;
    });
    let releasePage!: () => void;
    let modelRequests = 0;
    let closed = false;
    clientInternal.setClientFactoryForTests(async () => ({
      command: { command: "node", args: [], source: "managed" },
      isClosed: () => closed,
      request: async (method) => {
        if (method !== "model/list") return {};
        modelRequests += 1;
        if (modelRequests === 1) {
          pageStarted();
          await new Promise<void>((resolve) => {
            releasePage = resolve;
          });
          return { data: [], nextCursor: "next-page" };
        }
        return { data: [], nextCursor: null };
      },
      notify: () => {},
      interruptTurn: async () => {},
      onNotification: () => () => {},
      onServerRequest: () => () => {},
      onJsonRpcMessage: () => () => {},
      close: async () => {
        closed = true;
      },
    }));
    try {
      const adapter = createCodexAppServerModelDiscoveryAdapter({ codexHome });
      const pending = adapter.discover({ reason: "test", signal: controller.signal });
      await started;
      controller.abort();
      const outcome = await Promise.race([
        pending.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      releasePage();
      await pending.catch(() => {});
      expect(outcome).toBe("rejected");
      expect(modelRequests).toBe(1);
      expect(closed).toBe(false);

      await expect(listCodexAppServerModels({ codexHome })).resolves.toEqual([]);
      expect(modelRequests).toBe(2);
    } finally {
      releasePage?.();
      await closePooledCodexAppServerClients();
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  test.each(["succeeds", "fails"] as const)(
    "login reloads pooled auth when the final account read %s",
    async (accountRead) => {
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
              if (accountRead === "fails") throw new Error("Account read failed after login");
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

      const login = loginCodexAppServerChatGpt({
        codexHome,
        openUrl: async () => true,
      });

      if (accountRead === "fails") {
        await expect(login).rejects.toThrow("Account read failed after login");
      } else {
        expect((await login).account?.email).toBe("fresh@example.com");
      }
      expect(runtimeClient.isClosed()).toBe(true);
      expect(closeCount).toBe(2);
      expect(clients).toHaveLength(2);
    },
  );

  test.each(["success", "exit", "timeout"] as const)(
    "login settles on %s while the browser opener remains pending",
    async (completion) => {
      const codexHome = await fs.mkdtemp(
        path.join(os.tmpdir(), "cowork-auth-login-fast-callback-"),
      );
      const notificationListeners = new Set<
        Parameters<CodexAppServerClient["onNotification"]>[0]
      >();
      const closeListeners = new Set<
        (code: number | null, signal: NodeJS.Signals | null) => void
      >();
      let accountReadCount = 0;

      clientInternal.setClientFactoryForTests(async () => {
        const client: CodexAppServerClient = {
          command: { command: "node", args: [], source: "system" },
          isClosed: () => false,
          request: async (method) => {
            if (method === "initialize") return {};
            if (method === "account/login/start") {
              return { authUrl: "https://example.test/login", loginId: "login-fast" };
            }
            if (method === "account/read") {
              accountReadCount += 1;
              return {
                account: { type: "chatgpt", email: "fast@example.com", planType: "Pro" },
                requiresOpenaiAuth: false,
              };
            }
            return {};
          },
          notify: () => {},
          interruptTurn: async () => {},
          onNotification: (listener) => {
            notificationListeners.add(listener);
            return () => {
              notificationListeners.delete(listener);
            };
          },
          onServerRequest: () => () => {},
          onJsonRpcMessage: () => () => {},
          onClose: (listener) => {
            closeListeners.add(listener);
            return () => {
              closeListeners.delete(listener);
            };
          },
          close: async () => {},
        };
        return client;
      });

      type LoginOutcome =
        | {
            kind: "login";
            account: Awaited<ReturnType<typeof loginCodexAppServerChatGpt>>["account"];
          }
        | { kind: "error"; error: unknown };
      const schedule = spyOn(globalThis, "setTimeout");
      const opening = Promise.withResolvers<void>();
      const opener = Promise.withResolvers<boolean>();
      let outcome: LoginOutcome | undefined;
      const loginPromise = loginCodexAppServerChatGpt({
        codexHome,
        openUrl: async (url) => {
          expect(url).toBe("https://example.test/login");
          if (completion === "success") {
            for (const listener of notificationListeners) {
              listener({
                method: "account/login/completed",
                params: { loginId: "login-fast", success: true },
              });
            }
          } else if (completion === "exit") {
            for (const listener of closeListeners) listener(1, null);
          } else {
            const timer = schedule.mock.calls.find(([, delay]) => delay === 10 * 60 * 1000);
            if (!timer || typeof timer[0] !== "function") throw new Error("Missing login deadline");
            timer[0]();
          }
          opening.resolve();
          return await opener.promise;
        },
      }).then(
        (login) => {
          outcome = { kind: "login", account: login.account };
        },
        (error: unknown) => {
          outcome = { kind: "error", error };
        },
      );
      try {
        await opening.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(outcome).toEqual(
          completion === "success"
            ? {
                kind: "login",
                account: { type: "chatgpt", email: "fast@example.com", planType: "Pro" },
              }
            : {
                kind: "error",
                error: expect.objectContaining({
                  message:
                    completion === "exit"
                      ? "Codex client exited during authentication"
                      : "Timed out waiting for Codex app-server login.",
                }),
              },
        );
        expect(accountReadCount).toBe(completion === "success" ? 1 : 0);
        expect(notificationListeners.size).toBe(0);
      } finally {
        opener.resolve(true);
        await loginPromise;
        schedule.mockRestore();
      }
    },
  );

  test("login cancels pending handoff when the browser opener cannot launch", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-auth-login-open-fail-"));
    const notificationListeners = new Set<Parameters<CodexAppServerClient["onNotification"]>[0]>();
    const closeListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
    let closeListenerCountDuringOpen = 0;
    let notificationListenersDuringOpen: Parameters<CodexAppServerClient["onNotification"]>[0][] =
      [];
    let accountReadCount = 0;

    clientInternal.setClientFactoryForTests(async () => {
      let closed = false;
      const client: CodexAppServerClient = {
        command: { command: "node", args: [], source: "system" },
        isClosed: () => closed,
        request: async (method) => {
          if (method === "initialize") return {};
          if (method === "account/login/start") {
            return { authUrl: "https://example.test/login", loginId: "login-cancelled" };
          }
          if (method === "account/read") {
            accountReadCount += 1;
            return {
              account: { type: "chatgpt", email: "stale@example.com", planType: "Pro" },
              requiresOpenaiAuth: false,
            };
          }
          return {};
        },
        notify: () => {},
        interruptTurn: async () => {},
        onNotification: (listener) => {
          notificationListeners.add(listener);
          return () => {
            notificationListeners.delete(listener);
          };
        },
        onServerRequest: () => () => {},
        onJsonRpcMessage: () => () => {},
        onClose: (listener) => {
          closeListeners.add(listener);
          return () => {
            closeListeners.delete(listener);
          };
        },
        close: async () => {
          closed = true;
        },
      };
      return client;
    });

    const runtimeClient = await getPooledCodexAppServerClient({ cwd: "/tmp/workspace", codexHome });
    await expect(
      loginCodexAppServerChatGpt({
        codexHome,
        openUrl: async (url) => {
          expect(url).toBe("https://example.test/login");
          closeListenerCountDuringOpen = closeListeners.size;
          notificationListenersDuringOpen = [...notificationListeners];
          return false;
        },
      }),
    ).rejects.toThrow("Unable to open the Codex app-server ChatGPT login URL");

    expect(closeListenerCountDuringOpen).toBeGreaterThan(closeListeners.size);
    expect(notificationListenersDuringOpen).toHaveLength(1);
    expect(notificationListeners.size).toBe(0);
    for (const listener of notificationListenersDuringOpen) {
      listener({
        method: "account/login/completed",
        params: { loginId: "login-cancelled", success: true },
      });
    }
    expect(accountReadCount).toBe(0);
    expect(runtimeClient.isClosed()).toBe(false);
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
