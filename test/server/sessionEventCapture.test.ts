import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { createSessionEventCapture } from "../../src/server/jsonrpc/sessionEventCapture";
import type { SessionEvent } from "../../src/server/protocol";
import type { SessionBinding } from "../../src/server/startServer/types";

type LogEvent = Extract<SessionEvent, { type: "log" }>;

const methods = ["capture", "captureMutationOutcome", "captureMutationEvents"] as const;
const accepted: LogEvent = { type: "log", sessionId: "session-1", line: "ready" };
const isLog = (event: SessionEvent): event is LogEvent => event.type === "log";
const clearNativeTimeout = globalThis.clearTimeout;

function trackTimers() {
  const schedule = spyOn(globalThis, "setTimeout");
  const cancel = spyOn(globalThis, "clearTimeout");
  return {
    schedule,
    cancel,
    restore() {
      for (const result of schedule.mock.results) {
        if (result.type === "return") clearNativeTimeout(result.value);
      }
      schedule.mockRestore();
      cancel.mockRestore();
    },
  };
}

function makeCapture() {
  const binding: SessionBinding = {
    session: null,
    runtime: null,
    socket: null,
    sinks: new Map(),
  };
  const removeBindingSink = mock((target: SessionBinding, sinkId: string) => {
    target.sinks.delete(sinkId);
  });
  const capture = createSessionEventCapture({
    addBindingSink: (target, sinkId, sink) => target.sinks.set(sinkId, sink),
    removeBindingSink,
    createSinkId: () => "capture:test",
  });
  return {
    binding,
    capture,
    removeBindingSink,
    emit(event: SessionEvent) {
      for (const sink of binding.sinks.values()) sink(event);
    },
  };
}

describe("session event capture", () => {
  let timers: ReturnType<typeof trackTimers>;

  beforeEach(() => {
    timers = trackTimers();
  });

  afterEach(() => {
    timers.restore();
  });

  for (const method of methods) {
    test.each(["synchronously", "asynchronously"] as const)(
      `${method} releases the sink and timer when an action fails %s`,
      async (failureMode) => {
        const { binding, capture, removeBindingSink } = makeCapture();
        const failure = new Error("action failed");
        const pending = capture[method](
          binding,
          () => {
            if (failureMode === "synchronously") throw failure;
            return Promise.reject(failure);
          },
          isLog,
        );

        await expect(pending).rejects.toBe(failure);

        expect(binding.sinks.size).toBe(0);
        expect(removeBindingSink).toHaveBeenCalledTimes(1);
        expect(timers.schedule).toHaveBeenCalledTimes(1);
        expect(timers.cancel).toHaveBeenCalledWith(timers.schedule.mock.results[0]?.value);
      },
    );

    test(`${method} releases its sink on timeout and stays settled when the action finishes`, async () => {
      const { binding, capture, removeBindingSink } = makeCapture();
      let finishAction!: () => void;
      const action = new Promise<void>((resolve) => {
        finishAction = resolve;
      });
      const pending = capture[method](binding, () => action, isLog, 1);

      await expect(pending).rejects.toThrow("Timed out waiting for control event");
      expect(binding.sinks.size).toBe(0);
      expect(removeBindingSink).toHaveBeenCalledTimes(1);

      finishAction();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(timers.schedule).toHaveBeenCalledTimes(1);
      expect(removeBindingSink).toHaveBeenCalledTimes(1);
    });

    test(`${method} captures synchronous matching events without leaving timers`, async () => {
      const { binding, capture, emit, removeBindingSink } = makeCapture();
      const pending = capture[method](binding, () => emit(accepted), isLog);

      await expect(pending).resolves.toEqual(
        method === "captureMutationEvents" ? [accepted] : accepted,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(binding.sinks.size).toBe(0);
      expect(removeBindingSink).toHaveBeenCalledTimes(1);
      expect(timers.schedule).toHaveBeenCalledTimes(method === "captureMutationEvents" ? 2 : 1);
      for (const result of timers.schedule.mock.results) {
        expect(timers.cancel).toHaveBeenCalledWith(result.value);
      }
    });
  }

  test.each(["capture", "captureMutationOutcome"] as const)(
    "%s keeps a matched outcome when its action later rejects",
    async (method) => {
      const { binding, capture, emit, removeBindingSink } = makeCapture();
      const pending = capture[method](
        binding,
        async () => {
          emit(accepted);
          throw new Error("late failure");
        },
        isLog,
      );

      await expect(pending).resolves.toEqual(accepted);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(binding.sinks.size).toBe(0);
      expect(removeBindingSink).toHaveBeenCalledTimes(1);
      expect(timers.schedule).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["captureMutationOutcome", "captureMutationEvents"] as const)(
    "%s releases its sink and timers for a successful no-op",
    async (method) => {
      const { binding, capture, removeBindingSink } = makeCapture();

      await expect(capture[method](binding, () => {}, isLog, 1_000, 0)).resolves.toEqual(
        method === "captureMutationEvents" ? [] : null,
      );

      expect(binding.sinks.size).toBe(0);
      expect(removeBindingSink).toHaveBeenCalledTimes(1);
      expect(timers.schedule).toHaveBeenCalledTimes(2);
      for (const result of timers.schedule.mock.results) {
        expect(timers.cancel).toHaveBeenCalledWith(result.value);
      }
    },
  );

  test("captureMutationEvents waits for the action and collects all matching events", async () => {
    const { binding, capture, emit, removeBindingSink } = makeCapture();
    const second: LogEvent = { ...accepted, line: "second" };
    let finishAction!: () => void;
    const action = new Promise<void>((resolve) => {
      finishAction = resolve;
    });
    const pending = capture.captureMutationEvents(
      binding,
      () => {
        emit(accepted);
        return action;
      },
      isLog,
      1_000,
      0,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    emit({ type: "todos", sessionId: "session-1", todos: [] });
    emit(second);
    expect(timers.schedule).toHaveBeenCalledTimes(1);

    finishAction();
    await expect(pending).resolves.toEqual([accepted, second]);
    expect(binding.sinks.size).toBe(0);
    expect(removeBindingSink).toHaveBeenCalledTimes(1);
  });
});
