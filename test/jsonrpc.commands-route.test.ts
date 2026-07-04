import { describe, expect, mock, test } from "bun:test";
import { createCommandRouteHandlers } from "../src/server/jsonrpc/routes/commands";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import { jsonRpcCommandResultSchemas } from "../src/server/jsonrpc/schema.commands";
import type { SessionEvent } from "../src/server/protocol";

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
    );
    expect(
      jsonRpcCommandResultSchemas["command/execute"].safeParse(harness.results[0]).success,
    ).toBe(true);
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
