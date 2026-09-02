import { beforeEach, describe, expect, test } from "bun:test";

const { RUNTIME, queuePendingThreadMessage, rekeyThreadRuntimeMaps, shiftPendingThreadMessage } =
  await import("../src/app/store.helpers/runtimeState");

describe("runtimeState pending thread message queue", () => {
  beforeEach(() => {
    RUNTIME.pendingThreadMessages.clear();
  });

  test("dequeues a complete payload without shifting a later attachment or reference", () => {
    const attachments = [{ filename: "first.txt", contentBase64: "Zmlyc3Q=" }];
    const references = [{ kind: "skill" as const, name: "review" }];
    const draftSubmission = { key: "thread:local", revision: 7, submissionId: "submission-1" };
    queuePendingThreadMessage("local", { text: " text only " });
    queuePendingThreadMessage("local", {
      text: " ",
      attachments,
      references,
      clientMessageId: "client-1",
      draftSubmission,
    });
    queuePendingThreadMessage("local", { text: "last" });

    expect(shiftPendingThreadMessage("local")).toEqual({ text: "text only" });
    expect(shiftPendingThreadMessage("local")).toEqual({
      text: "",
      attachments,
      references,
      clientMessageId: "client-1",
      draftSubmission,
    });
    expect(shiftPendingThreadMessage("local")).toEqual({ text: "last" });
    expect(RUNTIME.pendingThreadMessages.has("local")).toBe(false);
  });

  test("promotes the complete queue while preserving per-payload copy semantics", () => {
    const attachments = [{ filename: "first.txt", contentBase64: "Zmlyc3Q=" }];
    const reference = { kind: "skill" as const, name: "review" };
    const references = [reference];
    const draftSubmission = { key: "thread:local", revision: 7, submissionId: "submission-1" };
    queuePendingThreadMessage("local", {
      text: "first",
      attachments,
      references,
      clientMessageId: "client-1",
      draftSubmission,
    });
    references.push({ kind: "skill", name: "later" });

    rekeyThreadRuntimeMaps("local", "server");

    expect(RUNTIME.pendingThreadMessages.has("local")).toBe(false);
    const promoted = shiftPendingThreadMessage("server");
    expect(promoted).toEqual({
      text: "first",
      attachments,
      references: [reference],
      clientMessageId: "client-1",
      draftSubmission,
    });
    expect(promoted?.attachments).toBe(attachments);
    expect(promoted?.references).not.toBe(references);
    expect(promoted?.references?.[0]).toBe(reference);
    expect(promoted?.draftSubmission).toBe(draftSubmission);
    expect(RUNTIME.pendingThreadMessages.has("server")).toBe(false);
  });

  test("prepends a failed flush back to the front without changing FIFO order", () => {
    queuePendingThreadMessage("thread-1", { text: "first" });
    queuePendingThreadMessage("thread-1", { text: "second" });

    expect(shiftPendingThreadMessage("thread-1")).toEqual({ text: "first" });

    queuePendingThreadMessage("thread-1", { text: "first" }, "first");

    expect(shiftPendingThreadMessage("thread-1")).toEqual({ text: "first" });
    expect(shiftPendingThreadMessage("thread-1")).toEqual({ text: "second" });
    expect(shiftPendingThreadMessage("thread-1")).toBeUndefined();
  });

  test("carries a pre-generated clientMessageId through queue, shift, and prepend", () => {
    queuePendingThreadMessage("thread-1", { text: "optimistic", clientMessageId: "client-1" });

    const shifted = shiftPendingThreadMessage("thread-1");
    expect(shifted).toEqual({ text: "optimistic", clientMessageId: "client-1" });

    if (!shifted) throw new Error("missing queued message");
    queuePendingThreadMessage("thread-1", shifted, "first");
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

    const references = [{ kind: "skill" as const, name: "documents" }];
    const draftSubmission = { key: "thread:thread-1", revision: 8, submissionId: "retry-1" };
    const first = {
      text: "",
      attachments: firstAttachment,
      references,
      draftSubmission,
      clientMessageId: "first",
    };
    const second = { text: "", attachments: secondAttachment, clientMessageId: "second" };
    queuePendingThreadMessage("thread-1", first);
    queuePendingThreadMessage("thread-1", second);
    const rejected = shiftPendingThreadMessage("thread-1");
    if (!rejected) throw new Error("missing queued message");
    queuePendingThreadMessage("thread-1", rejected, "first");

    const retry = shiftPendingThreadMessage("thread-1");
    expect(retry).toEqual(first);
    expect(retry?.attachments).toBe(firstAttachment);
    expect(retry?.references).not.toBe(rejected.references);
    expect(retry?.references?.[0]).toBe(references[0]);
    expect(retry?.draftSubmission).toBe(draftSubmission);
    expect(shiftPendingThreadMessage("thread-1")).toEqual(second);
    expect(shiftPendingThreadMessage("thread-1")).toBeUndefined();
    expect(RUNTIME.pendingThreadMessages.has("thread-1")).toBe(false);
  });

  test("ignores empty and reference-only payloads without disturbing the queue", () => {
    queuePendingThreadMessage("thread-1", {
      text: " ",
      attachments: [],
      references: [{ kind: "skill", name: "review" }],
    });
    expect(RUNTIME.pendingThreadMessages.has("thread-1")).toBe(false);
    queuePendingThreadMessage("thread-1", { text: "valid", attachments: [], references: [] });
    queuePendingThreadMessage("thread-1", { text: " " }, "first");
    expect(shiftPendingThreadMessage("thread-1")).toEqual({ text: "valid" });
    expect(RUNTIME.pendingThreadMessages.has("thread-1")).toBe(false);
  });

  test("promotion keeps an existing destination payload intact rather than mixing queues", () => {
    queuePendingThreadMessage("local", {
      text: "local",
      attachments: [{ filename: "local.txt", contentBase64: "bG9jYWw=" }],
    });
    const destination = {
      text: "server",
      references: [{ kind: "skill" as const, name: "review" }],
      clientMessageId: "server-message",
    };
    queuePendingThreadMessage("server", destination);
    rekeyThreadRuntimeMaps("local", "server");
    expect(RUNTIME.pendingThreadMessages.has("local")).toBe(false);
    expect(shiftPendingThreadMessage("server")).toEqual(destination);
    expect(shiftPendingThreadMessage("server")).toBeUndefined();
  });
});
