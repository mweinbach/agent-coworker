import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../../src/server/jsonrpc/notificationProjector";
import { createThreadJournalNotificationProjector } from "../../../src/server/jsonrpc/threadJournalNotificationProjector";
import { sessionId, turnId } from "./fixtures";

describe("JSON-RPC projectors", () => {
  test("notification projector emits a visible user item when a steer commits during an active turn", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcNotificationProjector({
      threadId: sessionId,
      send: (message) => outbound.push(message as { method: string; params?: any }),
    });

    projector.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    projector.handle({
      type: "user_message",
      sessionId,
      text: "tighten the scope",
      clientMessageId: "steer-1",
    });

    const userStarted = outbound.find(
      (message) =>
        message.method === "item/started" && message.params?.item?.type === "userMessage",
    );
    const userCompleted = outbound.find(
      (message) =>
        message.method === "item/completed" && message.params?.item?.type === "userMessage",
    );

    expect(userStarted?.params?.item).toMatchObject({
      id: `userMessage:${turnId}:steer-1`,
      type: "userMessage",
      clientMessageId: "steer-1",
      content: [{ type: "text", text: "tighten the scope" }],
    });
    expect(userCompleted?.params?.item).toEqual(userStarted?.params?.item);
  });

  test("journal projector emits a visible user item when a steer commits during an active turn", () => {
    const emissions: Array<{ eventType: string; payload: any }> = [];
    const projector = createThreadJournalNotificationProjector({
      threadId: sessionId,
      emit: (event) => emissions.push({ eventType: event.eventType, payload: event.payload }),
    });

    projector.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    projector.handle({
      type: "user_message",
      sessionId,
      text: "tighten the scope",
      clientMessageId: "steer-1",
    });

    const userStarted = emissions.find(
      (event) => event.eventType === "item/started" && event.payload?.item?.type === "userMessage",
    );
    const userCompleted = emissions.find(
      (event) =>
        event.eventType === "item/completed" && event.payload?.item?.type === "userMessage",
    );

    expect(userStarted?.payload?.item).toMatchObject({
      id: `userMessage:${turnId}:steer-1`,
      type: "userMessage",
      clientMessageId: "steer-1",
      content: [{ type: "text", text: "tighten the scope" }],
    });
    expect(userCompleted?.payload?.item).toEqual(userStarted?.payload?.item);
  });
});
