import { describe, expect, mock, test } from "bun:test";

import { createSessionEventCapture } from "../../../src/server/jsonrpc/sessionEventCapture";
import type { SessionEvent } from "../../../src/server/protocol";
import { SessionRegistry } from "../../../src/server/runtime/SessionRegistry";
import type { SessionRuntime } from "../../../src/server/session/SessionRuntime";
import type { SessionBinding } from "../../../src/server/startServer/types";

type ContinuationRuntime = {
  turns: Pick<SessionRuntime["turns"], "activeTurnId" | "sendSteerMessage" | "sendUserMessage">;
};

function registryWithRuntime(runtime: ContinuationRuntime | null): SessionRegistry {
  const binding: SessionBinding | null = runtime
    ? {
        session: null,
        runtime: { id: "session-1", ...runtime } as SessionRuntime,
        socket: null,
        sinks: new Map(),
      }
    : null;
  return {
    loadThreadBinding: () => binding,
    sessionEventCapture: createSessionEventCapture({
      addBindingSink: (target, id, sink) => {
        target.sinks.set(id, sink);
      },
      removeBindingSink: (target, id) => {
        target.sinks.delete(id);
      },
    }),
  } as unknown as SessionRegistry;
}

function emitSessionEvent(registry: SessionRegistry, event: SessionEvent): void {
  for (const sink of registry.loadThreadBinding("session-1")?.sinks.values() ?? []) sink(event);
}

function continuationInput(onFailure = mock(async () => {})) {
  return {
    sessionId: "session-1",
    prompt: "Continue from the saved task answers.",
    displayText: "Answered one task question in the work panel.",
    onFailure,
  };
}

