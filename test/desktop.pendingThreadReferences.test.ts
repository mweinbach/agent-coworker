import { afterEach, describe, expect, test } from "bun:test";

import {
  prependPendingThreadMessageWithAttachments,
  queuePendingThreadMessage,
  RUNTIME,
  shiftPendingThreadAttachments,
  shiftPendingThreadMessage,
  shiftPendingThreadReferences,
} from "../apps/desktop/src/app/store.helpers/runtimeState";

afterEach(() => {
  RUNTIME.pendingThreadMessages.clear();
  RUNTIME.pendingThreadAttachments.clear();
  RUNTIME.pendingThreadReferences.clear();
});

describe("desktop pending thread references", () => {
  test("queues and shifts references in lockstep with text and attachments", () => {
    const references = [{ kind: "skill" as const, name: "documents" }];
    const attachments = [
      { filename: "brief.txt", contentBase64: "aGVsbG8=", mimeType: "text/plain" },
    ];

    queuePendingThreadMessage("thread-1", " use docs ", attachments, references);

    expect(shiftPendingThreadMessage("thread-1")).toBe("use docs");
    expect(shiftPendingThreadAttachments("thread-1")).toEqual(attachments);
    expect(shiftPendingThreadReferences("thread-1")).toEqual(references);
    expect(RUNTIME.pendingThreadReferences.has("thread-1")).toBe(false);
  });

  test("prepends references when a queued send has to be restored", () => {
    const firstReferences = [{ kind: "plugin" as const, name: "acme" }];
    const restoredReferences = [{ kind: "skill" as const, name: "documents" }];

    queuePendingThreadMessage("thread-1", "first", undefined, firstReferences);
    prependPendingThreadMessageWithAttachments(
      "thread-1",
      "restored",
      undefined,
      restoredReferences,
    );

    expect(shiftPendingThreadMessage("thread-1")).toBe("restored");
    expect(shiftPendingThreadReferences("thread-1")).toEqual(restoredReferences);
    expect(shiftPendingThreadMessage("thread-1")).toBe("first");
    expect(shiftPendingThreadReferences("thread-1")).toEqual(firstReferences);
  });
});
