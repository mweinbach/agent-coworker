import { beforeEach, describe, expect, test } from "bun:test";

const {
  RUNTIME,
  prependPendingThreadMessageWithAttachments,
  queuePendingThreadMessage,
  shiftPendingThreadMessage,
  shiftPendingThreadAttachments,
} = await import("../src/app/store.helpers/runtimeState");

describe("runtimeState pending thread message queue", () => {
  beforeEach(() => {
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingThreadAttachments.clear();
  });

  test("prepends a failed flush back to the front without changing FIFO order", () => {
    queuePendingThreadMessage("thread-1", "first");
    queuePendingThreadMessage("thread-1", "second");

    expect(shiftPendingThreadMessage("thread-1")).toEqual({ text: "first" });

    prependPendingThreadMessageWithAttachments("thread-1", "first");

    expect(shiftPendingThreadMessage("thread-1")).toEqual({ text: "first" });
    expect(shiftPendingThreadMessage("thread-1")).toEqual({ text: "second" });
    expect(shiftPendingThreadMessage("thread-1")).toBeUndefined();
  });

  test("carries a pre-generated clientMessageId through queue, shift, and prepend", () => {
    queuePendingThreadMessage("thread-1", "optimistic", undefined, undefined, "client-1");

    const shifted = shiftPendingThreadMessage("thread-1");
    expect(shifted).toEqual({ text: "optimistic", clientMessageId: "client-1" });

    prependPendingThreadMessageWithAttachments(
      "thread-1",
      "optimistic",
      undefined,
      undefined,
      "client-1",
    );
    expect(shiftPendingThreadMessage("thread-1")).toEqual({
      text: "optimistic",
      clientMessageId: "client-1",
    });
  });

  test("prepends attachment-only retries without desynchronizing the attachment FIFO", () => {
    const firstAttachment = [
      { filename: "first.png", mimeType: "image/png", contentBase64: "Zmlyc3Q=" },
    ];
    const secondAttachment = [
      { filename: "second.png", mimeType: "image/png", contentBase64: "c2Vjb25k" },
    ];

    queuePendingThreadMessage("thread-1", "", secondAttachment);
    prependPendingThreadMessageWithAttachments("thread-1", "", firstAttachment);

    expect(shiftPendingThreadMessage("thread-1")).toEqual({ text: "" });
    expect(shiftPendingThreadAttachments("thread-1")).toEqual(firstAttachment);
    expect(shiftPendingThreadMessage("thread-1")).toEqual({ text: "" });
    expect(shiftPendingThreadAttachments("thread-1")).toEqual(secondAttachment);
    expect(shiftPendingThreadMessage("thread-1")).toBeUndefined();
    expect(shiftPendingThreadAttachments("thread-1")).toBeUndefined();
  });
});
