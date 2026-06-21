import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";

const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];

class MockJsonRpcSocket {
  readonly readyPromise = Promise.resolve();

  connect() {}

  async request(method: string, params?: unknown) {
    jsonRpcRequests.push({ method, params });
    if (method === "cowork/runtime/libreoffice/check") {
      return {
        status: {
          status: "available",
          checkedAt: "2026-05-21T00:00:00.000Z",
          message:
            "Cowork's managed headless LibreOffice launcher is available; UI and printing modes are blocked.",
          version: "26.2.3.2",
          resolvedPath: "/runtime/dependencies/bin/soffice",
          smoke: {
            ok: true,
            durationMs: 50,
            sizeBytes: 2048,
          },
        },
      };
    }
    return {};
  }

  respond() {
    return true;
  }

  close() {}
}

const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime, disposeAllJsonRpcState } = await import(
  "../src/app/store.helpers"
);
const defaultCheckLibreOfficeRuntime = useAppStore.getState().checkLibreOfficeRuntime;

describe("runtime diagnostics actions", () => {
  beforeEach(() => {
    clearJsonRpcSocketOverride();
    disposeAllJsonRpcState();
    jsonRpcRequests.length = 0;
    useAppStore.setState({
      checkLibreOfficeRuntime: defaultCheckLibreOfficeRuntime,
      workspaces: [],
      selectedWorkspaceId: null,
      workspaceRuntimeById: {},
      notifications: [],
    });
  });

  afterEach(() => {
    clearJsonRpcSocketOverride();
    disposeAllJsonRpcState();
    jsonRpcRequests.length = 0;
    useAppStore.setState({
      checkLibreOfficeRuntime: defaultCheckLibreOfficeRuntime,
      workspaces: [],
      selectedWorkspaceId: null,
      workspaceRuntimeById: {},
      notifications: [],
    });
  });

  test("LibreOffice check sends the JSON-RPC request before control session hydration", async () => {
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    useAppStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace-1",
          createdAt: "2026-05-21T00:00:00.000Z",
          lastOpenedAt: "2026-05-21T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultPreferredChildModel: "gpt-5.2",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          controlSessionId: null,
        },
      },
    });

    const status = await useAppStore.getState().checkLibreOfficeRuntime({ smoke: true });

    expect(status?.status).toBe("available");
    expect(status?.version).toBe("26.2.3.2");
    expect(jsonRpcRequests).toContainEqual({
      method: "cowork/runtime/libreoffice/check",
      params: { cwd: "/tmp/workspace-1", smoke: true },
    });
  });
});
