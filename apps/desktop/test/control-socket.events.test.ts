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

  test("session config without model overrides clears stale models and preserves other snapshots", async () => {
    const workspaceId = "ws-memory-clear";
    const otherWorkspaceId = "ws-memory-clear-other";
    const emptyWorkspaceId = "ws-memory-clear-empty";
    const { state, get, set } = createState(workspaceId);
    state.workspaces.push({
      ...state.workspaces[0],
      id: otherWorkspaceId,
      path: "/tmp/other-workspace",
      defaultAdvancedMemory: true,
      defaultMemoryGenerationModel: "openai:old-memory-model",
      defaultSkillImprovementEnabled: true,
      defaultSkillImprovementModel: "openai:old-skill-model",
      defaultSkillImprovementScope: "user",
      defaultSkillImprovementExcludedSkills: ["keep-skill"],
    });
    const preservedConfig = {
      advancedMemory: true,
      skillImprovementEnabled: true,
      skillImprovementScope: "user",
      skillImprovementExcludedSkills: ["keep-skill"],
      preferredChildModel: "existing-child-model",
    };
    state.workspaceRuntimeById[otherWorkspaceId] = {
      ...defaultWorkspaceRuntime(),
      controlSessionConfig: {
        ...preservedConfig,
        memoryGenerationModel: "openai:old-memory-model",
        skillImprovementModel: "openai:old-skill-model",
      },
    };
    state.workspaceRuntimeById[emptyWorkspaceId] = defaultWorkspaceRuntime();
    const config = { yolo: false };
    installFakeSocket(workspaceId, async () => ({
      event: { type: "session_config", sessionId: "memory-control", config },
    }));
    const helpers = createControlSocketHelpers(deps);

    expect(
      await helpers.requestJsonRpcControlEvent(
        get as never,
        set as never,
        workspaceId,
        "cowork/session/state/read",
        { cwd: "/tmp/workspace" },
      ),
    ).toBe(true);

    expect(state.workspaceRuntimeById[otherWorkspaceId].controlSessionConfig).toEqual(
      preservedConfig,
    );
    expect(state.workspaceRuntimeById[emptyWorkspaceId].controlSessionConfig).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].controlSessionConfig).toBe(config);
    expect(state.workspaces[1]).toMatchObject({
      defaultAdvancedMemory: true,
      defaultMemoryGenerationModel: undefined,
      defaultSkillImprovementEnabled: true,
      defaultSkillImprovementModel: undefined,
      defaultSkillImprovementScope: "user",
      defaultSkillImprovementExcludedSkills: ["keep-skill"],
    });
  });
});
