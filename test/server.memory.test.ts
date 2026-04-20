import { describe, expect, test } from "bun:test";

import { HistoryManager } from "../src/server/session/HistoryManager";
import { SessionCostTracker } from "../src/session/costTracker";
import { SessionSnapshotProjector } from "../src/server/session/SessionSnapshotProjector";
import type { SessionSnapshot } from "../src/shared/sessionSnapshot";
import type { ModelMessage } from "../src/types";

function createFakeSessionContext(allMessages: ModelMessage[] = [], messages: ModelMessage[] = []) {
  return {
    state: {
      allMessages,
      messages,
    } as { allMessages: ModelMessage[]; messages: ModelMessage[] },
  };
}

describe("Memory caps", () => {
  describe("HistoryManager", () => {
    test("caps allMessages at 1000 while preserving system message", () => {
      const ctx = createFakeSessionContext();
      const hm = new HistoryManager(ctx as any);

      // Seed a system message
      ctx.state.allMessages.push({ role: "system", content: "You are helpful" });

      // Append 1500 user messages
      const batch: ModelMessage[] = [];
      for (let i = 0; i < 1500; i++) {
        batch.push({ role: "user", content: `msg ${i}` });
      }
      hm.appendMessagesToHistory(batch);

      expect(ctx.state.allMessages.length).toBeLessThanOrEqual(1000);
      expect(ctx.state.allMessages[0].role).toBe("system");
      expect(ctx.state.allMessages.at(-1)?.content).toBe("msg 1499");
    });

    test("caps allMessages without system message", () => {
      const ctx = createFakeSessionContext();
      const hm = new HistoryManager(ctx as any);

      const batch: ModelMessage[] = [];
      for (let i = 0; i < 1500; i++) {
        batch.push({ role: "user", content: `msg ${i}` });
      }
      hm.appendMessagesToHistory(batch);

      expect(ctx.state.allMessages.length).toBeLessThanOrEqual(1000);
      expect(ctx.state.allMessages.at(-1)?.content).toBe("msg 1499");
    });
  });

  describe("SessionCostTracker", () => {
    test("caps turns at 512 and recalculates totals", () => {
      const tracker = new SessionCostTracker("test-session");

      for (let i = 0; i < 600; i++) {
        tracker.recordTurn({
          turnId: `turn-${i}`,
          provider: "google",
          model: "gemini-1.5-flash",
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
        });
      }

      const snapshot = tracker.getSnapshot();
      expect(snapshot.turns.length).toBeLessThanOrEqual(512);
      expect(snapshot.totalTurns).toBeLessThanOrEqual(512);
      expect(snapshot.totalTokens).toBe(512 * 15);
    });

    test("preserves latest turns after cap", () => {
      const tracker = new SessionCostTracker("test-session");

      for (let i = 0; i < 600; i++) {
        tracker.recordTurn({
          turnId: `turn-${i}`,
          provider: "google",
          model: "gemini-1.5-flash",
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
        });
      }

      const snapshot = tracker.getSnapshot();
      expect(snapshot.turns[0].turnId).toBe("turn-88"); // 600 - 512 = 88
      expect(snapshot.turns.at(-1)?.turnId).toBe("turn-599");
    });
  });

  describe("SessionSnapshotProjector", () => {
    test("caps feed at 2000 items", () => {
      const base: SessionSnapshot = {
        sessionId: "test",
        title: "Test",
        titleSource: "default",
        titleModel: null,
        provider: "google",
        model: "gemini-1.5-flash",
        sessionKind: "root",
        parentSessionId: null,
        role: null,
        mode: null,
        depth: null,
        nickname: null,
        taskType: null,
        targetPaths: null,
        requestedModel: null,
        effectiveModel: null,
        requestedReasoningEffort: null,
        effectiveReasoningEffort: null,
        executionState: null,
        lastMessagePreview: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        lastEventSeq: 0,
        feed: [],
        agents: [],
        todos: [],
        sessionUsage: null,
        lastTurnUsage: null,
        hasPendingAsk: false,
        hasPendingApproval: false,
      };

      const projector = new SessionSnapshotProjector(base);

      // Simulate 3000 message events
      for (let i = 0; i < 3000; i++) {
        projector.applyEvent({
          type: "item/started",
          turnId: `turn-${Math.floor(i / 3)}`,
          itemId: `item-${i}`,
          item: {
            id: `item-${i}`,
            type: "message",
            role: i % 2 === 0 ? "user" : "assistant",
            text: `message ${i}`,
          },
        });
      }

      const snapshot = projector.getSnapshot();
      expect(snapshot.feed.length).toBeLessThanOrEqual(2000);
    });
  });
});
