import { afterEach, describe, expect, test } from "bun:test";

import { createControlSocketHelpers } from "../apps/desktop/src/app/store.helpers/controlSocket";
import { __internal as jsonRpcSocketInternal } from "../apps/desktop/src/app/store.helpers/jsonRpcSocket";
import { JSONRPC_SOCKET_OVERRIDE_KEY } from "../apps/desktop/src/app/store.helpers/jsonRpcSocketOverride";
import {
  defaultWorkspaceRuntime,
  RUNTIME,
} from "../apps/desktop/src/app/store.helpers/runtimeState";

afterEach(() => {
  jsonRpcSocketInternal.reset();
  RUNTIME.jsonRpcSockets.clear();
  RUNTIME.workspaceJsonRpcSocketGenerations.clear();
  delete (globalThis as Record<string, unknown>)[JSONRPC_SOCKET_OVERRIDE_KEY];
});

describe("desktop control socket config_updated defaults sync", () => {
  test("mirrors missing workspace defaults from control config", async () => {
    const workspaceId = "workspace-1";
    const workspacePath = "/tmp/workspace-1";
    const persistCalls: unknown[] = [];

    class FakeJsonRpcSocket {
      readyPromise = Promise.resolve();

      constructor(private readonly options: any) {}

      connect() {
        this.options.onOpen?.();
      }

      close() {
        this.options.onClose?.();
      }

      async request(method: string) {
        expect(method).toBe("cowork/session/state/read");
        return {
          events: [
            {
              type: "config_updated",
              sessionId: "session-1",
              config: {
                provider: "openai",
                model: "gpt-5.4",
                workingDirectory: workspacePath,
              },
            },
          ],
        };
      }

      respond() {
        return true;
      }
    }

    (globalThis as Record<string, unknown>)[JSONRPC_SOCKET_OVERRIDE_KEY] = FakeJsonRpcSocket;

    let state: any = {
      notifications: [],
      threads: [],
      threadRuntimeById: {},
      workspaces: [
        {
          id: workspaceId,
          path: workspacePath,
        },
      ],
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://127.0.0.1:7337/ws",
        },
      },
    };

    const get = () => state;
    const set = (updater: (current: any) => any) => {
      state = {
        ...state,
        ...updater(state),
      };
    };

    const helpers = createControlSocketHelpers({
      nowIso: () => new Date().toISOString(),
      makeId: () => crypto.randomUUID(),
      persist: (currentGet) => {
        persistCalls.push(currentGet());
      },
      pushNotification: (notifications) => notifications,
      isProviderName: (value: unknown): value is string => typeof value === "string",
    });

    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/session/state/read",
      { cwd: workspacePath },
    );

    expect(ok).toBe(true);
    expect(state.workspaces).toEqual([
      {
        id: workspaceId,
        path: workspacePath,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      },
    ]);
    expect(state.workspaceRuntimeById[workspaceId].controlConfig).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      workingDirectory: workspacePath,
    });
    expect(persistCalls).toHaveLength(1);
  });
});