describe("SessionRegistry task continuation", () => {
  test("steers the active turn instead of starting a competing turn", async () => {
    const sendSteerMessage = mock(
      async (...args: Parameters<ContinuationRuntime["turns"]["sendSteerMessage"]>) => {
        emitSessionEvent(registry, {
          type: "steer_accepted",
          sessionId: "session-1",
          turnId: args[1],
          text: args[0],
          steerRequestId: args[6],
        });
      },
    );
    const sendUserMessage = mock(async () => {});
    const registry = registryWithRuntime({
      turns: { activeTurnId: "turn-1", sendSteerMessage, sendUserMessage },
    });

    const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(),
    );

    expect(result).toBe("steered");
    expect(sendSteerMessage).toHaveBeenCalledWith(
      "Continue from the saved task answers.",
      "turn-1",
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(String),
    );
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(registry.loadThreadBinding("session-1")?.sinks.size).toBe(0);
  });

  test.each([
    { code: "task_locked", message: "Task is locked while becoming terminal." },
    { code: "validation_failed", message: "No active turn to steer." },
    { code: "validation_failed", message: "Active turn no longer accepts steering." },
  ] as const)(
    "reports an emitted steer rejection instead of success: $message",
    async ({ code, message }) => {
      const onFailure = mock(async (_error: unknown) => {});
      const sendUserMessage = mock(async () => {});
      const registry = registryWithRuntime({
        turns: {
          activeTurnId: "turn-1",
          sendUserMessage,
          sendSteerMessage: mock(
            async (...args: Parameters<ContinuationRuntime["turns"]["sendSteerMessage"]>) => {
              emitSessionEvent(registry, {
                type: "error",
                sessionId: "session-1",
                code,
                source: "session",
                message,
                steerRequestId: args[6],
              });
            },
          ),
        },
      });

      const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
        registry,
        continuationInput(onFailure),
      );

      expect(result).toBe("failed");
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(String(onFailure.mock.calls[0]?.[0])).toContain(message);
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(registry.loadThreadBinding("session-1")?.sinks.size).toBe(0);
    },
  );

  test("accepts only its correlated steer receipt without waiting for turn work", async () => {
    const started = Promise.withResolvers<string | undefined>();
    const finishWork = Promise.withResolvers<void>();
    const onFailure = mock(async (_error: unknown) => {});
    const registry = registryWithRuntime({
      turns: {
        activeTurnId: "turn-1",
        sendUserMessage: mock(async () => {}),
        sendSteerMessage: mock(
          async (...args: Parameters<ContinuationRuntime["turns"]["sendSteerMessage"]>) => {
            const steerRequestId = args[6];
            emitSessionEvent(registry, {
              type: "steer_accepted",
              sessionId: "session-1",
              turnId: "turn-1",
              text: "Another request",
              steerRequestId: "another-request",
            });
            emitSessionEvent(registry, {
              type: "error",
              sessionId: "session-1",
              code: "validation_failed",
              source: "session",
              message: "Unrelated failure",
              steerRequestId: "another-request",
            });
            emitSessionEvent(registry, {
              type: "error",
              sessionId: "another-session",
              code: "validation_failed",
              source: "session",
              message: "Another session failed",
              steerRequestId,
            });
            emitSessionEvent(registry, {
              type: "steer_accepted",
              sessionId: "session-1",
              turnId: "another-turn",
              text: args[0],
              steerRequestId,
            });
            started.resolve(steerRequestId);
            await finishWork.promise;
          },
        ),
      },
    });
    const result = SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(onFailure),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const steerRequestId = await started.promise;
      expect(steerRequestId).toEqual(expect.any(String));
      expect(registry.loadThreadBinding("session-1")?.sinks.size).toBe(1);
      emitSessionEvent(registry, {
        type: "steer_accepted",
        sessionId: "session-1",
        turnId: "turn-1",
        text: continuationInput().prompt,
        steerRequestId,
      });
      await expect(
        Promise.race([
          result,
          new Promise((resolve) => {
            timeout = setTimeout(() => resolve("timed out"), 250);
          }),
        ]),
      ).resolves.toBe("steered");
      expect(onFailure).not.toHaveBeenCalled();
      expect(registry.loadThreadBinding("session-1")?.sinks.size).toBe(0);
    } finally {
      clearTimeout(timeout);
      finishWork.resolve();
      await result;
    }
  });

  test("propagates failure-persistence errors without reporting a successful steer", async () => {
    const onFailure = mock(async (_error: unknown) => {
      throw new Error("Unable to persist task failure");
    });
    const registry = registryWithRuntime({
      turns: {
        activeTurnId: "turn-1",
        sendUserMessage: mock(async () => {}),
        sendSteerMessage: mock(
          async (...args: Parameters<ContinuationRuntime["turns"]["sendSteerMessage"]>) => {
            emitSessionEvent(registry, {
              type: "error",
              sessionId: "session-1",
              code: "task_locked",
              source: "session",
              message: "Task is locked",
              steerRequestId: args[6],
            });
          },
        ),
      },
    });

    await expect(
      SessionRegistry.prototype.dispatchTaskContinuation.call(
        registry,
        continuationInput(onFailure),
      ),
    ).rejects.toThrow("Unable to persist task failure");
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test("queues a visible continuation after the idle task thread accepts it", async () => {
    const sendSteerMessage = mock(async () => {});
    const sendUserMessage = mock(
      async (...args: Parameters<ContinuationRuntime["turns"]["sendUserMessage"]>) => {
        args[6]?.onAdmission?.({ status: "accepted", turnId: "turn-1" });
      },
    );
    const registry = registryWithRuntime({
      turns: { activeTurnId: null, sendSteerMessage, sendUserMessage },
    });

    const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(),
    );

    expect(result).toBe("queued");
    expect(sendUserMessage).toHaveBeenCalledWith(
      "Continue from the saved task answers.",
      undefined,
      "Answered one task question in the work panel.",
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ onAdmission: expect.any(Function) }),
    );
    expect(sendSteerMessage).not.toHaveBeenCalled();
  });

  test("reports a missing task thread as a recoverable resume failure", async () => {
    const onFailure = mock(async () => {});
    const registry = registryWithRuntime(null);

    const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(onFailure),
    );

    expect(result).toBe("failed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(String(onFailure.mock.calls[0]?.[0])).toContain("could not be loaded");
  });

  test("reports a start failure before admission instead of claiming it was queued", async () => {
    const onFailure = mock(async () => {});
    const registry = registryWithRuntime({
      turns: {
        activeTurnId: null,
        sendSteerMessage: mock(async () => {}),
        sendUserMessage: mock(async () => {
          throw new Error("turn failed to start");
        }),
      },
    });

    const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(onFailure),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toBe("failed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(String(onFailure.mock.calls[0]?.[0])).toContain("turn failed to start");
  });

  test("records a rejected admission even when sendUserMessage resolves normally", async () => {
    const onFailure = mock(async (_error: unknown) => {});
    const registry = registryWithRuntime({
      turns: {
        activeTurnId: null,
        sendSteerMessage: mock(async () => {}),
        sendUserMessage: mock(
          async (...args: Parameters<ContinuationRuntime["turns"]["sendUserMessage"]>) => {
            args[6]?.onAdmission?.({
              status: "rejected",
              error: {
                type: "error",
                sessionId: "session-1",
                code: "busy",
                source: "session",
                message: "Agent is busy",
              },
            });
          },
        ),
      },
    });

    const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(onFailure),
    );

    expect(result).toBe("failed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(String(onFailure.mock.calls[0]?.[0])).toContain("Agent is busy");
  });

  test("returns queued on admission without waiting for the accepted turn to finish", async () => {
    const finishTurn = Promise.withResolvers<void>();
    const onFailure = mock(async (_error: unknown) => {});
    const registry = registryWithRuntime({
      turns: {
        activeTurnId: null,
        sendSteerMessage: mock(async () => {}),
        sendUserMessage: mock(
          async (...args: Parameters<ContinuationRuntime["turns"]["sendUserMessage"]>) => {
            args[6]?.onAdmission?.({ status: "accepted", turnId: "turn-1" });
            await finishTurn.promise;
          },
        ),
      },
    });
    const result = SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(onFailure),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          result,
          new Promise((resolve) => {
            timeout = setTimeout(() => resolve("timed out"), 250);
          }),
        ]),
      ).resolves.toBe("queued");
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timeout);
      finishTurn.resolve();
      await result;
    }
  });

  test("records a failure after admission without rejecting the queued receipt", async () => {
    const failTurn = Promise.withResolvers<void>();
    const failureObserved = Promise.withResolvers<void>();
    const onFailure = mock(async (_error: unknown) => {
      failureObserved.resolve();
    });
    const registry = registryWithRuntime({
      turns: {
        activeTurnId: null,
        sendSteerMessage: mock(async () => {}),
        sendUserMessage: mock(
          async (...args: Parameters<ContinuationRuntime["turns"]["sendUserMessage"]>) => {
            args[6]?.onAdmission?.({ status: "accepted", turnId: "turn-1" });
            await failTurn.promise;
            throw new Error("Accepted turn failed later");
          },
        ),
      },
    });

    const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(onFailure),
    );
    expect(result).toBe("queued");
    failTurn.resolve();
    await failureObserved.promise;
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(String(onFailure.mock.calls[0]?.[0])).toContain("Accepted turn failed later");
  });

  test("reports a missing admission receipt as failure rather than silently queueing", async () => {
    const onFailure = mock(async (_error: unknown) => {});
    const registry = registryWithRuntime({
      turns: {
        activeTurnId: null,
        sendSteerMessage: mock(async () => {}),
        sendUserMessage: mock(async () => {}),
      },
    });
    const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(onFailure),
    );
    expect(result).toBe("failed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(String(onFailure.mock.calls[0]?.[0])).toContain("admission");
  });

  test("can cancel child agents by parent id when the parent runtime is not live", async () => {
    const cancelAll = mock(async () => {});
    const registry = {
      getAgentControl: () => ({ cancelAll }),
    } as unknown as SessionRegistry;

    await SessionRegistry.prototype.cancelAgentSessions.call(registry, "parent-session-1", {
      timeoutMs: 250,
    });

    expect(cancelAll).toHaveBeenCalledWith("parent-session-1", { timeoutMs: 250 });
  });
});
