import { beforeEach, describe, expect, test } from "bun:test";

import type { JsonRpcSocket } from "../src/lib/agentSocket";
import {
  createState,
  createStoreHarness,
  defaultWorkspaceRuntime,
  RUNTIME,
  resetSkillPluginActionRuntime,
  secondaryWorkspaceId,
  workspaceId,
} from "./skill-plugin-actions.harness";

const skillActionsModule = await import("../src/app/store.actions/skills");
const { createSkillActions } = skillActionsModule;

const failedSkillMutationActions = [
  {
    name: "deleteSkill",
    expectedError: "JSON-RPC workspace socket is unavailable",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.deleteSkill("skill-1"),
  },
  {
    name: "disableSkill",
    expectedError: "JSON-RPC workspace socket is unavailable",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.disableSkill("skill-1"),
  },
  {
    name: "enableSkill",
    expectedError: "JSON-RPC workspace socket is unavailable",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.enableSkill("skill-1"),
  },
  {
    name: "disableSkillInstallation",
    expectedError: "JSON-RPC workspace socket is unavailable",
    invoke: (actions: ReturnType<typeof createSkillActions>) =>
      actions.disableSkillInstallation("inst-1"),
  },
  {
    name: "enableSkillInstallation",
    expectedError: "JSON-RPC workspace socket is unavailable",
    invoke: (actions: ReturnType<typeof createSkillActions>) =>
      actions.enableSkillInstallation("inst-1"),
  },
  {
    name: "deleteSkillInstallation",
    expectedError: "JSON-RPC workspace socket is unavailable",
    invoke: (actions: ReturnType<typeof createSkillActions>) =>
      actions.deleteSkillInstallation("inst-1"),
  },
  {
    name: "copySkillInstallation",
    expectedError: "JSON-RPC workspace socket is unavailable",
    invoke: (actions: ReturnType<typeof createSkillActions>) =>
      actions.copySkillInstallation("inst-1", "project"),
  },
  {
    name: "updateSkillInstallation",
    expectedError: "JSON-RPC workspace socket is unavailable",
    invoke: (actions: ReturnType<typeof createSkillActions>) =>
      actions.updateSkillInstallation("inst-1"),
  },
] as const;

const rootSkillMutationActions = [
  {
    name: "deleteSkill",
    method: "cowork/skills/delete",
    pendingKey: "delete:skill-1",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.deleteSkill("skill-1"),
  },
  {
    name: "disableSkill",
    method: "cowork/skills/disable",
    pendingKey: "disable:skill-1",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.disableSkill("skill-1"),
  },
  {
    name: "enableSkill",
    method: "cowork/skills/enable",
    pendingKey: "enable:skill-1",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.enableSkill("skill-1"),
  },
] as const;

