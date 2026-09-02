import { describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "../src/lib/wsProtocol";
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

  test("control errors leave pending state and install settlement to their request owners", async () => {
    const workspaceId = "ws-error";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          skillCatalogLoading: true,
          skillMutationPendingKeys: { "install:global": true },
          pluginMutationPendingKeys: { "plugin:install:user": true },
          memoriesLoading: true,
          workspaceBackupsLoading: true,
          workspaceBackupPendingActionKeys: { create: true },
        },
      },
    });
    installFakeSocket(workspaceId, async () => ({
      event: {
        type: "error",
        sessionId: "jsonrpc-control",
        source: "session",
        code: "internal_error",
        message: "Unable to read MCP servers",
      },
    }));

    const skillWaiter = {
      pendingKey: "install:global",
      resolve: mock(() => {}),
      reject: mock(() => {}),
    };
    const pluginWaiter = {
      pendingKey: "plugin:install:user",
      resolve: mock(() => {}),
      reject: mock(() => {}),
    };
    RUNTIME.skillInstallWaiters.set(workspaceId, skillWaiter);
    RUNTIME.pluginInstallWaiters.set(workspaceId, pluginWaiter);

    const helpers = createControlSocketHelpers(deps);
    const errorDetail: { message?: string } = {};
    const ok = await helpers.requestJsonRpcControlEvent(
      get as never,
      set as never,
      workspaceId,
      "cowork/mcp/servers/read",
      { cwd: "/tmp/workspace" },
      errorDetail,
    );

    expect(ok).toBe(false);
    expect(errorDetail.message).toBe("Unable to read MCP servers");
    expect(RUNTIME.skillInstallWaiters.get(workspaceId)).toBe(skillWaiter);
    expect(RUNTIME.pluginInstallWaiters.get(workspaceId)).toBe(pluginWaiter);
    expect(skillWaiter.reject).not.toHaveBeenCalled();
    expect(pluginWaiter.reject).not.toHaveBeenCalled();
    expect(state.workspaceRuntimeById[workspaceId]).toMatchObject({
      skillCatalogLoading: true,
      skillMutationPendingKeys: { "install:global": true },
      skillMutationError: null,
      pluginMutationPendingKeys: { "plugin:install:user": true },
      pluginMutationError: null,
      memoriesLoading: true,
      workspaceBackupsLoading: true,
      workspaceBackupPendingActionKeys: { create: true },
    });
    expect(state.notifications).toHaveLength(1);
  });

  test("skipping stale event application still reports its explicit failure", async () => {
    const workspaceId = "ws-stale-error";
    const { state, get, set } = createState(workspaceId);
    installFakeSocket(workspaceId, async () => ({
      event: {
        type: "error",
        sessionId: "jsonrpc-control",
        source: "session",
        code: "internal_error",
        message: "The old selection failed",
      },
    }));
    const errorDetail: { message?: string } = {};
    const helpers = createControlSocketHelpers(deps);

    const ok = await helpers.requestJsonRpcControlEvent(
      get as never,
      set as never,
      workspaceId,
      "cowork/skills/read",
      { cwd: "/tmp/workspace", skillName: "old-selection" },
      errorDetail,
      { shouldApplyEvent: () => false },
    );

    expect(ok).toBe(false);
    expect(errorDetail.message).toBe("The old selection failed");
    expect(state.notifications).toHaveLength(0);
  });

  const skillDetailEvents: Array<{ name: string; event: SessionEvent }> = [
    {
      name: "skill content",
      event: {
        type: "skill_content",
        sessionId: "jsonrpc-control",
        skill: {
          name: "old-skill",
          path: "/tmp/workspace/skills/old-skill/SKILL.md",
          source: "project",
          enabled: true,
          triggers: [],
          description: "Old skill",
        },
        content: "Old content",
      },
    },
    {
      name: "skill installation",
      event: {
        type: "skill_installation",
        sessionId: "jsonrpc-control",
        installation: {
          installationId: "old-installation",
          name: "old-skill",
          description: "Old skill",
          scope: "project",
          enabled: true,
          writable: true,
          managed: false,
          effective: true,
          state: "effective",
          rootDir: "/tmp/workspace/skills/old-skill",
          skillPath: "/tmp/workspace/skills/old-skill/SKILL.md",
          path: "/tmp/workspace/skills/old-skill/SKILL.md",
          triggers: [],
          descriptionSource: "frontmatter",
          diagnostics: [],
        },
        content: "Old content",
      },
    },
  ];

  for (const { name, event } of skillDetailEvents) {
    for (const selection of ["new-selection", null]) {
      test(`ignores stale ${name} after ${selection === null ? "closing" : "changing"} selection`, async () => {
        const workspaceId = `ws-stale-${name}-${selection}`;
        const { state, get, set } = createState(workspaceId);
        const runtime = state.workspaceRuntimeById[workspaceId];
        runtime.selectedSkillName = selection;
        runtime.selectedSkillInstallationId = selection;
        runtime.selectedSkillContent = "Current content";
        installFakeSocket(workspaceId, async () => ({ event }));
        const helpers = createControlSocketHelpers(deps);

        await helpers.requestJsonRpcControlEvent(
          get as never,
          set as never,
          workspaceId,
          event.type === "skill_content" ? "cowork/skills/read" : "cowork/skills/installation/read",
          { skillName: "old-skill", installationId: "old-installation" },
        );

        expect(state.workspaceRuntimeById[workspaceId].selectedSkillName).toBe(selection);
        expect(state.workspaceRuntimeById[workspaceId].selectedSkillInstallationId).toBe(selection);
        expect(state.workspaceRuntimeById[workspaceId].selectedSkillContent).toBe(
          "Current content",
        );
      });
    }
  }

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
