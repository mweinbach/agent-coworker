import { beforeEach, describe, expect, test } from "bun:test";
import type { JsonRpcSocket } from "../src/lib/agentSocket";
import {
  createState,
  createStoreHarness,
  defaultWorkspaceRuntime,
  RUNTIME,
  resetSkillPluginActionRuntime,
  workspaceId,
} from "./skill-plugin-actions.harness";

const marketplaceActionsModule = await import("../src/app/store.actions/marketplaces");
const { createMarketplaceActions } = marketplaceActionsModule;
const { requestJsonRpcControlEvent } = await import("../src/app/store.helpers");

const builtInMarketplace = {
  id: "mweinbach/agent-coworker",
  repo: "mweinbach/agent-coworker",
  ref: "main",
  url: "https://github.com/mweinbach/agent-coworker/tree/main",
  marketplacePath: ".agents/plugins/marketplace.json",
  builtIn: true,
  displayName: "Cowork Marketplace",
  pluginCount: 3,
  skillCount: 12,
};

const customMarketplace = {
  id: "acme/cowork-extras",
  repo: "acme/cowork-extras",
  ref: "main",
  url: "https://github.com/acme/cowork-extras/tree/main",
  marketplacePath: ".agents/plugins/marketplace.json",
  builtIn: false,
  displayName: "Acme Extras",
  pluginCount: 1,
  skillCount: 0,
  addedAt: "2026-07-01T00:00:00.000Z",
};

