import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../../src/server/jsonrpc/notificationProjector";
import { sessionId, turnId } from "./fixtures";

describe("JSON-RPC session notification passthrough", () => {
  test("forwards matching session events and drops mismatched session ids", () => {
    const outbound: Array<{ method: string; params?: unknown }> = [];
    const projector = createJsonRpcNotificationProjector({
      threadId: sessionId,
      send: (message) => outbound.push(message as { method: string; params?: unknown }),
    });

    projector.handle({
      type: "session_usage",
      sessionId,
      usage: null,
    });
    projector.handle({
      type: "budget_warning",
      sessionId,
      currentCostUsd: 1.25,
      thresholdUsd: 1,
      message: "budget warning",
    });
    projector.handle({
      type: "session_usage",
      sessionId: "other-session",
      usage: null,
    });

    expect(outbound).toEqual([
      {
        method: "cowork/session/usage",
        params: { type: "session_usage", sessionId, usage: null },
      },
      {
        method: "cowork/session/budgetWarning",
        params: {
          type: "budget_warning",
          sessionId,
          currentCostUsd: 1.25,
          thresholdUsd: 1,
          message: "budget warning",
        },
      },
    ]);
  });

  test("shouldSendNotification can suppress budget events without dropping turn projection", () => {
    const outbound: Array<{ method: string; params?: unknown }> = [];
    const projector = createJsonRpcNotificationProjector({
      threadId: sessionId,
      send: (message) => outbound.push(message as { method: string; params?: unknown }),
      shouldSendNotification: (method) => method !== "cowork/session/budgetWarning",
    });

    projector.handle({
      type: "budget_warning",
      sessionId,
      currentCostUsd: 2,
      thresholdUsd: 1,
      message: "hidden",
    });
    projector.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });

    expect(outbound.some((message) => message.method === "cowork/session/budgetWarning")).toBe(
      false,
    );
    expect(outbound.some((message) => message.method === "turn/started")).toBe(true);
  });
});
