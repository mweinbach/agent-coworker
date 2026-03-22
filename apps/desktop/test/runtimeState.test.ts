import { beforeEach, describe, expect, test } from "bun:test";

const {
  RUNTIME,
  queuePendingThreadMessage,
  shiftPendingThreadMessage,
  prependPendingThreadMessage,
} = await import("../src/app/store.helpers/runtimeState");

describe("runtimeState pending thread message queue", () => {
  beforeEach(() => {
    RUNTIME.pendingThreadMessages.clear();
  });

  test("prepends a failed flush back to the front without changing FIFO order", () => {
    queuePendingThreadMessage("thread-1", "first");
    queuePendingThreadMessage("thread-1", "second");

    expect(shiftPendingThreadMessage("thread-1")).toBe("first");

    prependPendingThreadMessage("thread-1", "first");

    expect(shiftPendingThreadMessage("thread-1")).toBe("first");
    expect(shiftPendingThreadMessage("thread-1")).toBe("second");
    expect(shiftPendingThreadMessage("thread-1")).toBeUndefined();
  });
});
