import { describe, expect, test } from "bun:test";

import { dispatchClientMessage } from "../src/server/startServer/dispatchClientMessage";

function createHarness(sessionOverrides: Record<string, any> = {}) {
  const sent: string[] = [];
  let closeCalls = 0;
  const session = {
    id: "session-1",
    ...sessionOverrides,
  } as any;
  const ws = {
    send: (payload: string) => {
      sent.push(payload);
    },
    close: () => {
      closeCalls += 1;
    },
  } as any;
  const sessionBindings = new Map([[session.id, { session }]]);

  return {
    ws,
    session,
    sent,
    sessionBindings,
    get closeCalls() {
      return closeCalls;
    },
  };
}

describe("dispatchClientMessage", () => {
  test("ignores client_hello messages", () => {
    const harness = createHarness({
      sendUserMessage: () => {
        throw new Error("should not be called");
      },
    });

    dispatchClientMessage({
      ws: harness.ws,
      session: harness.session,
      sessionBindings: harness.sessionBindings as any,
      message: { type: "client_hello", client: "cli" },
    });

    expect(harness.sent).toEqual([]);
  });

  test("returns a protocol error when the sessionId does not match", () => {
    const harness = createHarness();

    dispatchClientMessage({
      ws: harness.ws,
      session: harness.session,
      sessionBindings: harness.sessionBindings as any,
      message: { type: "ping", sessionId: "wrong-session" },
    });

    expect(harness.sent).toHaveLength(1);
    expect(JSON.parse(harness.sent[0]!)).toMatchObject({
      type: "error",
      sessionId: "session-1",
      source: "protocol",
      code: "unknown_session",
    });
  });

  test("routes ping to a pong response", () => {
    const harness = createHarness();

    dispatchClientMessage({
      ws: harness.ws,
      session: harness.session,
      sessionBindings: harness.sessionBindings as any,
      message: { type: "ping", sessionId: "session-1" },
    });

    expect(harness.sent).toEqual([
      JSON.stringify({ type: "pong", sessionId: "session-1" }),
    ]);
  });

  test("routes user_message to the thread/turn handlers", () => {
    let capturedArgs: unknown[] | null = null;
    const harness = createHarness({
      sendUserMessage: (...args: unknown[]) => {
        capturedArgs = args;
      },
    });

    dispatchClientMessage({
      ws: harness.ws,
      session: harness.session,
      sessionBindings: harness.sessionBindings as any,
      message: {
        type: "user_message",
        sessionId: "session-1",
        text: "hello",
        clientMessageId: "client-1",
      },
    });

    expect(capturedArgs).toEqual(["hello", "client-1"]);
  });

  test("routes apply_session_defaults through the session handlers", () => {
    let capturedPatch: Record<string, unknown> | null = null;
    const harness = createHarness({
      applySessionDefaults: (patch: Record<string, unknown>) => {
        capturedPatch = patch;
      },
    });

    dispatchClientMessage({
      ws: harness.ws,
      session: harness.session,
      sessionBindings: harness.sessionBindings as any,
      message: {
        type: "apply_session_defaults",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.4-mini",
        enableMcp: true,
        config: { maxSteps: 12 },
      } as any,
    });

    expect(capturedPatch).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      enableMcp: true,
      config: { maxSteps: 12 },
    });
  });

  test("routes representative provider, mcp, skills, memory/backups, and agent messages", () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const harness = createHarness({
      authorizeProviderAuth: (...args: unknown[]) => {
        calls.push({ method: "authorizeProviderAuth", args });
      },
      upsertMcpServer: (...args: unknown[]) => {
        calls.push({ method: "upsertMcpServer", args });
      },
      copySkillInstallation: (...args: unknown[]) => {
        calls.push({ method: "copySkillInstallation", args });
      },
      restoreWorkspaceBackup: (...args: unknown[]) => {
        calls.push({ method: "restoreWorkspaceBackup", args });
      },
      createAgentSession: (...args: unknown[]) => {
        calls.push({ method: "createAgentSession", args });
      },
    });

    const messages = [
      { type: "provider_auth_authorize", sessionId: "session-1", provider: "google", methodId: "oauth" },
      {
        type: "mcp_server_upsert",
        sessionId: "session-1",
        server: { name: "alpha", mode: "stdio", command: "node", args: ["server.js"] },
      },
      {
        type: "skill_installation_copy",
        sessionId: "session-1",
        installationId: "skill-1",
        targetScope: "project",
      },
      {
        type: "workspace_backup_restore",
        sessionId: "session-1",
        targetSessionId: "thread-1",
        checkpointId: "cp-1",
      },
      {
        type: "agent_spawn",
        sessionId: "session-1",
        message: "research this",
        role: "worker",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        forkContext: true,
      },
    ] as const;

    for (const message of messages) {
      dispatchClientMessage({
        ws: harness.ws,
        session: harness.session,
        sessionBindings: harness.sessionBindings as any,
        message: message as any,
      });
    }

    expect(calls).toEqual([
      { method: "authorizeProviderAuth", args: ["google", "oauth"] },
      { method: "upsertMcpServer", args: [{ name: "alpha", mode: "stdio", command: "node", args: ["server.js"] }, undefined] },
      { method: "copySkillInstallation", args: ["skill-1", "project"] },
      { method: "restoreWorkspaceBackup", args: ["thread-1", "cp-1"] },
      {
        method: "createAgentSession",
        args: [{
          message: "research this",
          role: "worker",
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
          forkContext: true,
        }],
      },
    ]);
  });

  test("routes session_close through the session handlers and cleans up the socket", async () => {
    let disposedReason: string | null = null;
    const harness = createHarness({
      closeForHistory: async () => {},
      dispose: (reason: string) => {
        disposedReason = reason;
      },
    });

    dispatchClientMessage({
      ws: harness.ws,
      session: harness.session,
      sessionBindings: harness.sessionBindings as any,
      message: { type: "session_close", sessionId: "session-1" },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(disposedReason).toBe("client requested close");
    expect(harness.sessionBindings.has("session-1")).toBe(false);
    expect(harness.closeCalls).toBe(1);
  });
});