describe("skill store actions", () => {
  beforeEach(() => {
    resetSkillPluginActionRuntime();
  });

  test("refreshSkillsCatalog clears loading when sendControl fails", async () => {
    const state = createState();
    const { get, set } = createStoreHarness(state);

    await createSkillActions(set, get).refreshSkillsCatalog();

    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogError).toBe(
      "Unable to refresh skills catalog.",
    );
    expect(state.notifications).toHaveLength(1);
  });

  test("refreshSkillsCatalog dispatches catalog and list requests in parallel", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://mock";
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const calls: string[] = [];
    let resolveCatalog: ((value: unknown) => void) | null = null;
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: (method: string) => {
        calls.push(method);
        if (method === "cowork/skills/catalog/read") {
          return new Promise((resolve) => {
            resolveCatalog = resolve;
          });
        }
        return Promise.resolve({
          event: {
            type: "skills_list",
            sessionId: "jsonrpc-control",
            skills: [],
          },
        });
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    const refreshPromise = createSkillActions(set, get).refreshSkillsCatalog();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(["cowork/skills/catalog/read", "cowork/skills/list"]);

    resolveCatalog?.({
      event: {
        type: "skills_catalog",
        sessionId: "jsonrpc-control",
        catalog: {
          installations: [],
          sources: [],
          stats: { totalInstallations: 0, enabledInstallations: 0 },
        },
        mutationBlocked: false,
      },
    });
    await refreshPromise;

    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.notifications).toHaveLength(0);
  });

  test("refreshSkillsCatalog waits for workspace startup before requesting skills", async () => {
    const state = createState();
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const calls: string[] = [];
    let resolveStart: (() => void) | null = null;
    const socket = {
      readyPromise: Promise.resolve(),
      request: (method: string) => {
        calls.push(method);
        return Promise.resolve({
          event: {
            type: method === "cowork/skills/catalog/read" ? "skills_catalog" : "skills_list",
            sessionId: "jsonrpc-control",
            ...(method === "cowork/skills/catalog/read"
              ? {
                  catalog: {
                    installations: [],
                    sources: [],
                    stats: { totalInstallations: 0, enabledInstallations: 0 },
                  },
                  mutationBlocked: false,
                }
              : { skills: [] }),
          },
        });
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket;
    RUNTIME.workspaceStartPromises.set(workspaceId, {
      generation: 0,
      promise: new Promise<void>((resolve) => {
        resolveStart = () => {
          state.workspaceRuntimeById[workspaceId].serverUrl = "ws://ready";
          RUNTIME.jsonRpcSockets.set(workspaceId, socket);
          resolve();
        };
      }),
    });

    const refreshPromise = createSkillActions(set, get).refreshSkillsCatalog(workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([]);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(true);

    resolveStart?.();
    await refreshPromise;

    expect(calls).toEqual(["cowork/skills/catalog/read", "cowork/skills/list"]);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.notifications).toHaveLength(0);
  });

  test("refreshSkillsCatalog can target a non-selected workspace", async () => {
    const state = createState();
    state.workspaces = [
      { id: workspaceId, path: "/tmp/management" },
      { id: secondaryWorkspaceId, path: "/tmp/selected" },
    ];
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://management";
    state.workspaceRuntimeById[secondaryWorkspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://selected",
    };
    const { get, set } = createStoreHarness(state);

    const workspaceCalls: Array<{ workspaceId: string; method: string }> = [];
    const makeSocket = (socketWorkspaceId: string) =>
      ({
        readyPromise: Promise.resolve(),
        request: (method: string) => {
          workspaceCalls.push({ workspaceId: socketWorkspaceId, method });
          return Promise.resolve({
            event: {
              type: method === "cowork/skills/catalog/read" ? "skills_catalog" : "skills_list",
              sessionId: "jsonrpc-control",
              ...(method === "cowork/skills/catalog/read"
                ? {
                    catalog: {
                      installations: [],
                      sources: [],
                      stats: { totalInstallations: 0, enabledInstallations: 0 },
                    },
                    mutationBlocked: false,
                  }
                : { skills: [] }),
            },
          });
        },
        respond: () => true,
        close: () => {},
      }) as unknown as JsonRpcSocket;
    RUNTIME.jsonRpcSockets.set(workspaceId, makeSocket(workspaceId));
    RUNTIME.jsonRpcSockets.set(secondaryWorkspaceId, makeSocket(secondaryWorkspaceId));

    await createSkillActions(set, get).refreshSkillsCatalog(secondaryWorkspaceId);

    expect(workspaceCalls).toEqual([
      { workspaceId: secondaryWorkspaceId, method: "cowork/skills/catalog/read" },
      { workspaceId: secondaryWorkspaceId, method: "cowork/skills/list" },
    ]);
    expect(state.workspaceRuntimeById[secondaryWorkspaceId].skillCatalogLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
  });

  test("previewSkillInstall removes only its pending key when sendControl fails", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys = { other: true };
    const { get, set } = createStoreHarness(state);

    await createSkillActions(set, get).previewSkillInstall("owner/repo", "project");

    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({
      other: true,
    });
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBe(
      "JSON-RPC workspace socket is unavailable",
    );
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBeNull();
    expect(state.notifications).toHaveLength(1);
  });

  test("installSkills removes only its pending key when sendControl fails", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys = { other: true };
    const { get, set } = createStoreHarness(state);

    await expect(
      createSkillActions(set, get).installSkills("owner/repo", "global"),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: "JSON-RPC workspace socket is unavailable" },
    });

    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({
      other: true,
    });
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBe(
      "JSON-RPC workspace socket is unavailable",
    );
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBeNull();
    expect(state.notifications).toHaveLength(1);
  });

  test("installSkills registers its waiter before sending the control message", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].controlSessionId = "control-session";
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://mock";
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    let waiterPendingKey: string | null = null;
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => {
        waiterPendingKey = RUNTIME.skillInstallWaiters.get(workspaceId)?.pendingKey ?? null;
        throw new Error("request failed");
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await expect(
      createSkillActions(set, get).installSkills("owner/repo", "global"),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: "request failed" },
    });

    expect(waiterPendingKey).toBe("install:global");
    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
  });

  test("selectSkill preserves loaded content after the JSON-RPC read succeeds", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      skillCatalogLoading: false,
      skillCatalogError: null,
      skillMutationPendingKeys: {},
      skillMutationError: null,
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      skills: [
        {
          name: "example-skill",
          description: "Example skill",
          source: "workspace",
          enabled: true,
          effective: true,
          interface: null,
          metadata: null,
          path: "/tmp/workspace/skills/example-skill/SKILL.md",
        },
      ],
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => ({
        event: {
          type: "skill_content",
          sessionId: "jsonrpc-control",
          skill: state.workspaceRuntimeById[workspaceId].skills[0],
          content: "# Example skill",
        },
      }),
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createSkillActions(set, get).selectSkill("example-skill");

    expect(state.workspaceRuntimeById[workspaceId].selectedSkillName).toBe("example-skill");
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillContent).toBe("# Example skill");
  });

  test("installSkills refreshes other open workspaces after a global install succeeds", async () => {
    const state = createState();
    state.workspaceRuntimeById = {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://source",
        controlSessionId: "jsonrpc-control",
      },
      [secondaryWorkspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://secondary",
        controlSessionId: "jsonrpc-control",
      },
    };
    state.workspaces = [
      { id: workspaceId, path: "/tmp/workspace" },
      { id: secondaryWorkspaceId, path: "/tmp/secondary" },
    ];
    const { get, set } = createStoreHarness(state);

    const sourceCalls: string[] = [];
    const secondaryCalls: string[] = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string) => {
        sourceCalls.push(method);
        expect(method).toBe("cowork/skills/install");
        return {
          event: {
            type: "skills_catalog",
            sessionId: "jsonrpc-control",
            catalog: {
              installations: [],
              sources: [],
              stats: { totalInstallations: 0, enabledInstallations: 0 },
            },
            mutationBlocked: false,
            clearedMutationPendingKeys: ["install:global"],
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);
    RUNTIME.jsonRpcSockets.set(secondaryWorkspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string) => {
        secondaryCalls.push(method);
        if (method === "cowork/plugins/catalog/read") {
          return {
            event: {
              type: "plugins_catalog",
              sessionId: "jsonrpc-control",
              catalog: { plugins: [], availablePlugins: [], warnings: [] },
            },
          };
        }
        if (method === "cowork/skills/catalog/read") {
          return {
            event: {
              type: "skills_catalog",
              sessionId: "jsonrpc-control",
              catalog: {
                installations: [],
                sources: [],
                stats: { totalInstallations: 0, enabledInstallations: 0 },
              },
              mutationBlocked: false,
            },
          };
        }
        if (method === "cowork/skills/list") {
          return { event: { type: "skills_list", sessionId: "jsonrpc-control", skills: [] } };
        }
        if (method === "cowork/mcp/servers/read") {
          return {
            event: {
              type: "mcp_servers",
              sessionId: "jsonrpc-control",
              servers: [],
              legacy: [],
              files: [],
              warnings: [],
            },
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createSkillActions(set, get).installSkills("owner/repo", "global");

    expect(sourceCalls).toEqual(["cowork/skills/install"]);
    expect(secondaryCalls.sort()).toEqual([
      "cowork/mcp/servers/read",
      "cowork/plugins/catalog/read",
      "cowork/skills/catalog/read",
      "cowork/skills/list",
    ]);
  });

  test("selectSkillInstallation enters loading state before the request and preserves loaded detail after success", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      skillCatalogLoading: false,
      skillCatalogError: null,
      skillMutationPendingKeys: {},
      skillMutationError: null,
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const installation = {
      installationId: "inst-1",
      name: "example-skill",
      description: "Example skill",
      scope: "global",
      enabled: true,
      writable: false,
      managed: false,
      effective: true,
      state: "effective",
      rootDir: "/tmp/workspace/skills/example-skill",
      skillPath: "/tmp/workspace/skills/example-skill/SKILL.md",
      path: "/tmp/workspace/skills/example-skill/SKILL.md",
      triggers: [],
      descriptionSource: "unknown",
      diagnostics: [],
    };

    let resolveRequest!: (value: unknown) => void;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => await requestPromise,
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    const selectPromise = createSkillActions(set, get).selectSkillInstallation("inst-1");

    expect(state.workspaceRuntimeById[workspaceId].selectedSkillInstallationId).toBe("inst-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillInstallation).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillContent).toBeNull();

    resolveRequest({
      event: {
        type: "skill_installation",
        sessionId: "jsonrpc-control",
        installation,
        content: "# Example skill",
      },
    });
    await selectPromise;

    expect(state.workspaceRuntimeById[workspaceId].selectedSkillInstallationId).toBe("inst-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillInstallation).toEqual(installation);
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillContent).toBe("# Example skill");
  });

  for (const { name, expectedError, invoke } of failedSkillMutationActions) {
    test(`${name} removes only its pending key when sendControl fails`, async () => {
      const state = createState();
      state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys = { other: true };
      const { get, set } = createStoreHarness(state);

      const result = await invoke(createSkillActions(set, get));

      expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({
        other: true,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { message: expectedError },
      });
      expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBe(expectedError);
      expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBeNull();
      expect(state.notifications).toHaveLength(1);
    });
  }

  for (const { name, method, pendingKey, invoke } of rootSkillMutationActions) {
    test(`${name} registers its pending key before sending`, async () => {
      const state = createState();
      state.workspaceRuntimeById[workspaceId].serverUrl = "ws://mock";
      state.workspaceRuntimeById[workspaceId].controlSessionId = "jsonrpc-control";
      state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
      const { get, set } = createStoreHarness(state);
      let pendingAtRequest = false;

      RUNTIME.jsonRpcSockets.set(workspaceId, {
        readyPromise: Promise.resolve(),
        request: async (receivedMethod: string) => {
          expect(receivedMethod).toBe(method);
          pendingAtRequest =
            state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys[pendingKey] === true;
          throw new Error("request failed");
        },
        respond: () => true,
        close: () => {},
      } as unknown as JsonRpcSocket);

      await invoke(createSkillActions(set, get));

      expect(pendingAtRequest).toBe(true);
      expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({});
    });
  }
});
