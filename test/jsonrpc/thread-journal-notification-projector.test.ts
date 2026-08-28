import { describe, expect, test } from "bun:test";

import { createThreadJournalNotificationProjector } from "../../src/server/jsonrpc/threadJournalNotificationProjector";
import type { PersistedThreadJournalEvent } from "../../src/server/sessionDb";

type JournalEmission = Omit<PersistedThreadJournalEvent, "seq">;

function createRecorder(threadId = "thread-1") {
  const emissions: JournalEmission[] = [];
  const projector = createThreadJournalNotificationProjector({
    threadId,
    emit: (event) => emissions.push(event),
  });
  return { projector, emissions, threadId };
}

describe("createThreadJournalNotificationProjector", () => {
  test("ignores events for another thread", () => {
    const { projector, emissions } = createRecorder();

    projector.handle({
      type: "session_busy",
      sessionId: "other-thread",
      busy: true,
      turnId: "turn-1",
      cause: "user_message",
    });
    projector.handle({
      type: "user_message",
      sessionId: "other-thread",
      text: "hi",
      clientMessageId: "c1",
      turnId: "turn-1",
      idempotencyFingerprint: "fp-1",
    });

    expect(emissions).toEqual([]);
  });

  test("emits internal/userMessageAccepted only when all idempotency fields are present", () => {
    const { projector, emissions, threadId } = createRecorder();

    projector.handle({
      type: "user_message",
      sessionId: threadId,
      text: "missing turn",
      clientMessageId: "c1",
      idempotencyFingerprint: "fp-1",
    });
    projector.handle({
      type: "user_message",
      sessionId: threadId,
      text: "missing fingerprint",
      clientMessageId: "c2",
      turnId: "turn-1",
    });
    projector.handle({
      type: "user_message",
      sessionId: threadId,
      text: "accepted",
      clientMessageId: "c3",
      turnId: "turn-2",
      idempotencyFingerprint: "fp-2",
    });

    const accepted = emissions.filter(
      (event) => event.eventType === "internal/userMessageAccepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      threadId,
      eventType: "internal/userMessageAccepted",
      turnId: "turn-2",
      itemId: null,
      requestId: null,
      payload: {
        clientMessageId: "c3",
        fingerprint: "fp-2",
        turnId: "turn-2",
      },
    });
  });

  test("journals turn lifecycle and ask/approval server requests in order", () => {
    const { projector, emissions, threadId } = createRecorder();

    projector.handle({
      type: "session_busy",
      sessionId: threadId,
      busy: true,
      turnId: "turn-9",
      cause: "user_message",
    });
    projector.handle({
      type: "ask",
      sessionId: threadId,
      requestId: "ask-1",
      question: "Which path?",
      options: ["src", "docs"],
    });
    projector.handle({
      type: "approval",
      sessionId: threadId,
      requestId: "appr-1",
      command: "rm -rf /tmp/scratch",
      dangerous: true,
      reasonCode: "matches_dangerous_pattern",
    });
    projector.handle({
      type: "session_busy",
      sessionId: threadId,
      busy: false,
      turnId: "turn-9",
      outcome: "completed",
    });

    const journaled = emissions.filter(
      (event) =>
        event.eventType === "turn/started" ||
        event.eventType === "turn/completed" ||
        event.eventType.startsWith("request:"),
    );
    expect(journaled.map((event) => event.eventType)).toEqual([
      "turn/started",
      "request:item/tool/requestUserInput",
      "request:item/commandExecution/requestApproval",
      "turn/completed",
    ]);
    expect(journaled[0]).toMatchObject({
      threadId,
      turnId: "turn-9",
      payload: {
        threadId,
        turn: { id: "turn-9", status: "inProgress", items: [] },
      },
    });
    expect(journaled[1]).toMatchObject({
      eventType: "request:item/tool/requestUserInput",
      turnId: "turn-9",
      requestId: "ask-1",
      itemId: "requestUserInput:ask-1",
      payload: {
        threadId,
        turnId: "turn-9",
        requestId: "ask-1",
        question: "Which path?",
        options: ["src", "docs"],
      },
    });
    expect(journaled[2]).toMatchObject({
      eventType: "request:item/commandExecution/requestApproval",
      turnId: "turn-9",
      requestId: "appr-1",
      itemId: "commandExecution:appr-1",
      payload: {
        threadId,
        command: "rm -rf /tmp/scratch",
        dangerous: true,
        reason: "matches_dangerous_pattern",
      },
    });
    expect(journaled[3]).toMatchObject({
      eventType: "turn/completed",
      turnId: "turn-9",
      payload: {
        turn: { id: "turn-9", status: "completed" },
      },
    });
  });
});
