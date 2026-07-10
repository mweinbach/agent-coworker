import { describe, expect, test } from "bun:test";

import type { FeedItem } from "../src/app/types";
import { HIDDEN_RETRY_TURN_PROMPT, isHiddenRetryTurnMessage } from "../src/ui/chat/chatRetry";

describe("desktop chat retry", () => {
  test("hides only the marked synthetic retry turn", () => {
    const retryMessage: FeedItem = {
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
    const userMessage: FeedItem = {
      ...retryMessage,
      id: "visible",
      text: "Continue",
      annotations: undefined,
    };
    const sameTextFromUser: FeedItem = {
      ...userMessage,
      id: "same-text",
      text: HIDDEN_RETRY_TURN_PROMPT,
    };

    expect(isHiddenRetryTurnMessage(retryMessage)).toBe(true);
    expect(isHiddenRetryTurnMessage(userMessage)).toBe(false);
    expect(isHiddenRetryTurnMessage(sameTextFromUser)).toBe(false);
  });
});
