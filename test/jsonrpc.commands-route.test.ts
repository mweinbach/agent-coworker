import { describe, expect, mock, test } from "bun:test";
import { createCommandRouteHandlers } from "../src/server/jsonrpc/routes/commands";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import { jsonRpcCommandResultSchemas } from "../src/server/jsonrpc/schema.commands";
import { createSessionEventCapture } from "../src/server/jsonrpc/sessionEventCapture";
import type { SessionEvent } from "../src/server/protocol";
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

function makeIdempotentHarness(
  claimUserMessage: (input: {
    text: string;
    displayText?: string;
    clientMessageId?: string;
  }) => CommandClaim,
) {
  const results: unknown[] = [];
  const errors: unknown[] = [];
  const executeCommand = mock(async () => {});
  const rejectUserMessageClaim = mock(() => {});
  const binding = {
    runtime: {
      id: "chat-1",
      skills: { executeCommand },
      turns: { claimUserMessage, rejectUserMessageClaim },
    },
  };
  const context = {
    threads: {
      subscribe: () => binding,
    },
    events: {
      capture: async () => {
        throw new Error("command/execute should not capture a session event");
      },
    },
    runtime: { waitForStartupReady: mock(async () => {}) },
    jsonrpc: {
      sendResult: (_ws: unknown, _id: unknown, result: unknown) => results.push(result),
      sendError: (_ws: unknown, _id: unknown, error: unknown) => errors.push(error),
    },
    utils: { isSessionError: (event: SessionEvent) => event.type === "error" },
  } as unknown as JsonRpcRouteContext;
  const execute = createCommandRouteHandlers(context)["command/execute"];
  if (!execute) throw new Error("Missing command/execute handler");
  return {
    binding,
    errors,
    execute,
    executeCommand,
    rejectUserMessageClaim,
    results,
    run: (ws: unknown, params: Record<string, unknown>) =>
      execute(ws as never, {
        id: 7,
        method: "command/execute",
        params,
      }),
  };
}

const ownerClaim = {
  kind: "owner" as const,
  key: "client-1",
  fingerprint: "command-input",
};

