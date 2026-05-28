import { describe, expect, test } from "bun:test";
import {
  createControlSocketHelpers,
  createState,
  defaultWorkspaceRuntime,
  deps,
  installFakeSocket,
  RUNTIME,
  registerControlSocketLifecycleHooks,
} from "./control-socket.harness";

describe("control socket helpers over JSON-RPC", () => {
  registerControlSocketLifecycleHooks();

  test("requestJsonRpcControlEvent resolves matching skill install waiters", async () => {
    const workspaceId = "ws-skills";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          skillMutationPendingKeys: {
            preview: true,
            "install:project": true,
          },
        },
      },
    });
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/skills/catalog/read");
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
          clearedMutationPendingKeys: ["install:project"],
        },
      };
    });

    const resolved = Promise.withResolvers<void>();
    RUNTIME.skillInstallWaiters.set(workspaceId, {
      pendingKey: "install:project",
      resolve: resolved.resolve,
      reject: resolved.reject,
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/skills/catalog/read",
      {
        cwd: "/tmp/workspace",
      },
    );

    await resolved.promise;
    expect(ok).toBe(true);
    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({
      preview: true,
    });
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
  });

  test("requestJsonRpcControlEvent applies error events and rejects pending skill install waiters", async () => {
    const workspaceId = "ws-error";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          skillCatalogLoading: true,
          skillMutationPendingKeys: { "install:global": true },
        },
      },
    });
    installFakeSocket(workspaceId, async () => ({
      event: {
        type: "error",
        sessionId: "jsonrpc-control",
        source: "session",
        code: "internal_error",
        message: "install failed on disk",
      },
    }));

    const rejected = Promise.withResolvers<void>();
    RUNTIME.skillInstallWaiters.set(workspaceId, {
      pendingKey: "install:global",
      resolve: rejected.resolve,
      reject: rejected.reject,
    });

    const helpers = createControlSocketHelpers(deps);
    await expect(
      Promise.all([
        helpers.requestJsonRpcControlEvent(
          get as any,
          set as any,
          workspaceId,
          "cowork/skills/install",
          {
            cwd: "/tmp/workspace",
            sourceInput: "foo",
            targetScope: "global",
          },
        ),
        rejected.promise,
      ]),
    ).rejects.toThrow("install failed on disk");

    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({});
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBe(
      "install failed on disk",
    );
    expect(state.notifications).toHaveLength(1);
  });
});
