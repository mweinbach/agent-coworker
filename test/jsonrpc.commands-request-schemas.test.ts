import { describe, expect, test } from "bun:test";

import {
  jsonRpcCommandRequestSchemas,
  jsonRpcCommandResultSchemas,
} from "../src/server/jsonrpc/schema.commands";

const turn = {
  id: "turn-1",
  threadId: "thread-1",
  status: "inProgress",
  items: [],
};

describe("command JSON-RPC schemas", () => {
  test("command/list and command/execute trim required ids and reject extras", () => {
    expect(
      jsonRpcCommandRequestSchemas["command/list"].parse({ threadId: "  thread-1  " }),
    ).toEqual({
      threadId: "thread-1",
    });
    expect(
      jsonRpcCommandRequestSchemas["command/list"].safeParse({ threadId: "   " }).success,
    ).toBe(false);
    expect(
      jsonRpcCommandRequestSchemas["command/list"].safeParse({
        threadId: "thread-1",
        extra: true,
      }).success,
    ).toBe(false);

    expect(
      jsonRpcCommandRequestSchemas["command/execute"].parse({
        threadId: "thread-1",
        name: "  /compact  ",
        arguments: "--force",
        clientMessageId: "  msg-1  ",
      }),
    ).toEqual({
      threadId: "thread-1",
      name: "/compact",
      arguments: "--force",
      clientMessageId: "msg-1",
    });
    expect(
      jsonRpcCommandRequestSchemas["command/execute"].safeParse({
        threadId: "thread-1",
        name: "   ",
      }).success,
    ).toBe(false);
    expect(
      jsonRpcCommandRequestSchemas["command/execute"].safeParse({
        threadId: "thread-1",
        name: "/compact",
        clientMessageId: "   ",
      }).success,
    ).toBe(false);
    expect(
      jsonRpcCommandRequestSchemas["command/execute"].safeParse({
        threadId: "thread-1",
        name: "/compact",
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("command results reject unknown sources and extra envelope keys", () => {
    expect(
      jsonRpcCommandResultSchemas["command/list"].parse({
        commands: [{ name: "/compact", source: "command", hints: [] }],
      }),
    ).toEqual({
      commands: [{ name: "/compact", source: "command", hints: [] }],
    });
    expect(
      jsonRpcCommandResultSchemas["command/list"].safeParse({
        commands: [{ name: "/compact", source: "plugin", hints: [] }],
      }).success,
    ).toBe(false);
    expect(
      jsonRpcCommandResultSchemas["command/list"].safeParse({
        commands: [{ name: "/compact", source: "command", hints: [], extra: true }],
      }).success,
    ).toBe(false);

    expect(jsonRpcCommandResultSchemas["command/execute"].parse({ turn })).toEqual({ turn });
    expect(
      jsonRpcCommandResultSchemas["command/execute"].safeParse({
        turn,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      jsonRpcCommandResultSchemas["command/execute"].safeParse({
        turn: { ...turn, extra: true },
      }).success,
    ).toBe(false);
  });
});
