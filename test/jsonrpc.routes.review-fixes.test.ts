import { describe, expect, test } from "bun:test";

import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { createAgentRouteHandlers } from "../src/server/jsonrpc/routes/agents";
import { createMcpRouteHandlers } from "../src/server/jsonrpc/routes/mcp";
import { createMemoryRouteHandlers } from "../src/server/jsonrpc/routes/memory";
import { createProviderRouteHandlers } from "../src/server/jsonrpc/routes/provider";
import { createSessionRouteHandlers } from "../src/server/jsonrpc/routes/session";
import { createSkillsRouteHandlers } from "../src/server/jsonrpc/routes/skills";
import { createWorkspaceBackupRouteHandlers } from "../src/server/jsonrpc/routes/workspaceBackups";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import type { ServerEvent } from "../src/server/protocol";

type RouteHarness = ReturnType<typeof createRouteHarness>;

function createRouteHarness(
  session: Record<string, any>,
  emitted: ServerEvent[] = [],
  opts?: {
    threadId?: string;
    threadSession?: Record<string, any>;
  },
) {
  const results: Array<{ id: string | number | null; result: unknown }> = [];
  const errors: Array<{ id: string | number | null; error: { code: number; message: string } }> = [];
  const binding = { session } as any;
  const threadId = opts?.threadId ?? "thread-1";
  const threadBinding = opts?.threadSession ? { session: opts.threadSession } as any : null;

  const context = {
    getConfig: () => ({ workingDirectory: "C:/workspace" }),
    threads: {
      create: () => {
        throw new Error("unused");
      },
      load: (candidateThreadId: string) => candidateThreadId === threadId ? threadBinding : null,
      getLive: (candidateThreadId: string) => candidateThreadId === threadId ? threadBinding ?? undefined : undefined,
      getPersisted: () => null,
      listPersisted: () => [],
      listLiveRoot: () => [],
      subscribe: () => threadBinding,
      unsubscribe: () => "notSubscribed" as const,
      readSnapshot: () => null,
    },
    journal: {} as any,
    workspaceControl: {
      getOrCreateBinding: () => binding,
      withSession: async (_cwd: string, runner: (binding: any, activeSession: any) => Promise<unknown>) =>
        await runner(binding, session),
    },
    events: {
      capture: async (
        _binding: any,
        action: () => Promise<void> | void,
        predicate: (event: ServerEvent) => boolean,
      ) => {
        await action();
        const match = emitted.find((event) => predicate(event));
        if (!match) {
          throw new Error("No matching event captured");
        }
        return match;
      },
      captureMutationOutcome: async (
        _binding: any,
        action: () => Promise<void> | void,
        predicate: (event: ServerEvent) => boolean,
      ) => {
        await action();
        return emitted.find((event) => predicate(event)) ?? null;
      },
    },
    jsonrpc: {
      send: () => {},
      sendResult: (_ws: any, id: string | number | null, result: unknown) => {
        results.push({ id, result });
      },
      sendError: (_ws: any, id: string | number | null, error: { code: number; message: string }) => {
        errors.push({ id, error });
      },
    },
    utils: {
      requireWorkspacePath: (params: Record<string, unknown>) => String(params.cwd ?? "C:/workspace"),
      extractTextInput: () => "",
      buildThreadFromSession: () => {
        throw new Error("unused");
      },
      buildThreadFromRecord: () => {
        throw new Error("unused");
      },
      shouldIncludeThreadSummary: () => true,
      buildControlSessionStateEvents: () => [],
      isSessionError: (event: ServerEvent): event is Extract<ServerEvent, { type: "error" }> =>
        event.type === "error",
    },
  } satisfies Partial<JsonRpcRouteContext>;

  return {
    context: context as JsonRpcRouteContext,
    emitted,
    results,
    errors,
    async invoke(handlers: JsonRpcRequestHandlerMap, method: string, params: Record<string, unknown>) {
      await handlers[method]({} as any, {
        id: 1,
        method,
        params,
      } as any);
      return {
        result: results.at(-1)?.result,
        error: errors.at(-1)?.error,
      };
    },
  };
}

function sessionError(
  message: string,
  source: Extract<ServerEvent, { type: "error" }>["source"] = "session",
): Extract<ServerEvent, { type: "error" }> {
  return {
    type: "error",
    sessionId: "session-1",
    source,
    code: "validation_failed",
    message,
  };
}

