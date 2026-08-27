import { afterEach, describe, expect, test } from "bun:test";
import type { CodexAppServerJsonRpcNotification } from "../../../src/providers/codexAppServerClient";
import {
  assistantTextFromTurn,
  type CodexTurnNotificationRouter,
  createCodexTurnNotificationRouter,
} from "../../../src/runtime/codexAppServer/notifications";
import { createMockClient } from "../../fixtures/codexAppServerMock";
import { makeConfig } from "./helpers";

const routers: CodexTurnNotificationRouter[] = [];

afterEach(() => {
  for (const router of routers.splice(0)) router.dispose();
});

function createNotificationHarness() {
  const listeners = new Set<(notification: CodexAppServerJsonRpcNotification) => void>();
  const client = createMockClient();
  client.onNotification = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const parts: unknown[] = [];
  const router = createCodexTurnNotificationRouter(
    client,
    {
      config: makeConfig(process.cwd()),
      system: "You are Codex.",
      messages: [],
      tools: {},
      maxSteps: 1,
      onModelStreamPart: (part) => {
        parts.push(part);
      },
    },
    { threadId: () => "thread_1", turnId: () => "turn_1" },
    { threadId: "thread_1", turnId: "turn_1", onUsage: () => {} },
  );
  routers.push(router);
  return {
    router,
    parts,
    emit: (method: string, payload: Record<string, unknown>) => {
      for (const listener of listeners) {
        listener({ method, params: { threadId: "thread_1", turnId: "turn_1", ...payload } });
      }
    },
  };
}

describe("Codex notification projection", () => {
  test("preserves first-seen assistant order across repeated and out-of-order item events", () => {
    const { emit, router, parts } = createNotificationHarness();
    emit("item/agentMessage/delta", { itemId: "b", delta: "B draft" });
    emit("item/started", { item: { type: "agentMessage", id: "a", text: "A draft" } });
    emit("item/started", { item: { type: "agentMessage", id: "b", text: "duplicate start" } });
    expect(router.assistantText()).toBe("B draft\nA draft");

    emit("item/completed", { item: { type: "agentMessage", id: "a", text: " A final " } });
    emit("item/completed", { item: { type: "agentMessage", id: "b", text: " B final " } });
    emit("item/completed", { item: { type: "agentMessage", id: "c", text: "C final" } });
    emit("item/agentMessage/delta", { itemId: "b", delta: "continued" });
    emit("item/completed", { item: { type: "agentMessage", id: "b", text: "" } });
    expect(router.assistantText()).toBe("B final continued\nA final\nC final");
    expect(parts).toEqual([
      { type: "text-delta", id: "b", text: "B draft" },
      { type: "text-start", id: "a" },
      { type: "text-start", id: "b" },
      { type: "text-end", id: "a" },
      { type: "text-end", id: "b" },
      { type: "text-end", id: "c" },
      { type: "text-delta", id: "b", text: "continued" },
      { type: "text-end", id: "b" },
    ]);
  });

  test.each([
    { phase: " commentary ", normalized: "commentary", text: "" },
    { phase: " final_answer ", normalized: "final_answer", text: "answer" },
    { phase: " ", normalized: undefined, text: "answer" },
    { phase: null, normalized: undefined, text: "answer" },
    { phase: 123, normalized: undefined, text: "answer" },
  ])("normalizes and inherits assistant phase $phase", ({ phase, normalized, text }) => {
    const { emit, router, parts } = createNotificationHarness();
    emit("item/started", { item: { type: "agentMessage", id: "a", phase } });
    emit("item/agentMessage/delta", { itemId: "a", delta: "answer" });
    emit("item/completed", { item: { type: "agentMessage", id: "a", phase, text: "answer" } });
    const expectedPhase = normalized ? { phase: normalized } : {};
    expect(parts).toEqual([
      { type: "text-start", id: "a", ...expectedPhase },
      { type: "text-delta", id: "a", text: "answer", ...expectedPhase },
      { type: "text-end", id: "a", ...expectedPhase },
    ]);
    expect(router.assistantText()).toBe(text);
    expect(
      assistantTextFromTurn({
        items: [{ type: "agentMessage", id: "a", phase, text: "answer" }],
      }),
    ).toBe(text);
  });

  test.each([
    { payload: { patch: "payload patch" }, output: "payload patch" },
    { payload: { patch: "" }, output: "" },
    { payload: { patch: null, diff: "payload diff" }, output: "payload diff" },
    { payload: { summary: "payload summary" }, output: "item patch" },
  ])("preserves file-change field precedence for $payload", ({ payload, output }) => {
    const { emit, parts } = createNotificationHarness();
    emit("item/fileChange/patchUpdated", {
      itemId: "patch_1",
      item: { type: "fileChange", patch: "item patch", diff: "item diff" },
      ...payload,
    });
    expect(parts).toEqual([
      {
        type: "tool-result",
        toolCallId: "patch_1",
        toolName: "fileChange",
        output,
        providerExecuted: true,
      },
    ]);
  });
});
