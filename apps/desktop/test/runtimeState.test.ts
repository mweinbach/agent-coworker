import { beforeEach, describe, expect, test } from "bun:test";

const {
  RUNTIME,
  drainPendingThreadMessages,
  queuePendingThreadMessage,
  shiftPendingThreadAttachments,
  shiftPendingThreadMessage,
  prependPendingThreadMessage,
} = await import("../src/app/store.helpers/runtimeState");

describe("runtimeState pending thread message queue", () => {
  beforeEach(() => {
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingThreadAttachments.clear();
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

  test("draining queued messages also clears the aligned attachment queue", () => {
    queuePendingThreadMessage("thread-1", "first", [{
      filename: "notes.txt",
      contentBase64: "Zmlyc3Q=",
      mimeType: "text/plain",
    }]);

    expect(drainPendingThreadMessages("thread-1")).toEqual(["first"]);
    expect(shiftPendingThreadAttachments("thread-1")).toBeUndefined();
  });
});