describe("marketplace store actions", () => {
  beforeEach(() => {
    resetSkillPluginActionRuntime();
  });

  test("refreshMarketplaces surfaces an error when the server is unavailable", async () => {
    const state = createState();
    const { get, set } = createStoreHarness(state);

    await createMarketplaceActions(set, get).refreshMarketplaces();

    expect(state.workspaceRuntimeById[workspaceId].marketplacesLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].marketplacesError).toBe(
      "Unable to load marketplaces.",
    );
    expect(state.notifications).toHaveLength(1);
  });

  test("refreshMarketplaces requests the list with the anchor cwd and applies the event", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      marketplacesError: "stale marketplaces error",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let loadingDuringRequest: boolean | null = null;
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        loadingDuringRequest = state.workspaceRuntimeById[workspaceId].marketplacesLoading;
        return {
          event: {
            type: "marketplaces_list",
            sessionId: "jsonrpc-control",
            marketplaces: [builtInMarketplace, customMarketplace],
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createMarketplaceActions(set, get).refreshMarketplaces();

    expect(requests).toEqual([
      {
        method: "cowork/marketplaces/read",
        params: { cwd: "/tmp/workspace" },
      },
    ]);
    expect(loadingDuringRequest).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].marketplaces).toEqual([
      builtInMarketplace,
      customMarketplace,
    ]);
    expect(state.workspaceRuntimeById[workspaceId].marketplacesLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].marketplacesError).toBeNull();
    expect(state.notifications).toHaveLength(0);
  });

  test("refreshMarketplaces targets an explicitly provided workspace", async () => {
    const state = createState();
    const otherWorkspaceId = "ws-marketplaces-other";
    state.selectedWorkspaceId = workspaceId;
    state.workspaces = [
      { id: workspaceId, path: "/tmp/workspace" },
      { id: otherWorkspaceId, path: "/tmp/other" },
    ];
    state.workspaceRuntimeById[otherWorkspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://other",
      controlSessionId: "jsonrpc-control",
    };
    const { get, set } = createStoreHarness(state);

    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    RUNTIME.jsonRpcSockets.set(otherWorkspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        return {
          event: {
            type: "marketplaces_list",
            sessionId: "jsonrpc-control",
            marketplaces: [builtInMarketplace],
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createMarketplaceActions(set, get).refreshMarketplaces(otherWorkspaceId);

    expect(requests).toEqual([
      {
        method: "cowork/marketplaces/read",
        params: { cwd: "/tmp/other" },
      },
    ]);
    expect(state.workspaceRuntimeById[otherWorkspaceId].marketplaces).toEqual([builtInMarketplace]);
  });

  test("selectMarketplace requests the detail and applies the marketplace_detail event", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      marketplaceDetailError: "stale detail error",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const detail = {
      source: customMarketplace,
      plugins: [
        {
          name: "acme-toolkit",
          displayName: "Acme Toolkit",
          category: "Design",
          installed: false,
          installSource: "https://github.com/acme/cowork-extras/tree/main/plugins/acme-toolkit",
          skills: [],
          mcpServers: [],
        },
      ],
      skills: [],
      connectors: [],
    };

    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let loadingDuringRequest: boolean | null = null;
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        loadingDuringRequest = state.workspaceRuntimeById[workspaceId].marketplaceDetailLoading;
        return {
          event: {
            type: "marketplace_detail",
            sessionId: "jsonrpc-control",
            detail,
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createMarketplaceActions(set, get).selectMarketplace("acme/cowork-extras");

    expect(requests).toEqual([
      {
        method: "cowork/marketplaces/detail",
        params: { cwd: "/tmp/workspace", id: "acme/cowork-extras" },
      },
    ]);
    expect(loadingDuringRequest).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].selectedMarketplaceId).toBe(
      "acme/cowork-extras",
    );
    expect(state.workspaceRuntimeById[workspaceId].selectedMarketplaceDetail).toEqual(detail);
    expect(state.workspaceRuntimeById[workspaceId].marketplaceDetailLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].marketplaceDetailError).toBeNull();
  });

  test("selectMarketplace(null) clears the selection and detail state", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      selectedMarketplaceId: "acme/cowork-extras",
      selectedMarketplaceDetail: {
        source: customMarketplace,
        plugins: [],
        skills: [],
        connectors: [],
      },
      marketplaceDetailError: "stale detail error",
    };
    const { get, set } = createStoreHarness(state);

    await createMarketplaceActions(set, get).selectMarketplace(null);

    expect(state.workspaceRuntimeById[workspaceId].selectedMarketplaceId).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].selectedMarketplaceDetail).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].marketplaceDetailError).toBeNull();
  });

  test("marketplace_detail events for a no-longer-selected marketplace are ignored", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      selectedMarketplaceId: "acme/other-marketplace",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => ({
        event: {
          type: "marketplace_detail",
          sessionId: "jsonrpc-control",
          detail: {
            source: customMarketplace,
            plugins: [],
            skills: [],
            connectors: [],
          },
        },
      }),
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createMarketplaceActions(set, get).readMarketplaceDetail("acme/cowork-extras");

    expect(state.workspaceRuntimeById[workspaceId].selectedMarketplaceDetail).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].selectedMarketplaceId).toBe(
      "acme/other-marketplace",
    );
  });

  test("readMarketplaceDetail surfaces the server error inline", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      selectedMarketplaceId: "acme/cowork-extras",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => {
        throw new Error('Failed to read marketplace: Marketplace "acme/gone" is not configured.');
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createMarketplaceActions(set, get).readMarketplaceDetail("acme/gone");

    expect(state.workspaceRuntimeById[workspaceId].marketplaceDetailLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].marketplaceDetailError).toBe(
      'Failed to read marketplace: Marketplace "acme/gone" is not configured.',
    );
    expect(state.workspaceRuntimeById[workspaceId].selectedMarketplaceDetail).toBeNull();
  });

  test("addMarketplace sends the source input and clears its pending key on success", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      marketplaceMutationError: "stale marketplace error",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let pendingDuringRequest: boolean | null = null;
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        pendingDuringRequest =
          state.workspaceRuntimeById[workspaceId].marketplaceMutationPendingKeys[
            "marketplace:add"
          ] === true;
        return {
          event: {
            type: "marketplaces_list",
            sessionId: "jsonrpc-control",
            marketplaces: [builtInMarketplace, customMarketplace],
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createMarketplaceActions(set, get).addMarketplace("acme/cowork-extras");

    expect(requests).toEqual([
      {
        method: "cowork/marketplaces/add",
        params: { cwd: "/tmp/workspace", sourceInput: "acme/cowork-extras" },
      },
    ]);
    expect(pendingDuringRequest).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].marketplaces).toEqual([
      builtInMarketplace,
      customMarketplace,
    ]);
    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationPendingKeys).toEqual({});
    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationError).toBeNull();
  });

  test("addMarketplace surfaces the server error message and rethrows", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => {
        throw new Error('Failed to add marketplace: Unrecognized marketplace source "not a repo".');
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await expect(createMarketplaceActions(set, get).addMarketplace("not a repo")).rejects.toThrow(
      'Failed to add marketplace: Unrecognized marketplace source "not a repo".',
    );

    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationError).toBe(
      'Failed to add marketplace: Unrecognized marketplace source "not a repo".',
    );
    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationPendingKeys).toEqual({});
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationError).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBeNull();
    expect(state.notifications.at(-1)?.detail).toBe(
      'Failed to add marketplace: Unrecognized marketplace source "not a repo".',
    );
  });

  test("removeMarketplace sends the marketplace id and clears its pending key on success", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let pendingDuringRequest: boolean | null = null;
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        pendingDuringRequest =
          state.workspaceRuntimeById[workspaceId].marketplaceMutationPendingKeys[
            "marketplace:remove:acme/cowork-extras"
          ] === true;
        return {
          event: {
            type: "marketplaces_list",
            sessionId: "jsonrpc-control",
            marketplaces: [builtInMarketplace],
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createMarketplaceActions(set, get).removeMarketplace("acme/cowork-extras");

    expect(requests).toEqual([
      {
        method: "cowork/marketplaces/remove",
        params: { cwd: "/tmp/workspace", id: "acme/cowork-extras" },
      },
    ]);
    expect(pendingDuringRequest).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].marketplaces).toEqual([builtInMarketplace]);
    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationPendingKeys).toEqual({});
  });

  test("removeMarketplace surfaces the server refusal without throwing", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => {
        throw new Error(
          "Failed to remove marketplace: The built-in marketplace cannot be removed.",
        );
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createMarketplaceActions(set, get).removeMarketplace("mweinbach/agent-coworker");

    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationError).toBe(
      "Failed to remove marketplace: The built-in marketplace cannot be removed.",
    );
    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationPendingKeys).toEqual({});
  });

  test("dismissMarketplaceMutationError clears the marketplace error only", () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      marketplaceMutationError: "Failed to remove marketplace: not configured.",
      pluginMutationError: "plugin error",
    };
    const { get, set } = createStoreHarness(state);

    createMarketplaceActions(set, get).dismissMarketplaceMutationError(workspaceId);

    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationError).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationError).toBe("plugin error");
  });

  test("skills_catalog clearedMutationPendingKeys clears marketplace pending state", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      marketplaceMutationPendingKeys: { "marketplace:add": true, other: true },
      marketplaceMutationError: "stale marketplace error",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => ({
        event: {
          type: "skills_catalog",
          sessionId: "jsonrpc-control",
          catalog: {
            installations: [],
            sources: [],
            stats: { totalInstallations: 0, enabledInstallations: 0 },
          },
          mutationBlocked: false,
          clearedMutationPendingKeys: ["marketplace:add"],
        },
      }),
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    const ok = await requestJsonRpcControlEvent(
      get,
      set,
      workspaceId,
      "cowork/skills/catalog/read",
      { cwd: "/tmp/workspace" },
    );

    expect(ok).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationPendingKeys).toEqual({
      other: true,
    });
    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationError).toBeNull();
  });

  test("plugins_catalog clearedMutationPendingKeys clears marketplace pending state", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      marketplaceMutationPendingKeys: { "marketplace:remove:acme/cowork-extras": true },
      marketplaceMutationError: "stale marketplace error",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => ({
        event: {
          type: "plugins_catalog",
          sessionId: "jsonrpc-control",
          catalog: { plugins: [], availablePlugins: [], warnings: [] },
          clearedMutationPendingKeys: ["marketplace:remove:acme/cowork-extras"],
        },
      }),
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    const ok = await requestJsonRpcControlEvent(
      get,
      set,
      workspaceId,
      "cowork/plugins/catalog/read",
      { cwd: "/tmp/workspace" },
    );

    expect(ok).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationPendingKeys).toEqual({});
    expect(state.workspaceRuntimeById[workspaceId].marketplaceMutationError).toBeNull();
  });
});