describe("JSON-RPC extracted route review fixes", () => {
  test("provider auth authorize returns a session error instead of a timeout result", async () => {
    const harness = createRouteHarness({
      authorizeProviderAuth: async () => {
        harness.emitted.push(sessionError('Unsupported auth method "missing_method" for google.', "provider"));
      },
    });

    const handlers = createProviderRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/provider/auth/authorize", {
      cwd: "C:/workspace",
      provider: "google",
      methodId: "missing_method",
    });

    expect(response.error?.message).toContain('Unsupported auth method "missing_method"');
    expect(response.result).toBeUndefined();
  });

  test("session model set returns the current config when the mutation is a no-op", async () => {
    const threadSession = {
      id: "thread-1",
      setModel: async () => {},
      getPublicConfig: () => ({
        provider: "google",
        model: "gemini-3-flash-preview",
      }),
    };
    const harness = createRouteHarness({}, [], { threadSession });

    const handlers = createSessionRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/session/model/set", {
      threadId: "thread-1",
      provider: "google",
      model: "gemini-3-flash-preview",
    });

    expect((response.result as any).event).toMatchObject({
      type: "config_updated",
      sessionId: "thread-1",
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
      },
    });
  });

  test("session config set returns the current config event when the mutation is a no-op", async () => {
    const currentConfigEvent = {
      type: "session_config",
      sessionId: "thread-1",
      config: {
        defaultBackupsEnabled: true,
      },
    } as const;
    const threadSession = {
      id: "thread-1",
      setConfig: async () => {},
      getSessionConfigEvent: () => currentConfigEvent,
    };
    const harness = createRouteHarness({}, [], { threadSession });

    const handlers = createSessionRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/session/config/set", {
      threadId: "thread-1",
      config: {},
    });

    expect((response.result as any).event).toEqual(currentConfigEvent);
  });

  test("session harness context set rejects malformed context as invalidParams", async () => {
    const threadSession = {
      id: "thread-1",
      setHarnessContext: async () => {
        throw new Error("setHarnessContext should not run for invalid payload");
      },
    };
    const harness = createRouteHarness({}, [], { threadSession });
    const handlers = createSessionRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/session/harnessContext/set", {
      threadId: "thread-1",
      context: {},
    });

    expect(response.error?.code).toBe(JSONRPC_ERROR_CODES.invalidParams);
    expect(response.result).toBeUndefined();
  });

  test("session agent spawn rejects invalid role as invalidParams", async () => {
    const threadSession = {
      id: "thread-1",
      createAgentSession: async () => {
        throw new Error("createAgentSession should not run for invalid role");
      },
    };
    const harness = createRouteHarness({}, [], { threadSession });
    const handlers = createAgentRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/session/agent/spawn", {
      threadId: "thread-1",
      message: "hi",
      role: "bogus",
    });

    expect(response.error?.code).toBe(JSONRPC_ERROR_CODES.invalidParams);
    expect(response.result).toBeUndefined();
  });

  test("session agent spawn rejects invalid reasoningEffort as invalidParams", async () => {
    const threadSession = {
      id: "thread-1",
      createAgentSession: async () => {
        throw new Error("createAgentSession should not run for invalid reasoningEffort");
      },
    };
    const harness = createRouteHarness({}, [], { threadSession });
    const handlers = createAgentRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/session/agent/spawn", {
      threadId: "thread-1",
      message: "hi",
      reasoningEffort: "ultra",
    });

    expect(response.error?.code).toBe(JSONRPC_ERROR_CODES.invalidParams);
    expect(response.result).toBeUndefined();
  });

  test("session agent spawn forwards valid role and reasoningEffort", async () => {
    let harness!: RouteHarness;
    const threadSession = {
      id: "thread-1",
      createAgentSession: async (opts: { role?: string; reasoningEffort?: string }) => {
        expect(opts.role).toBe("explorer");
        expect(opts.reasoningEffort).toBe("low");
      },
    };
    harness = createRouteHarness({}, [], { threadSession });

    const handlers = createAgentRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/session/agent/spawn", {
      threadId: "thread-1",
      message: "hi",
      role: "explorer",
      reasoningEffort: "low",
    });

    expect(response.error).toBeUndefined();
  });

  test("session harness context set forwards valid payload to session", async () => {
    let harness!: RouteHarness;
    const threadSession = {
      id: "thread-1",
      setHarnessContext: async () => {
        harness.emitted.push({
          type: "harness_context",
          sessionId: "thread-1",
          context: {
            runId: "run-1",
            objective: "Do the thing",
            acceptanceCriteria: ["done"],
            constraints: [],
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        });
      },
    };
    harness = createRouteHarness({}, [], { threadSession });

    const handlers = createSessionRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/session/harnessContext/set", {
      threadId: "thread-1",
      context: {
        runId: "run-1",
        objective: "Do the thing",
        acceptanceCriteria: ["done"],
        constraints: [],
      },
    });

    expect(response.error).toBeUndefined();
    expect((response.result as { event: { type: string } }).event.type).toBe("harness_context");
  });

  test("session usage budget forwards emitted validation errors", async () => {
    let harness!: RouteHarness;
    const threadSession = {
      id: "thread-1",
      setSessionUsageBudget: async () => {
        harness.emitted.push(sessionError("Budget configuration is invalid."));
      },
    };
    harness = createRouteHarness({}, [], { threadSession });

    const handlers = createSessionRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/session/usageBudget/set", {
      threadId: "thread-1",
      warnAtUsd: 5,
      stopAtUsd: 1,
    });

    expect(response.error?.message).toContain("Budget configuration is invalid");
    expect(response.result).toBeUndefined();
  });

  test("session delete forwards emitted session errors", async () => {
    let harness!: RouteHarness;
    harness = createRouteHarness({
      deleteSession: async () => {
        harness.emitted.push(sessionError("Cannot delete the active session."));
      },
    });

    const handlers = createSessionRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/session/delete", {
      cwd: "C:/workspace",
      targetSessionId: "session-1",
    });

    expect(response.error?.message).toContain("Cannot delete the active session");
    expect(response.result).toBeUndefined();
  });

  test("mcp validation correlates responses by server name", async () => {
    const harness = createRouteHarness({
      validateMcpServer: async () => {
        harness.emitted.push(
          {
            type: "mcp_server_validation",
            sessionId: "session-1",
            name: "alpha",
            ok: true,
            mode: "stdio",
            message: "alpha",
          },
          {
            type: "mcp_server_validation",
            sessionId: "session-1",
            name: "beta",
            ok: true,
            mode: "stdio",
            message: "beta",
          },
        );
      },
    });

    const handlers = createMcpRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/mcp/server/validate", {
      cwd: "C:/workspace",
      name: "beta",
    });

    expect((response.result as any).event).toMatchObject({
      type: "mcp_server_validation",
      name: "beta",
    });
  });

  for (const scenario of [
    {
      method: "cowork/mcp/server/auth/authorize",
      sessionMethod: "authorizeMcpServerAuth",
      params: { cwd: "C:/workspace", name: "beta" },
      emitted: [
        {
          type: "mcp_server_auth_challenge",
          sessionId: "session-1",
          name: "alpha",
          challenge: {
            method: "code",
            instructions: "wrong",
          },
        },
        {
          type: "mcp_server_auth_challenge",
          sessionId: "session-1",
          name: "beta",
          challenge: {
            method: "code",
            instructions: "right",
          },
        },
      ],
    },
    {
      method: "cowork/mcp/server/auth/callback",
      sessionMethod: "callbackMcpServerAuth",
      params: { cwd: "C:/workspace", name: "beta", code: "1234" },
      emitted: [
        {
          type: "mcp_server_auth_result",
          sessionId: "session-1",
          name: "alpha",
          ok: true,
          mode: "stdio",
          message: "wrong",
        },
        {
          type: "mcp_server_auth_result",
          sessionId: "session-1",
          name: "beta",
          ok: true,
          mode: "stdio",
          message: "right",
        },
      ],
    },
    {
      method: "cowork/mcp/server/auth/setApiKey",
      sessionMethod: "setMcpServerApiKey",
      params: { cwd: "C:/workspace", name: "beta", apiKey: "secret" },
      emitted: [
        {
          type: "mcp_server_auth_result",
          sessionId: "session-1",
          name: "alpha",
          ok: true,
          mode: "stdio",
          message: "wrong",
        },
        {
          type: "mcp_server_auth_result",
          sessionId: "session-1",
          name: "beta",
          ok: true,
          mode: "stdio",
          message: "right",
        },
      ],
    },
  ] as const) {
    test(`${scenario.method} correlates auth responses by server name`, async () => {
      const harness = createRouteHarness({
        [scenario.sessionMethod]: async () => {
          harness.emitted.push(...scenario.emitted);
        },
      });

      const handlers = createMcpRouteHandlers(harness.context);
      const response = await harness.invoke(handlers, scenario.method, scenario.params);

      expect((response.result as any).event).toMatchObject({ name: "beta" });
    });
  }

  test("provider catalog read forwards emitted provider errors", async () => {
    let harness!: RouteHarness;
    harness = createRouteHarness({
      emitProviderCatalog: async () => {
        harness.emitted.push(sessionError("Failed to load provider catalog.", "provider"));
      },
    });

    const handlers = createProviderRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/provider/catalog/read", {
      cwd: "C:/workspace",
    });

    expect(response.error?.message).toContain("Failed to load provider catalog");
    expect(response.result).toBeUndefined();
  });

  test("mcp server upsert stops before emitting the server list when the mutation emits an error", async () => {
    let emittedServers = false;
    let harness!: RouteHarness;
    harness = createRouteHarness({
      upsertMcpServer: async () => {
        harness.emitted.push(sessionError("Invalid MCP server configuration."));
      },
      emitMcpServers: async () => {
        emittedServers = true;
      },
    });

    const handlers = createMcpRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/mcp/server/upsert", {
      cwd: "C:/workspace",
      server: {
        name: "broken",
      },
    });

    expect(response.error?.message).toContain("Invalid MCP server configuration");
    expect(response.result).toBeUndefined();
    expect(emittedServers).toBe(false);
  });

  test("skills/read correlates skill_content by requested skill name", async () => {
    const harness = createRouteHarness({
      readSkill: async () => {
        harness.emitted.push(
          {
            type: "skill_content",
            sessionId: "session-1",
            skill: { name: "alpha" } as any,
            content: "wrong",
          },
          {
            type: "skill_content",
            sessionId: "session-1",
            skill: { name: "beta" } as any,
            content: "right",
          },
        );
      },
    });

    const handlers = createSkillsRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/skills/read", {
      cwd: "C:/workspace",
      skillName: "beta",
    });

    expect((response.result as any).event).toMatchObject({
      type: "skill_content",
      skill: { name: "beta" },
      content: "right",
    });
  });

  for (const scenario of [
    { method: "cowork/skills/disable", sessionMethod: "disableSkill" },
    { method: "cowork/skills/enable", sessionMethod: "enableSkill" },
    { method: "cowork/skills/delete", sessionMethod: "deleteSkill" },
  ] as const) {
    test(`${scenario.method} stops before listSkills when the mutation emits an error`, async () => {
      let listSkillsCalls = 0;
      const harness = createRouteHarness({
        [scenario.sessionMethod]: async () => {
          harness.emitted.push(sessionError('Skill "missing-skill" not found.'));
        },
        listSkills: async () => {
          listSkillsCalls += 1;
          harness.emitted.push({
            type: "skills_list",
            sessionId: "session-1",
            skills: [],
          } as any);
        },
      });

      const handlers = createSkillsRouteHandlers(harness.context);
      const response = await harness.invoke(handlers, scenario.method, {
        cwd: "C:/workspace",
        skillName: "missing-skill",
      });

      expect(response.error?.message).toContain('Skill "missing-skill" not found.');
      expect(response.result).toBeUndefined();
      expect(listSkillsCalls).toBe(0);
    });
  }

  for (const scenario of [
    {
      method: "cowork/skills/install/preview",
      sessionMethod: "previewSkillInstall",
      params: { cwd: "C:/workspace", sourceInput: "catalog:demo", targetScope: "project" },
    },
    {
      method: "cowork/skills/install",
      sessionMethod: "installSkills",
      params: { cwd: "C:/workspace", sourceInput: "catalog:demo", targetScope: "project" },
    },
    {
      method: "cowork/skills/installation/copy",
      sessionMethod: "copySkillInstallation",
      params: { cwd: "C:/workspace", installationId: "demo-installation", targetScope: "project" },
    },
  ] as const) {
    test(`${scenario.method} forwards emitted session errors`, async () => {
      let harness!: RouteHarness;
      harness = createRouteHarness({
        [scenario.sessionMethod]: async () => {
          harness.emitted.push(sessionError(`Failed ${scenario.sessionMethod}.`));
        },
      });

      const handlers = createSkillsRouteHandlers(harness.context);
      const response = await harness.invoke(handlers, scenario.method, scenario.params);

      expect(response.error?.message).toContain(`Failed ${scenario.sessionMethod}`);
      expect(response.result).toBeUndefined();
    });
  }

  test("cowork/skills/installation/checkUpdate forwards emitted validation errors", async () => {
    const harness = createRouteHarness({
      checkSkillInstallationUpdate: async () => {
        harness.emitted.push(sessionError('Skill installation "missing-installation" was not found'));
      },
    });

    const handlers = createSkillsRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/skills/installation/checkUpdate", {
      cwd: "C:/workspace",
      installationId: "missing-installation",
    });

    expect(response.error?.message).toContain('Skill installation "missing-installation" was not found');
    expect(response.result).toBeUndefined();
  });

  test("cowork/skills/installation/read returns an emitted validation error instead of timing out", async () => {
    const harness = createRouteHarness({
      getSkillInstallation: async () => {
        harness.emitted.push(sessionError("Installation ID is required"));
      },
    });

    const handlers = createSkillsRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/skills/installation/read", {
      cwd: "C:/workspace",
      installationId: "   ",
    });

    expect(response.error?.message).toContain("Installation ID is required");
    expect(response.result).toBeUndefined();
  });

  for (const scenario of [
    { method: "cowork/skills/installation/enable", sessionMethod: "enableSkillInstallation" },
    { method: "cowork/skills/installation/disable", sessionMethod: "disableSkillInstallation" },
    { method: "cowork/skills/installation/delete", sessionMethod: "deleteSkillInstallation" },
    { method: "cowork/skills/installation/update", sessionMethod: "updateSkillInstallation" },
  ] as const) {
    test(`${scenario.method} returns an emitted validation error instead of timing out`, async () => {
      const harness = createRouteHarness({
        [scenario.sessionMethod]: async () => {
          harness.emitted.push(sessionError('Skill installation "missing-installation" was not found'));
        },
      });

      const handlers = createSkillsRouteHandlers(harness.context);
      const response = await harness.invoke(handlers, scenario.method, {
        cwd: "C:/workspace",
        installationId: "missing-installation",
      });

      expect(response.error?.message).toContain('Skill installation "missing-installation" was not found');
      expect(response.result).toBeUndefined();
    });
  }

  for (const scenario of [
    { method: "cowork/memory/list", sessionMethod: "emitMemories" },
    { method: "cowork/memory/upsert", sessionMethod: "upsertMemory", params: { content: "hello" } },
    { method: "cowork/memory/delete", sessionMethod: "deleteMemory", params: { id: "memory-1" } },
  ] as const) {
    test(`${scenario.method} forwards emitted session errors`, async () => {
      const harness = createRouteHarness({
        [scenario.sessionMethod]: async () => {
          harness.emitted.push(sessionError(`failed ${scenario.method}`, "backup"));
        },
      });

      const handlers = createMemoryRouteHandlers(harness.context);
      const response = await harness.invoke(handlers, scenario.method, {
        cwd: "C:/workspace",
        scope: "workspace",
        ...(scenario.params ?? {}),
      });

      expect(response.error?.message).toContain(`failed ${scenario.method}`);
      expect(response.result).toBeUndefined();
    });
  }

  for (const scenario of [
    { method: "cowork/backups/workspace/read", sessionMethod: "listWorkspaceBackups", params: {} },
    {
      method: "cowork/backups/workspace/delta/read",
      sessionMethod: "getWorkspaceBackupDelta",
      params: { targetSessionId: "thread-1", checkpointId: "cp-1" },
    },
    {
      method: "cowork/backups/workspace/checkpoint",
      sessionMethod: "createWorkspaceBackupCheckpoint",
      params: { targetSessionId: "thread-1" },
    },
  ] as const) {
    test(`${scenario.method} forwards emitted backup errors`, async () => {
      const harness = createRouteHarness({
        [scenario.sessionMethod]: async () => {
          harness.emitted.push(sessionError(`failed ${scenario.method}`));
        },
      });

      const handlers = createWorkspaceBackupRouteHandlers(harness.context);
      const response = await harness.invoke(handlers, scenario.method, {
        cwd: "C:/workspace",
        ...scenario.params,
      });

      expect(response.error?.message).toContain(`failed ${scenario.method}`);
      expect(response.result).toBeUndefined();
    });
  }
});
