import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { StoreGet, StoreSet } from "../src/app/store.helpers";
import type { WorkspaceJsonRpcSocket } from "../src/app/store.helpers/jsonRpcSocket";
import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    startWorkspaceServer: async () => ({ url: "ws://mock" }),
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { __controlSocketInternal, defaultWorkspaceRuntime, RUNTIME } = await import(
  "../src/app/store.helpers"
);
const { createOpenAiNativeConnectorActions } = await import("../src/app/store.actions/connectors");
const { disposeAllJsonRpcSocketState } = await import("../src/app/store.helpers/jsonRpcSocket");

const workspaceId = "ws-1";
const workspacePath = "/tmp/ws-1";

type RecordedRequest = {
  method: string;
  params: unknown;
};

function installConnectorSocket(
  requests: RecordedRequest[],
  handler: (method: string, params: unknown) => Promise<unknown> | unknown,
) {
  RUNTIME.jsonRpcSockets.set(workspaceId, {
    readyPromise: Promise.resolve(),
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      return await handler(method, params);
    },
    respond: () => true,
    close: () => {},
    connect: () => {},
  } as unknown as WorkspaceJsonRpcSocket);
}

function resetConnectorState() {
  __controlSocketInternal.reset();
  disposeAllJsonRpcSocketState();
  RUNTIME.jsonRpcSockets.clear();
  RUNTIME.workspaceJsonRpcSocketGenerations.clear();
  RUNTIME.workspaceStartPromises.clear();
  RUNTIME.workspaceStartGenerations.clear();
  const actions = createOpenAiNativeConnectorActions(
    useAppStore.setState as unknown as StoreSet,
    useAppStore.getState as unknown as StoreGet,
  );
  useAppStore.setState({
    ...actions,
    selectedWorkspaceId: workspaceId,
    workspaces: [
      {
        id: workspaceId,
        name: "Workspace 1",
        path: workspacePath,
        createdAt: "2026-05-07T00:00:00.000Z",
        lastOpenedAt: "2026-05-07T00:00:00.000Z",
        defaultEnableMcp: true,
        yolo: false,
      },
    ],
    workspaceRuntimeById: {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://mock",
      },
    },
    notifications: [],
  });
}

describe("OpenAI native connector actions", () => {
  beforeEach(() => {
    resetConnectorState();
  });

  afterEach(() => {
    __controlSocketInternal.reset();
    disposeAllJsonRpcSocketState();
    RUNTIME.jsonRpcSockets.clear();
  });

  test("requestOpenAiNativeConnectors sends workspace cwd and applies connector events", async () => {
    const requests: RecordedRequest[] = [];
    installConnectorSocket(requests, () => ({
      event: {
        type: "openai_native_connectors",
        sessionId: "control-session",
        connectors: [
          {
            id: "connector_gmail",
            name: "Gmail",
            description: "Search mail",
            isEnabled: true,
          },
        ],
        enabledConnectorIds: ["connector_gmail"],
        codexAppsMcpServerName: "codex_apps",
        authenticated: true,
        message: "Codex authenticated",
      },
    }));

    await useAppStore.getState().requestOpenAiNativeConnectors(workspaceId);

    expect(requests).toEqual([
      {
        method: "cowork/connectors/openai-native/list",
        params: { cwd: workspacePath },
      },
    ]);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.openAiNativeConnectorsLoading).toBe(false);
    expect(runtime?.openAiNativeConnectorsError).toBeNull();
    expect(runtime?.openAiNativeConnectorsAuthenticated).toBe(true);
    expect(runtime?.openAiNativeConnectorsEnabledIds).toEqual(["connector_gmail"]);
    expect(runtime?.openAiNativeConnectorsServerName).toBe("codex_apps");
    expect(runtime?.openAiNativeConnectors).toEqual([
      {
        id: "connector_gmail",
        name: "Gmail",
        description: "Search mail",
        isEnabled: true,
      },
    ]);
  });

  test("refreshOpenAiNativeConnectors clears loading and surfaces connector errors", async () => {
    const requests: RecordedRequest[] = [];
    installConnectorSocket(requests, () => ({
      event: {
        type: "error",
        sessionId: "control-session",
        source: "provider",
        code: "provider_error",
        message: "Codex apps MCP server is unavailable.",
      },
    }));
    useAppStore.setState((state) => ({
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [workspaceId]: {
          ...state.workspaceRuntimeById[workspaceId],
          openAiNativeConnectorsError: "stale error",
        },
      },
    }));

    await useAppStore.getState().refreshOpenAiNativeConnectors(workspaceId);

    expect(requests).toEqual([
      {
        method: "cowork/connectors/openai-native/refresh",
        params: { cwd: workspacePath },
      },
    ]);
    const state = useAppStore.getState();
    const runtime = state.workspaceRuntimeById[workspaceId];
    expect(runtime?.openAiNativeConnectorsLoading).toBe(false);
    expect(runtime?.openAiNativeConnectorsError).toBe("Codex apps MCP server is unavailable.");
    expect(state.notifications.at(-1)).toEqual(
      expect.objectContaining({
        kind: "error",
        title: "OpenAI connectors unavailable",
        detail: "Codex apps MCP server is unavailable.",
      }),
    );
  });

  test("setOpenAiNativeConnectorEnabled sends connector id and reports update failures", async () => {
    const requests: RecordedRequest[] = [];
    installConnectorSocket(requests, () => {
      throw new Error("Unable to write connector config.");
    });

    await useAppStore
      .getState()
      .setOpenAiNativeConnectorEnabled(workspaceId, "connector_gmail", false);

    expect(requests).toEqual([
      {
        method: "cowork/connectors/openai-native/setEnabled",
        params: {
          cwd: workspacePath,
          connectorId: "connector_gmail",
          enabled: false,
        },
      },
    ]);
    expect(useAppStore.getState().notifications).toEqual([
      expect.objectContaining({
        kind: "error",
        title: "Connector setting failed",
        detail: "Unable to write connector config.",
      }),
    ]);
  });
});
