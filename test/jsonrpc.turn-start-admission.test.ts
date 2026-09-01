import { describe, expect, mock, test } from "bun:test";

import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { extractJsonRpcInput, isJsonRpcSessionError } from "../src/server/jsonrpc/routes/shared";
import { createTurnRouteHandlers } from "../src/server/jsonrpc/routes/turn";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import { createSessionEventCapture } from "../src/server/jsonrpc/sessionEventCapture";
import type { SessionEvent } from "../src/server/protocol";
import type { SessionRuntime } from "../src/server/session/SessionRuntime";
import type { SendUserMessageOptions } from "../src/server/session/TurnExecutionManager";
import type { SessionBinding } from "../src/server/startServer/types";

function createAdmissionHarness(
  send: (text: string, options?: SendUserMessageOptions) => Promise<void>,
) {
  const binding: SessionBinding = {
    session: null,
    runtime: null,
    socket: null,
    sinks: new Map(),
  };
  const results: Array<{ id: string | number; result: unknown }> = [];
  const errors: Array<{ id: string | number | null; error: unknown }> = [];
  const rejectUserMessageClaim = mock(() => {});
  const sendUserMessage = mock<SessionRuntime["turns"]["sendUserMessage"]>(
    (text, _clientMessageId, _displayText, _attachments, _parts, _references, options) =>
      send(text, options),
  );
  binding.runtime = {
    id: "thread-1",
    turns: {
      claimUserMessage: (input: { clientMessageId?: string }) =>
        input.clientMessageId
          ? { kind: "owner", key: input.clientMessageId, fingerprint: "test-input" }
          : null,
      rejectUserMessageClaim,
      sendUserMessage,
    },
  } as unknown as SessionRuntime;
  const context = {
    runtime: { waitForStartupReady: async () => {} },
    threads: { subscribe: () => binding },
    events: createSessionEventCapture({
      addBindingSink: (target, sinkId, sink) => target.sinks.set(sinkId, sink),
      removeBindingSink: (target, sinkId) => target.sinks.delete(sinkId),
    }),
    utils: { extractInput: extractJsonRpcInput, isSessionError: isJsonRpcSessionError },
    jsonrpc: {
      sendResult: (_ws: unknown, id: string | number, result: unknown) =>
        results.push({ id, result }),
      sendError: (_ws: unknown, id: string | number | null, error: unknown) =>
        errors.push({ id, error }),
    },
  } as unknown as JsonRpcRouteContext;
  const start = createTurnRouteHandlers(context)["turn/start"]!;
  return {
    binding,
    results,
    errors,
    sendUserMessage,
    rejectUserMessageClaim,
    start: (id: number, text: string, clientMessageId?: string) =>
      start({} as never, {
        id,
        method: "turn/start",
        params: { threadId: "thread-1", input: text, clientMessageId },
      }),
    emit(event: SessionEvent) {
      for (const sink of binding.sinks.values()) sink(event);
    },
  };
}

const busyError: Extract<SessionEvent, { type: "error" }> = {
  type: "error",
  sessionId: "thread-1",
  code: "busy",
  source: "session",
  message: "Agent is busy",
};

describe("turn/start admission", () => {
  test.each([false, true])(
    "does not acknowledge a rejected concurrent message with another turn's receipt (client IDs: %s)",
    async (withClientIds) => {
      const harness = createAdmissionHarness(async (text, options) => {
        if (text === "first") {
          options?.onAdmission?.({ status: "accepted", turnId: "turn-first" });
          harness.emit({
            type: "session_busy",
            sessionId: "thread-1",
            busy: true,
            turnId: "turn-first",
          });
          return;
        }
        options?.onAdmission?.({ status: "rejected", error: busyError });
        harness.emit(busyError);
      });

      await Promise.all([
        harness.start(1, "first", withClientIds ? "message-first" : undefined),
        harness.start(2, "second", withClientIds ? "message-second" : undefined),
      ]);

      expect(harness.results).toEqual([
        {
          id: 1,
          result: {
            turn: { id: "turn-first", threadId: "thread-1", status: "inProgress", items: [] },
          },
        },
      ]);
      expect(harness.errors).toEqual([
        {
          id: 2,
          error: { code: JSONRPC_ERROR_CODES.invalidRequest, message: "Agent is busy" },
        },
      ]);
      expect(harness.binding.sinks.size).toBe(0);
    },
  );

  test("ignores unrelated session events while awaiting its own admission", async () => {
    const harness = createAdmissionHarness(async (_text, options) => {
      harness.emit(busyError);
      options?.onAdmission?.({ status: "accepted", turnId: "turn-owned" });
      harness.emit({
        type: "session_busy",
        sessionId: "thread-1",
        busy: true,
        turnId: "turn-owned",
      });
    });

    await harness.start(1, "owned message");

    expect(harness.errors).toEqual([]);
    expect(harness.results[0]?.result).toMatchObject({ turn: { id: "turn-owned" } });
  });

  test("acknowledges admission without waiting for the full turn to finish", async () => {
    const turn = Promise.withResolvers<void>();
    const harness = createAdmissionHarness(async (_text, options) => {
      options?.onAdmission?.({ status: "accepted", turnId: "turn-streaming" });
      harness.emit({
        type: "session_busy",
        sessionId: "thread-1",
        busy: true,
        turnId: "turn-streaming",
      });
      await turn.promise;
    });

    try {
      await harness.start(1, "long running message");
      expect(harness.results[0]?.result).toMatchObject({ turn: { id: "turn-streaming" } });
      expect(harness.errors).toEqual([]);
    } finally {
      turn.resolve();
    }
  });

  test("releases an idempotency claim when execution throws before admission", async () => {
    const harness = createAdmissionHarness(async () => {
      throw new Error("startup failed");
    });

    await expect(harness.start(1, "message", "message-1")).rejects.toThrow("startup failed");

    expect(harness.results).toEqual([]);
    expect(harness.rejectUserMessageClaim).toHaveBeenCalledWith(
      { kind: "owner", key: "message-1", fingerprint: "test-input" },
      "startup failed",
    );
  });

  test("rejects a missing admission receipt instead of leaving the request pending", async () => {
    const harness = createAdmissionHarness(async () => {});

    await expect(harness.start(1, "message")).rejects.toThrow(
      "Turn finished without an admission outcome.",
    );

    expect(harness.results).toEqual([]);
  });
});
