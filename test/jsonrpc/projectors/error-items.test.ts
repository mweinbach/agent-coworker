import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../../src/server/jsonrpc/notificationProjector";
import { createThreadJournalNotificationProjector } from "../../../src/server/jsonrpc/threadJournalNotificationProjector";
import { sessionId, turnId } from "./fixtures";

describe("JSON-RPC projectors", () => {
  test("notification projector attaches mid-turn errors to the active turn", () => {
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
      type: "error",
      sessionId,
      message: "Request timed out.",
      code: "provider_error",
      source: "provider",
    });
    projector.handle({
      type: "session_busy",
      sessionId,
      busy: false,
      turnId,
      outcome: "error",
    });

    const errorCompleted = outbound.find(
      (message) => message.method === "item/completed" && message.params?.item?.type === "error",
    );
    expect(errorCompleted?.params?.turnId).toBe(turnId);
    expect(errorCompleted?.params?.item).toMatchObject({
      type: "error",
      message: "Request timed out.",
      code: "provider_error",
      source: "provider",
    });

    const turnCompleted = outbound.find((message) => message.method === "turn/completed");
    expect(turnCompleted?.params?.turn).toMatchObject({ id: turnId, status: "failed" });
  });

  test("journal projector persists mid-turn errors with the turn id", () => {
    const emissions: Array<{ eventType: string; turnId: string | null; payload: any }> = [];
    const projector = createThreadJournalNotificationProjector({
      threadId: sessionId,
      emit: (event) =>
        emissions.push({
          eventType: event.eventType,
          turnId: event.turnId,
          payload: event.payload,
        }),
    });

    projector.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    projector.handle({
      type: "error",
      sessionId,
      message: "Request timed out.",
      code: "provider_error",
      source: "provider",
    });

    const errorEmission = emissions.find(
      (emission) =>
        emission.eventType === "item/completed" && emission.payload?.item?.type === "error",
    );
    expect(errorEmission?.turnId).toBe(turnId);
    expect(errorEmission?.payload?.turnId).toBe(turnId);
  });

  test("errors outside a turn still project without a turn id", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcNotificationProjector({
      threadId: sessionId,
      send: (message) => outbound.push(message as { method: string; params?: any }),
    });

    projector.handle({
      type: "error",
      sessionId,
      message: "Uploaded file too large.",
      code: "validation_failed",
      source: "session",
    });

    const errorCompleted = outbound.find(
      (message) => message.method === "item/completed" && message.params?.item?.type === "error",
    );
    expect(errorCompleted?.params?.turnId).toBeNull();
    expect(errorCompleted?.params?.item?.message).toBe("Uploaded file too large.");
  });
});
