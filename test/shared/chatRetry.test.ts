import { describe, expect, test } from "bun:test";

import { HIDDEN_RETRY_TURN_PROMPT, isHiddenRetryTurnMessage } from "../../src/shared/chatRetry";
import type { SessionFeedItem } from "../../src/shared/sessionSnapshot";

describe("shared chat retry", () => {
  test("hides only the marked synthetic retry turn", () => {
    const retryMessage: SessionFeedItem = {
      id: "retry",
      kind: "message",
      role: "user",
      ts: "2024-01-01T00:00:00.000Z",
      text: HIDDEN_RETRY_TURN_PROMPT,
      annotations: [
        {
          type: "cowork.toolRetryTurn",
          version: 1,
          targetItemIds: ["failed-tool"],
        },
      ],
    };
    const userMessage: SessionFeedItem = {
      ...retryMessage,
      id: "visible",
      text: "Continue",
      annotations: undefined,
    };
    const sameTextFromUser: SessionFeedItem = {
      ...userMessage,
      id: "same-text",
      text: HIDDEN_RETRY_TURN_PROMPT,
    };
    const assistantWithMarker: SessionFeedItem = {
      ...retryMessage,
      id: "assistant",
      role: "assistant",
    };

    expect(isHiddenRetryTurnMessage(retryMessage)).toBe(true);
    expect(isHiddenRetryTurnMessage(userMessage)).toBe(false);
    expect(isHiddenRetryTurnMessage(sameTextFromUser)).toBe(false);
    expect(isHiddenRetryTurnMessage(assistantWithMarker)).toBe(false);
  });

  test("ignores unknown annotation versions", () => {
    expect(
      isHiddenRetryTurnMessage({
        kind: "message",
        role: "user",
        annotations: [{ type: "cowork.toolRetryTurn", version: 2 }],
      }),
    ).toBe(false);
  });
});
