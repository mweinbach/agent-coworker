import { afterEach, describe, expect, test } from "bun:test";

import {
  queuePendingThreadMessage,
  RUNTIME,
  shiftPendingThreadMessage,
} from "../apps/desktop/src/app/store.helpers/runtimeState";

afterEach(() => {
  RUNTIME.pendingThreadMessages.clear();
});

describe("desktop pending thread references", () => {
  test("queues and shifts references in lockstep with text and attachments", () => {
    const references = [{ kind: "skill" as const, name: "documents" }];
    const attachments = [
      { filename: "brief.txt", contentBase64: "aGVsbG8=", mimeType: "text/plain" },
    ];

    queuePendingThreadMessage("thread-1", { text: " use docs ", attachments, references });

    expect(shiftPendingThreadMessage("thread-1")).toEqual({
      text: "use docs",
      attachments,
      references,
    });
    expect(RUNTIME.pendingThreadMessages.has("thread-1")).toBe(false);
  });

  test("prepends references when a queued send has to be restored", () => {
    const firstReferences = [{ kind: "plugin" as const, name: "acme" }];
    const restoredReferences = [{ kind: "skill" as const, name: "documents" }];

    queuePendingThreadMessage("thread-1", { text: "first", references: firstReferences });
    queuePendingThreadMessage(
      "thread-1",
      { text: "restored", references: restoredReferences },
      "first",
    );

    expect(shiftPendingThreadMessage("thread-1")).toEqual({
      text: "restored",
      references: restoredReferences,
    });
    expect(shiftPendingThreadMessage("thread-1")).toEqual({
      text: "first",
      references: firstReferences,
    });
  });
});
