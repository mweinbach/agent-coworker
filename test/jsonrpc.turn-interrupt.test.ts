import { describe, expect, mock, test } from "bun:test";

import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { createTurnRouteHandlers } from "../src/server/jsonrpc/routes/turn";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import {
  jsonRpcThreadTurnRequestSchemas,
  jsonRpcThreadTurnResultSchemas,
} from "../src/server/jsonrpc/schema.threadTurn";

function createInterruptHarness(opts: { busy?: boolean } = {}) {
  const cancel = mock((_opts?: { includeSubagents?: boolean }) => {});
  const results: Array<{ id: string | number | null; result: unknown }> = [];
  const errors: Array<{
    id: string | number | null;
    error: { code: number; message: string };
  }> = [];
  const context = {
    threads: {
      getLive: (threadId: string) =>
        threadId === "thread-1"
          ? { runtime: { turns: { cancel }, read: { isBusy: opts.busy ?? true } } }
          : undefined,
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
    expect(harness.results).toEqual([{ id: 1, result: { interrupted: true } }]);
  });

  test("honors explicit parent-only cancellation", async () => {
    const harness = createInterruptHarness();

    await harness.interrupt({} as never, {
      id: 2,
      method: "turn/interrupt",
      params: { threadId: "thread-1", includeSubagents: false },
    });

    expect(harness.cancel).toHaveBeenCalledWith({ includeSubagents: false });
    expect(harness.results).toEqual([{ id: 2, result: { interrupted: true } }]);
  });

  test("cancels the parent and descendants when Stop subagents too is selected", async () => {
    const harness = createInterruptHarness();

    await harness.interrupt({} as never, {
      id: 3,
      method: "turn/interrupt",
      params: { threadId: "thread-1", includeSubagents: true },
    });

    expect(harness.cancel).toHaveBeenCalledWith({ includeSubagents: true });
    expect(harness.results).toEqual([{ id: 3, result: { interrupted: true } }]);
  });

  test("reports an already-settled parent so clients do not wait for a nonexistent terminal", async () => {
    const harness = createInterruptHarness({ busy: false });

    await harness.interrupt({} as never, {
      id: 5,
      method: "turn/interrupt",
      params: { threadId: "thread-1" },
    });

    expect(harness.cancel).toHaveBeenCalledWith();
    expect(harness.results).toEqual([{ id: 5, result: { interrupted: false } }]);
  });

  test("still requests descendant cancellation while truthfully reporting an idle parent", async () => {
    const harness = createInterruptHarness({ busy: false });

    await harness.interrupt({} as never, {
      id: 6,
      method: "turn/interrupt",
      params: { threadId: "thread-1", includeSubagents: true },
    });

    expect(harness.cancel).toHaveBeenCalledWith({ includeSubagents: true });
    expect(harness.results).toEqual([{ id: 6, result: { interrupted: false } }]);
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

  test("accepts authoritative interruption results and legacy empty acknowledgements", () => {
    const resultSchema = jsonRpcThreadTurnResultSchemas["turn/interrupt"];
    expect(resultSchema.parse({ interrupted: true })).toEqual({ interrupted: true });
    expect(resultSchema.parse({ interrupted: false })).toEqual({ interrupted: false });
    expect(resultSchema.parse({})).toEqual({});
  });
});
