import { describe, expect, mock, test } from "bun:test";

import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { createCommandRouteHandlers } from "../src/server/jsonrpc/routes/commands";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import { jsonRpcCommandResultSchemas } from "../src/server/jsonrpc/schema.commands";
import { createSessionEventCapture } from "../src/server/jsonrpc/sessionEventCapture";
import type { SessionEvent } from "../src/server/protocol";
import type { UserMessageAdmission } from "../src/server/session/TurnExecutionManager";
import { IdempotencyConflictError } from "../src/shared/idempotencyLedger";

function makeHarness(events: SessionEvent[]) {
  const results: unknown[] = [];
  const errors: unknown[] = [];
  const executeCommand = mock(async () => {});
  const listCommands = mock(async () => {});
  const waitForStartupReady = mock(async () => {});
  const runtime = {
    id: "chat-1",
    skills: { executeCommand, listCommands },
  };
  const binding = { runtime };
  const context = {
    threads: {
      subscribe: (_ws: unknown, threadId: string) => (threadId === "chat-1" ? binding : null),
    },
    events: {
      capture: async (_binding: unknown, action: () => Promise<void>) => {
        await action();
        const event = events.shift();
        if (!event) throw new Error("Missing captured event");
        return event;
      },
    },
    utils: {
      isSessionError: (event: SessionEvent) => event.type === "error",
    },
    runtime: {
      waitForStartupReady,
    },
    jsonrpc: {
      sendResult: (_ws: unknown, _id: unknown, result: unknown) => results.push(result),
      sendError: (_ws: unknown, _id: unknown, error: unknown) => errors.push(error),
    },
  } as unknown as JsonRpcRouteContext;
  return { context, errors, executeCommand, listCommands, results, waitForStartupReady };
}

describe("command JSON-RPC routes", () => {
  test("returns emitted command-list errors instead of waiting for an event timeout", async () => {
    const harness = makeHarness([]);
    const failure: SessionEvent = {
      type: "error",
      code: "internal_error",
      source: "session",
      message: "Failed to list commands: skill directory is unreadable",
    };
    let sink: ((event: SessionEvent) => void) | undefined;
    const events = createSessionEventCapture({
      addBindingSink: (_binding, _sinkId, next) => {
        sink = next;
      },
      removeBindingSink: () => {
        sink = undefined;
      },
    });
    harness.context.events.capture = (binding, action, predicate) =>
      events.capture(binding, action, predicate, 50);
    harness.listCommands.mockImplementation(async () => {
      sink?.(failure);
    });

    await createCommandRouteHandlers(harness.context)["command/list"]?.({} as never, {
      id: 1,
      method: "command/list",
      params: { threadId: "chat-1" },
    });

    expect(harness.results).toEqual([]);
    expect(harness.errors).toEqual([{ code: -32600, message: failure.message }]);
  });

  test("lists server-resolved slash commands", async () => {
    const harness = makeHarness([
      {
        type: "commands",
        sessionId: "chat-1",
        commands: [
          {
            name: "task",
            description: "Promote substantial work into task mode",
            source: "skill",
            hints: ["$ARGUMENTS"],
          },
        ],
      },
    ]);
    await createCommandRouteHandlers(harness.context)["command/list"]?.({} as never, {
      id: 1,
      method: "command/list",
      params: { threadId: "chat-1" },
    });

    expect(harness.errors).toEqual([]);
    expect(harness.listCommands).toHaveBeenCalledTimes(1);
    expect(jsonRpcCommandResultSchemas["command/list"].safeParse(harness.results[0]).success).toBe(
      true,
    );
  });

  test("executes task as a real command turn", async () => {
    const harness = makeHarness([
      {
        type: "session_busy",
        sessionId: "chat-1",
        busy: true,
        turnId: "turn-1",
        cause: "command",
      },
    ]);
    await createCommandRouteHandlers(harness.context)["command/execute"]?.({} as never, {
      id: 2,
      method: "command/execute",
      params: {
        threadId: "chat-1",
        name: "task",
        arguments: "Build the release report",
        clientMessageId: "client-1",
      },
    });

    expect(harness.errors).toEqual([]);
    expect(harness.waitForStartupReady).toHaveBeenCalledTimes(1);
    expect(harness.executeCommand).toHaveBeenCalledWith(
      "task",
      "Build the release report",
      "client-1",
      { allowThreadManagementTools: true },
    );
    expect(
      jsonRpcCommandResultSchemas["command/execute"].safeParse(harness.results[0]).success,
    ).toBe(true);
  });

  test("forwards taskReadAllowed false as allowThreadManagementTools false on command/execute", async () => {
    const harness = makeHarness([
      {
        type: "session_busy",
        sessionId: "chat-1",
        busy: true,
        turnId: "turn-2",
        cause: "command",
      },
    ]);
    await createCommandRouteHandlers(harness.context)["command/execute"]?.(
      { data: { taskReadAllowed: false } } as never,
      {
        id: 2,
        method: "command/execute",
        params: {
          threadId: "chat-1",
          name: "task",
          arguments: "Build the release report",
        },
      },
    );

    expect(harness.executeCommand).toHaveBeenCalledWith(
      "task",
      "Build the release report",
      undefined,
      { allowThreadManagementTools: false },
    );
  });

  test("rejects blank command names before executing", async () => {
    const harness = makeHarness([]);
    await createCommandRouteHandlers(harness.context)["command/execute"]?.({} as never, {
      id: 4,
      method: "command/execute",
      params: { threadId: "chat-1", name: "   " },
    });

    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.waitForStartupReady).not.toHaveBeenCalled();
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toMatchObject({ code: -32602 });
  });

  test("rejects commands for unknown threads", async () => {
    const harness = makeHarness([]);
    await createCommandRouteHandlers(harness.context)["command/execute"]?.({} as never, {
      id: 3,
      method: "command/execute",
      params: { threadId: "missing", name: "task" },
    });

    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.waitForStartupReady).toHaveBeenCalledTimes(1);
    expect(harness.errors).toHaveLength(1);
  });
});

