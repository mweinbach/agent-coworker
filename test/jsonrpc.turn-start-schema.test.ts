import { describe, expect, test } from "bun:test";

import {
  jsonRpcThreadTurnNotificationSchemas,
  jsonRpcThreadTurnResultSchemas,
} from "../src/server/jsonrpc/schema.threadTurn";

const turn = {
  id: "turn-1",
  threadId: "thread-1",
  status: "inProgress",
  items: [],
};

describe("turn/start JSON-RPC result schema", () => {
  test("accepts replayed only on the strict turn/start result", () => {
    expect(
      jsonRpcThreadTurnResultSchemas["turn/start"].parse({
        turn,
        replayed: true,
      }),
    ).toEqual({
      turn,
      replayed: true,
    });

    expect(() =>
      jsonRpcThreadTurnNotificationSchemas["turn/started"].parse({
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "inProgress",
          items: [],
        },
        replayed: true,
      }),
    ).toThrow();
  });
});
