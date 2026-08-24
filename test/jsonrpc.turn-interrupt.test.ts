import { describe, expect, mock, test } from "bun:test";

import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { createTurnRouteHandlers } from "../src/server/jsonrpc/routes/turn";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import { jsonRpcThreadTurnRequestSchemas } from "../src/server/jsonrpc/schema.threadTurn";

function createInterruptHarness() {
  const cancel = mock((_opts?: { includeSubagents?: boolean }) => {});
  const results: Array<{ id: string | number | null; result: unknown }> = [];
  const errors: Array<{
    id: string | number | null;
    error: { code: number; message: string };
  }> = [];
  const context = {
    threads: {
      getLive: (threadId: string) =>
        threadId === "thread-1" ? { runtime: { turns: { cancel } } } : undefined,
    },
    jsonrpc: {
      sendResult: (_ws: unknown, id: string | number | null, result: unknown) => {
        results.push({ id, result });
      },
      sendError: (
        _ws: unknown,
        id: string | number | null,
        error: { code: number; message: string },
      ) => {
        errors.push({ id, error });
      },
    },
  } as unknown as JsonRpcRouteContext;

  return {
    cancel,
    results,
    errors,
    interrupt: createTurnRouteHandlers(context)["turn/interrupt"],
  };
}

describe("turn/interrupt cancellation scope", () => {
  test("preserves parent-only cancellation when the subagent option is omitted", async () => {
    const harness = createInterruptHarness();

    await harness.interrupt({} as never, {
      id: 1,
      method: "turn/interrupt",
      params: { threadId: "thread-1" },
    });

    expect(harness.cancel).toHaveBeenCalledWith();
    expect(harness.results).toEqual([{ id: 1, result: {} }]);
  });

  test("honors explicit parent-only cancellation", async () => {
    const harness = createInterruptHarness();

    await harness.interrupt({} as never, {
      id: 2,
      method: "turn/interrupt",
      params: { threadId: "thread-1", includeSubagents: false },
    });

    expect(harness.cancel).toHaveBeenCalledWith({ includeSubagents: false });
    expect(harness.results).toEqual([{ id: 2, result: {} }]);
  });

  test("cancels the parent and descendants when Stop subagents too is selected", async () => {
    const harness = createInterruptHarness();

    await harness.interrupt({} as never, {
      id: 3,
      method: "turn/interrupt",
      params: { threadId: "thread-1", includeSubagents: true },
    });

    expect(harness.cancel).toHaveBeenCalledWith({ includeSubagents: true });
    expect(harness.results).toEqual([{ id: 3, result: {} }]);
  });

  test("rejects malformed cancellation scope before interrupting anything", async () => {
    const harness = createInterruptHarness();

    await harness.interrupt({} as never, {
      id: 4,
      method: "turn/interrupt",
      params: { threadId: "thread-1", includeSubagents: "yes" },
    });

    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.errors[0]?.error.code).toBe(JSONRPC_ERROR_CODES.invalidParams);
  });

  test("advertises the optional cancellation scope in the strict wire schema", () => {
    expect(
      jsonRpcThreadTurnRequestSchemas["turn/interrupt"].parse({
        threadId: "thread-1",
        includeSubagents: true,
      }),
    ).toEqual({ threadId: "thread-1", includeSubagents: true });
  });
});