describe("command/execute idempotency", () => {
  test("claims raw arguments and acknowledges the admission turn", async () => {
    const claimUserMessage = mock(() => ownerClaim);
    const harness = makeIdempotentHarness(claimUserMessage);
    harness.executeCommand.mockImplementation(async (_name, _args, _id, opts) => {
      opts.onAdmission?.({ status: "accepted", turnId: "turn-command" });
    });

    await harness.run(
      { data: { taskReadAllowed: false } },
      {
        threadId: "chat-1",
        name: "task",
        arguments: "  Build the report  ",
        clientMessageId: " client-1 ",
      },
    );

    expect(claimUserMessage).toHaveBeenCalledWith({
      text: "  Build the report  ",
      displayText: "/task Build the report",
      clientMessageId: "client-1",
    });
    expect(harness.executeCommand).toHaveBeenCalledWith(
      "task",
      "  Build the report  ",
      "client-1",
      {
        allowThreadManagementTools: false,
        idempotencyClaim: ownerClaim,
        onAdmission: expect.any(Function),
      },
    );
    expect(harness.results).toEqual([
      {
        turn: { id: "turn-command", threadId: "chat-1", status: "inProgress", items: [] },
      },
    ]);
    expect(harness.rejectUserMessageClaim).not.toHaveBeenCalled();
    expect(harness.errors).toEqual([]);
  });

  test("replays an accepted command without executing it again", async () => {
    const harness = makeIdempotentHarness(() => ({
      kind: "replay",
      key: "client-1",
      outcome: Promise.resolve({ status: "accepted", value: { turnId: "turn-replay" } }),
    }));

    await harness.run(
      {},
      {
        threadId: "chat-1",
        name: "task",
        arguments: "Build the report",
        clientMessageId: "client-1",
      },
    );

    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.results).toEqual([
      {
        turn: { id: "turn-replay", threadId: "chat-1", status: "inProgress", items: [] },
        replayed: true,
      },
    ]);
  });

  test("replays a rejected command as the original admission error", async () => {
    const harness = makeIdempotentHarness(() => ({
      kind: "replay",
      key: "client-1",
      outcome: Promise.resolve({ status: "rejected", message: "Agent is busy" }),
    }));

    await harness.run(
      {},
      {
        threadId: "chat-1",
        name: "task",
        clientMessageId: "client-1",
      },
    );

    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.results).toEqual([]);
    expect(harness.errors).toEqual([{ code: -32600, message: "Agent is busy" }]);
  });

  test("reports a clientMessageId conflict and does not execute", async () => {
    const harness = makeIdempotentHarness(() => {
      throw new IdempotencyConflictError("client-1");
    });

    await harness.run(
      {},
      {
        threadId: "chat-1",
        name: "task",
        arguments: "different",
        clientMessageId: "client-1",
      },
    );

    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.errors).toEqual([
      {
        code: -32600,
        message:
          'command/execute clientMessageId conflict: The idempotency key "client-1" was already used for different input.',
      },
    ]);
  });

  test("lets a non-conflict claim failure escape instead of acknowledging the command", async () => {
    const harness = makeIdempotentHarness(() => {
      throw new Error("ledger unavailable");
    });

    await expect(
      harness.run(
        {},
        {
          threadId: "chat-1",
          name: "task",
          clientMessageId: "client-1",
        },
      ),
    ).rejects.toThrow("ledger unavailable");
    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.results).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  test("releases the claim when admission is rejected", async () => {
    const harness = makeIdempotentHarness(() => ownerClaim);
    const admissionError: Extract<SessionEvent, { type: "error" }> = {
      type: "error",
      sessionId: "chat-1",
      code: "busy",
      source: "session",
      message: "Agent is busy",
    };
    harness.executeCommand.mockImplementation(async (_name, _args, _id, opts) => {
      opts.onAdmission?.({ status: "rejected", error: admissionError });
    });

    await harness.run(
      {},
      {
        threadId: "chat-1",
        name: "task",
        clientMessageId: "client-1",
      },
    );

    expect(harness.rejectUserMessageClaim).toHaveBeenCalledWith(ownerClaim, "Agent is busy");
    expect(harness.results).toEqual([]);
    expect(harness.errors).toEqual([{ code: -32600, message: "Agent is busy" }]);
  });

  test("releases the claim when command execution throws before admission", async () => {
    const harness = makeIdempotentHarness(() => ownerClaim);
    harness.executeCommand.mockImplementation(async () => {
      throw new Error("startup failed");
    });

    await expect(
      harness.run(
        {},
        {
          threadId: "chat-1",
          name: "task",
          clientMessageId: "client-1",
        },
      ),
    ).rejects.toThrow("startup failed");
    expect(harness.rejectUserMessageClaim).toHaveBeenCalledWith(ownerClaim, "startup failed");
    expect(harness.results).toEqual([]);
  });

  test("releases the claim when a non-Error failure leaves no admission", async () => {
    const harness = makeIdempotentHarness(() => ownerClaim);
    harness.executeCommand.mockImplementation(async () => {
      throw "startup failed";
    });

    await expect(
      harness.run(
        {},
        {
          threadId: "chat-1",
          name: "task",
          clientMessageId: "client-1",
        },
      ),
    ).rejects.toBe("startup failed");
    expect(harness.rejectUserMessageClaim).toHaveBeenCalledWith(
      ownerClaim,
      "The original command execution request was not accepted.",
    );
  });

  test("rejects a resolved command that never reports admission", async () => {
    const harness = makeIdempotentHarness(() => ownerClaim);

    await expect(
      harness.run(
        {},
        {
          threadId: "chat-1",
          name: "task",
          clientMessageId: "client-1",
        },
      ),
    ).rejects.toThrow("Command execution finished without an admission outcome.");
    expect(harness.rejectUserMessageClaim).toHaveBeenCalledWith(
      ownerClaim,
      "Command execution finished without an admission outcome.",
    );
    expect(harness.results).toEqual([]);
  });

  test("keeps the event-capture path when the claim is absent", async () => {
    const events: SessionEvent[] = [
      {
        type: "session_busy",
        sessionId: "chat-1",
        busy: true,
        turnId: "turn-captured",
        cause: "command",
      },
    ];
    const harness = makeHarness(events);
    const claimUserMessage = mock(() => null);
    const runtime = {
      id: "chat-1",
      skills: { executeCommand: harness.executeCommand, listCommands: harness.listCommands },
      turns: { claimUserMessage, rejectUserMessageClaim: mock(() => {}) },
    };
    harness.context.threads.subscribe = (() => ({
      runtime,
    })) as typeof harness.context.threads.subscribe;

    await createCommandRouteHandlers(harness.context)["command/execute"]?.({} as never, {
      id: 8,
      method: "command/execute",
      params: { threadId: "chat-1", name: "task", arguments: "Build" },
    });

    expect(claimUserMessage).toHaveBeenCalledWith({
      text: "Build",
      displayText: "/task Build",
      clientMessageId: undefined,
    });
    expect(harness.executeCommand).toHaveBeenCalledWith("task", "Build", undefined, {
      allowThreadManagementTools: true,
    });
    expect(harness.results).toEqual([
      {
        turn: { id: "turn-captured", threadId: "chat-1", status: "inProgress", items: [] },
      },
    ]);
  });
});