type CommandClaim =
  | { kind: "owner"; key: string; fingerprint: string }
  | {
      kind: "replay";
      key: string;
      outcome: Promise<
        { status: "accepted"; value: { turnId: string } } | { status: "rejected"; message: string }
      >;
    }
  | null;

function makeClaimHarness(events: SessionEvent[] = []) {
  const results: unknown[] = [];
  const errors: unknown[] = [];
  const executeCommand = mock(
    async (
      _name: string,
      _args: string | undefined,
      _clientMessageId: string | undefined,
      _options?: {
        allowThreadManagementTools?: boolean;
        idempotencyClaim?: CommandClaim;
        onAdmission?: (outcome: UserMessageAdmission) => void;
      },
    ) => {},
  );
  const claimUserMessage = mock(
    (_input: { text: string; displayText: string; clientMessageId?: string }): CommandClaim => null,
  );
  const rejectUserMessageClaim = mock((_claim: CommandClaim, _message: string) => {});
  const waitForStartupReady = mock(async () => {});
  const runtime = {
    id: "chat-1",
    skills: { executeCommand, listCommands: mock(async () => {}) },
    turns: { claimUserMessage, rejectUserMessageClaim },
  };
  const context = {
    threads: {
      subscribe: (_ws: unknown, threadId: string) => (threadId === "chat-1" ? { runtime } : null),
    },
    events: {
      capture: async (_binding: unknown, action: () => Promise<void>) => {
        await action();
        const event = events.shift();
        if (!event) throw new Error("Missing captured event");
        return event;
      },
    },
    utils: {
      isSessionError: (event: SessionEvent) => event.type === "error",
    },
    runtime: { waitForStartupReady },
    jsonrpc: {
      sendResult: (_ws: unknown, _id: unknown, result: unknown) => results.push(result),
      sendError: (_ws: unknown, _id: unknown, error: unknown) => errors.push(error),
    },
  } as unknown as JsonRpcRouteContext;

  return {
    claimUserMessage,
    context,
    errors,
    executeCommand,
    rejectUserMessageClaim,
    results,
    waitForStartupReady,
    execute(
      params: { name?: string; arguments?: string; clientMessageId?: string },
      options?: { id?: number; taskReadAllowed?: boolean },
    ) {
      const ws = (
        options?.taskReadAllowed === undefined
          ? {}
          : { data: { taskReadAllowed: options.taskReadAllowed } }
      ) as never;
      return createCommandRouteHandlers(context)["command/execute"]?.(ws, {
        id: options?.id ?? 1,
        method: "command/execute",
        params: { threadId: "chat-1", name: "task", ...params },
      });
    },
  };
}

