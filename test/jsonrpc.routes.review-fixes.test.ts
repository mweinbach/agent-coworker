import { describe, expect, test } from "bun:test";

import { createProviderAndMcpRouteHandlers } from "../src/server/jsonrpc/routes/providerAndMcp";
import { createSkillsMemoryAndWorkspaceBackupRouteHandlers } from "../src/server/jsonrpc/routes/skillsMemoryAndWorkspaceBackup";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import type { ServerEvent } from "../src/server/protocol";

type RouteHarness = ReturnType<typeof createRouteHarness>;

function createRouteHarness(
  session: Record<string, (...args: any[]) => Promise<void> | void>,
  emitted: ServerEvent[] = [],
) {
  const results: Array<{ id: string | number | null; result: unknown }> = [];
  const errors: Array<{ id: string | number | null; error: { code: number; message: string } }> = [];
  const binding = {} as any;

  const context = {
    getConfig: () => ({ workingDirectory: "C:/workspace" }),
    threads: {} as any,
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

    const handlers = createProviderAndMcpRouteHandlers(harness.context);
    const response = await harness.invoke(handlers, "cowork/provider/auth/authorize", {
      cwd: "C:/workspace",
      provider: "google",
      methodId: "missing_method",
    });

    expect(response.error?.message).toContain('Unsupported auth method "missing_method"');
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

    const handlers = createProviderAndMcpRouteHandlers(harness.context);
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

      const handlers = createProviderAndMcpRouteHandlers(harness.context);
      const response = await harness.invoke(handlers, scenario.method, scenario.params);

      expect((response.result as any).event).toMatchObject({ name: "beta" });
    });
  }

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

    const handlers = createSkillsMemoryAndWorkspaceBackupRouteHandlers(harness.context);
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

      const handlers = createSkillsMemoryAndWorkspaceBackupRouteHandlers(harness.context);
      const response = await harness.invoke(handlers, scenario.method, {
        cwd: "C:/workspace",
        skillName: "missing-skill",
      });

      expect(response.error?.message).toContain('Skill "missing-skill" not found.');
      expect(response.result).toBeUndefined();
      expect(listSkillsCalls).toBe(0);
    });
  }

  test("cowork/skills/installation/checkUpdate forwards emitted validation errors", async () => {
    const harness = createRouteHarness({
      checkSkillInstallationUpdate: async () => {
        harness.emitted.push(sessionError('Skill installation "missing-installation" was not found'));
      },
    });

    const handlers = createSkillsMemoryAndWorkspaceBackupRouteHandlers(harness.context);
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

    const handlers = createSkillsMemoryAndWorkspaceBackupRouteHandlers(harness.context);
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

      const handlers = createSkillsMemoryAndWorkspaceBackupRouteHandlers(harness.context);
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

      const handlers = createSkillsMemoryAndWorkspaceBackupRouteHandlers(harness.context);
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

      const handlers = createSkillsMemoryAndWorkspaceBackupRouteHandlers(harness.context);
      const response = await harness.invoke(handlers, scenario.method, {
        cwd: "C:/workspace",
        ...scenario.params,
      });

      expect(response.error?.message).toContain(`failed ${scenario.method}`);
      expect(response.result).toBeUndefined();
    });
  }
});
