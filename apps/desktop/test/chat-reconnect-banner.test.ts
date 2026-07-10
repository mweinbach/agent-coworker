import { describe, expect, test } from "bun:test";
import { shouldShowReconnectBanner } from "../src/ui/chat/chatLogic";

const disconnectedSession = {
  conversationVisible: true,
  threadId: "thread-1",
  threadStatus: "active" as const,
  transcriptOnly: false,
  connected: false,
  sessionId: "session-1",
  hydrating: false,
  workspaceStarting: false,
};

describe("desktop reconnect banner", () => {
  test("shows only for a disconnected live session", () => {
    expect(shouldShowReconnectBanner(disconnectedSession)).toBe(true);
    expect(shouldShowReconnectBanner({ ...disconnectedSession, connected: true })).toBe(false);
  });

  test("stays hidden for drafts, transcript views, hydration, and startup", () => {
    expect(shouldShowReconnectBanner({ ...disconnectedSession, sessionId: null })).toBe(false);
    expect(shouldShowReconnectBanner({ ...disconnectedSession, transcriptOnly: true })).toBe(false);
    expect(shouldShowReconnectBanner({ ...disconnectedSession, hydrating: true })).toBe(false);
    expect(shouldShowReconnectBanner({ ...disconnectedSession, workspaceStarting: true })).toBe(
      false,
    );
  });
});