const ownerClaim = { kind: "owner" as const, key: "client-1", fingerprint: "fp-1" };

const taskLocked: Extract<SessionEvent, { type: "error" }> = {
  type: "error",
  sessionId: "chat-1",
  code: "task_locked",
  source: "session",
  message: "Task task-1 is completed and cannot accept new turns until it is reopened or retried.",
  data: {
    category: "task_locked",
    source: "session",
    lockKind: "terminal_task_thread",
    taskId: "task-1",
    taskStatus: "completed",
  },
};

describe("command/execute idempotency", () => {
  test("reports a clientMessageId conflict without executing the command", async () => {
    const harness = makeClaimHarness();
    harness.claimUserMessage.mockImplementation(() => {
      throw new IdempotencyConflictError("client-1");
    });

    await harness.execute({
      name: "  task  ",
      arguments: "  Build  ",
      clientMessageId: " client-1 ",
    });

    expect(harness.waitForStartupReady).toHaveBeenCalledTimes(1);
    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.rejectUserMessageClaim).not.toHaveBeenCalled();
    expect(harness.results).toEqual([]);
    expect(harness.claimUserMessage).toHaveBeenCalledWith({
      text: "  Build  ",
      displayText: "/task Build",
      clientMessageId: "client-1",
    });
    expect(harness.errors).toEqual([
      {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message:
          'command/execute clientMessageId conflict: The idempotency key "client-1" was already used for different input.',
      },
    ]);
  });

  test("rethrows claim failures that are not idempotency conflicts", async () => {
    const harness = makeClaimHarness();
    harness.claimUserMessage.mockImplementation(() => {
      throw new Error("ledger unavailable");
    });

    await expect(harness.execute({ clientMessageId: "client-1" })).rejects.toThrow(
      "ledger unavailable",
    );
    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.errors).toEqual([]);
    expect(harness.results).toEqual([]);
  });

  test("replays an accepted command without starting another turn", async () => {
    const harness = makeClaimHarness();
    harness.claimUserMessage.mockReturnValue({
      kind: "replay",
      key: "client-1",
      outcome: Promise.resolve({ status: "accepted", value: { turnId: "turn-replay" } }),
    });

    await harness.execute({ clientMessageId: "client-1", arguments: "Build" });

    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.results).toEqual([
      {
        turn: { id: "turn-replay", threadId: "chat-1", status: "inProgress", items: [] },
        replayed: true,
      },
    ]);
    expect(
      jsonRpcCommandResultSchemas["command/execute"].safeParse(harness.results[0]).success,
    ).toBe(true);
  });

  test("replays a rejected command as the original admission error", async () => {
    const harness = makeClaimHarness();
    harness.claimUserMessage.mockReturnValue({
      kind: "replay",
      key: "client-1",
      outcome: Promise.resolve({ status: "rejected", message: "Agent is busy" }),
    });

    await harness.execute({ clientMessageId: "client-1" });

    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.results).toEqual([]);
    expect(harness.errors).toEqual([
      { code: JSONRPC_ERROR_CODES.invalidRequest, message: "Agent is busy" },
    ]);
  });

  test("acknowledges an owned command from admission and keeps raw argument text", async () => {
    const turn = Promise.withResolvers<void>();
    const harness = makeClaimHarness();
    harness.claimUserMessage.mockReturnValue(ownerClaim);
    harness.executeCommand.mockImplementation(async (_name, _args, _clientMessageId, options) => {
      options?.onAdmission?.({ status: "accepted", turnId: "turn-owned" });
      await turn.promise;
    });

    try {
      await harness.execute(
        { name: "  task  ", arguments: "   ", clientMessageId: "client-1" },
        { taskReadAllowed: false },
      );

      expect(harness.claimUserMessage).toHaveBeenCalledWith({
        text: "   ",
        displayText: "/task",
        clientMessageId: "client-1",
      });
      expect(harness.executeCommand).toHaveBeenCalledWith("task", "   ", "client-1", {
        allowThreadManagementTools: false,
        idempotencyClaim: ownerClaim,
        onAdmission: expect.any(Function),
      });
      expect(harness.results).toEqual([
        {
          turn: { id: "turn-owned", threadId: "chat-1", status: "inProgress", items: [] },
        },
      ]);
      expect(harness.errors).toEqual([]);
      expect(harness.rejectUserMessageClaim).not.toHaveBeenCalled();
    } finally {
      turn.resolve();
    }
  });

  test("releases an owned claim when admission is rejected, including task lock data", async () => {
    const harness = makeClaimHarness();
    harness.claimUserMessage.mockReturnValue(ownerClaim);
    harness.executeCommand.mockImplementation(async (_name, _args, _clientMessageId, options) => {
      options?.onAdmission?.({ status: "rejected", error: taskLocked });
    });

    await harness.execute({ clientMessageId: "client-1" });

    expect(harness.rejectUserMessageClaim).toHaveBeenCalledWith(ownerClaim, taskLocked.message);
    expect(harness.results).toEqual([]);
    expect(harness.errors).toEqual([
      {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message: taskLocked.message,
        data: taskLocked.data,
      },
    ]);
  });

  test("releases an owned claim when execution throws before admission", async () => {
    const harness = makeClaimHarness();
    harness.claimUserMessage.mockReturnValue(ownerClaim);
    harness.executeCommand.mockImplementation(async () => {
      throw new Error("startup failed");
    });

    await expect(harness.execute({ clientMessageId: "client-1" })).rejects.toThrow(
      "startup failed",
    );
    expect(harness.results).toEqual([]);
    expect(harness.errors).toEqual([]);
    expect(harness.rejectUserMessageClaim).toHaveBeenCalledWith(ownerClaim, "startup failed");
  });

  test("releases an owned claim when a non-error throw happens before admission", async () => {
    const harness = makeClaimHarness();
    harness.claimUserMessage.mockReturnValue(ownerClaim);
    harness.executeCommand.mockImplementation(async () => {
      throw "nope";
    });

    await expect(harness.execute({ clientMessageId: "client-1" })).rejects.toBe("nope");
    expect(harness.rejectUserMessageClaim).toHaveBeenCalledWith(
      ownerClaim,
      "The original command execution request was not accepted.",
    );
  });

  test("releases an owned claim when execution finishes without admission", async () => {
    const harness = makeClaimHarness();
    harness.claimUserMessage.mockReturnValue(ownerClaim);

    await expect(harness.execute({ clientMessageId: "client-1" })).rejects.toThrow(
      "Command execution finished without an admission outcome.",
    );
    expect(harness.rejectUserMessageClaim).toHaveBeenCalledWith(
      ownerClaim,
      "Command execution finished without an admission outcome.",
    );
    expect(harness.results).toEqual([]);
  });

  test("keeps the event-capture path when the claim is empty", async () => {
    const harness = makeClaimHarness([
      {
        type: "session_busy",
        sessionId: "chat-1",
        busy: true,
        turnId: "turn-uncarded",
        cause: "command",
      },
    ]);

    await harness.execute({ name: "  task  " });

    expect(harness.claimUserMessage).toHaveBeenCalledWith({
      text: "",
      displayText: "/task",
      clientMessageId: undefined,
    });
    expect(harness.executeCommand).toHaveBeenCalledWith("task", undefined, undefined, {
      allowThreadManagementTools: true,
    });
    expect(harness.results).toEqual([
      {
        turn: { id: "turn-uncarded", threadId: "chat-1", status: "inProgress", items: [] },
      },
    ]);
  });
});
