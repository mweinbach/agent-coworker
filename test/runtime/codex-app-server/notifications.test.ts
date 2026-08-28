import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CodexAppServerJsonRpcNotification } from "../../../src/providers/codexAppServerClient";
import {
  assistantTextFromTurn,
  type CodexTurnNotificationRouter,
  createCodexTurnNotificationRouter,
} from "../../../src/runtime/codexAppServer/notifications";
import type { RuntimeRunTurnParams } from "../../../src/runtime/types";
import { createMockClient } from "../../fixtures/codexAppServerMock";
import { makeConfig } from "./helpers";

const routers: CodexTurnNotificationRouter[] = [];

afterEach(() => {
  for (const router of routers.splice(0)) router.dispose();
});

function createNotificationHarness(
  options: Pick<RuntimeRunTurnParams, "abortSignal" | "onModelStreamPart"> = {},
) {
  const listeners = new Set<(notification: CodexAppServerJsonRpcNotification) => void>();
  const client = createMockClient();
  client.onNotification = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const parts: unknown[] = [];
  const todos: unknown[] = [];
  const usages: unknown[] = [];
  const router = createCodexTurnNotificationRouter(
    client,
    {
      config: makeConfig(process.cwd()),
      system: "You are Codex.",
      messages: [],
      tools: {},
      maxSteps: 1,
      onModelStreamPart:
        options.onModelStreamPart ??
        ((part) => {
          parts.push(part);
        }),
      updateTodos: (nextTodos) => {
        todos.push(nextTodos);
      },
    },
    { threadId: () => "thread_1", turnId: () => "turn_1" },
    {
      threadId: "thread_1",
      turnId: "turn_1",
      abortSignal: options.abortSignal,
      onUsage: (usage) => {
        usages.push(usage);
      },
    },
  );
  routers.push(router);
  const emit = (method: string, payload: Record<string, unknown>) => {
    for (const listener of listeners) {
      listener({ method, params: { threadId: "thread_1", turnId: "turn_1", ...payload } });
    }
  };
  return {
    router,
    close: () => client.close(),
    parts,
    todos,
    usages,
    emit,
    finish: async () => {
      const completion = router.waitForCompletion();
      emit("turn/completed", { turn: { id: "turn_1", status: "completed", items: [] } });
      await completion;
    },
  };
}

describe("Codex notification projection", () => {
  test.each([false, true])(
    "handles disconnect while draining with provider completion=%s",
    async (providerCompleted) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const invoked: unknown[] = [];
      const { emit, router, close } = createNotificationHarness({
        onModelStreamPart: async (part) => {
          invoked.push(part);
          entered.resolve();
          await release.promise;
        },
      });
      let settled = false;
      const completion = router.waitForCompletion().then(
        (turn) => {
          settled = true;
          return { turn };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      try {
        emit("item/agentMessage/delta", { itemId: "a", delta: "first" });
        emit("item/agentMessage/delta", { itemId: "a", delta: "second" });
        await entered.promise;
        const turn = { id: "turn_1", status: "completed", items: [] };
        if (providerCompleted) emit("turn/completed", { turn });
        await close();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(!providerCompleted);
        expect(invoked).toEqual([{ type: "text-delta", id: "a", text: "first" }]);
        release.resolve();
        const outcome = await completion;
        if (providerCompleted) {
          expect(outcome).toEqual({ turn });
          expect(invoked).toHaveLength(2);
        } else {
          expect(outcome).toEqual({
            error: expect.objectContaining({ message: expect.stringContaining("disconnected") }),
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(invoked).toHaveLength(1);
        }
      } finally {
        release.resolve();
      }
    },
  );

  test.each(["completion", "interruption"])(
    "keeps the %s deadline active while draining a blocked sink",
    async (deadline) => {
      const schedule = spyOn(globalThis, "setTimeout");
      const cancel = spyOn(globalThis, "clearTimeout");
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { emit, router } = createNotificationHarness({
        abortSignal: controller.signal,
        onModelStreamPart: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const completion = router.waitForCompletion().then(
        (turn) => ({ turn }),
        (error: unknown) => ({ error }),
      );
      try {
        emit("item/agentMessage/delta", { itemId: "a", delta: "first" });
        await entered.promise;
        emit("turn/completed", { turn: { id: "turn_1", status: "completed", items: [] } });
        if (deadline === "interruption") controller.abort();
        const duration = deadline === "interruption" ? 30_000 : 30 * 60 * 1000;
        const timerIndex = schedule.mock.calls.findIndex(([, delay]) => delay === duration);
        const timer = schedule.mock.calls[timerIndex];
        const handle = schedule.mock.results[timerIndex]?.value;
        expect(timer).toBeDefined();
        if (!timer || typeof timer[0] !== "function") throw new Error("Missing deadline timer");
        expect(cancel).not.toHaveBeenCalledWith(handle);
        timer[0]();
        await expect(completion).resolves.toEqual({
          error: expect.objectContaining({
            message: `Timed out waiting for codex app-server turn ${deadline}.`,
          }),
        });
        expect(cancel).toHaveBeenCalledWith(handle);
      } finally {
        release.resolve();
        router.dispose();
        schedule.mockRestore();
        cancel.mockRestore();
      }
    },
  );

  test.each(["abort", "dispose"])("drops queued deliveries after %s", async (stop) => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delivered: unknown[] = [];
    const invoked: unknown[] = [];
    const { emit, finish, router } = createNotificationHarness({
      abortSignal: controller.signal,
      onModelStreamPart: async (part) => {
        invoked.push(part);
        entered.resolve();
        await release.promise;
        delivered.push(part);
      },
    });
    try {
      emit("item/agentMessage/delta", { itemId: "a", delta: "first" });
      emit("item/agentMessage/delta", { itemId: "a", delta: "queued" });
      await entered.promise;
      if (stop === "abort") controller.abort();
      else router.dispose();
      emit("item/agentMessage/delta", { itemId: "a", delta: "late" });
      release.resolve();
      if (stop === "abort") await finish();
      else await new Promise<void>((resolve) => setImmediate(resolve));
      expect(invoked).toEqual([{ type: "text-delta", id: "a", text: "first" }]);
      expect(delivered).toEqual(invoked);
    } finally {
      release.resolve();
    }
  });

  for (const reverseStart of [false, true]) {
    for (const reverseYield of [false, true]) {
      for (const reverseFinish of [false, true]) {
        test(`keeps interleaved exec cells separate (${reverseStart}, ${reverseYield}, ${reverseFinish})`, async () => {
          const { emit, finish, parts } = createNotificationHarness();
          const cells = [
            { id: "a", name: "read_file", dynamicName: "readFile" },
            { id: "b", name: "web_search", dynamicName: "webSearch" },
          ];
          const startOrder = reverseStart ? [...cells].reverse() : cells;
          const yieldOrder = reverseYield ? [...cells].reverse() : cells;
          const finishOrder = reverseFinish ? [...cells].reverse() : cells;
          const raw = (item: Record<string, unknown>, target: Record<string, unknown> = {}) => {
            emit("rawResponseItem/completed", { item, ...target });
          };
          for (const cell of startOrder) {
            raw({
              type: "custom_tool_call",
              call_id: `exec-${cell.id}`,
              name: "exec",
              input: `await tools.${cell.name}({})`,
            });
          }
          for (const cell of yieldOrder) {
            raw({
              type: "custom_tool_call_output",
              call_id: `exec-${cell.id}`,
              output: `Script running with cell ID cell-${cell.id}. Continue with wait.`,
            });
          }
          for (const round of [1, 2]) {
            for (const cell of startOrder) {
              raw({
                type: "function_call",
                call_id: `wait-${cell.id}-${round}`,
                name: "functions.wait",
                arguments: { cell_id: `cell-${cell.id}` },
              });
            }
            for (const cell of yieldOrder) {
              const item = {
                type: "dynamicToolCall",
                id: `nested-${cell.id}-${round}`,
                tool: cell.dynamicName,
              };
              emit("item/started", { item });
              emit("item/completed", {
                item: {
                  ...item,
                  result: {
                    contentItems: [
                      {
                        type: "inputText",
                        text: `Source ${cell.id} (https://example.com/${cell.id})\nciteturn${round}search${cell.id === "a" ? "1" : "2"} Result.`,
                      },
                    ],
                  },
                },
              });
            }
            for (const cell of finishOrder) {
              const output = {
                type: "function_call_output",
                call_id: `wait-${cell.id}-${round}`,
                output:
                  round === 1
                    ? `Script running with cell ID cell-${cell.id}. Continue with wait.`
                    : `Result ${cell.id}`,
              };
              raw({ ...output, output: "foreign thread" }, { threadId: "other" });
              raw({ ...output, output: "stale turn" }, { turnId: "old" });
              raw(output);
              raw(output);
            }
          }
          await finish();
          expect(parts).toEqual([
            ...yieldOrder.map((cell) => ({
              type: "tool-call",
              toolCallId: `exec-${cell.id}`,
              toolName: cell.name,
              input: `await tools.${cell.name}({})`,
              providerExecuted: true,
            })),
            ...finishOrder.map((cell) => ({
              type: "tool-result",
              toolCallId: `exec-${cell.id}`,
              toolName: cell.name,
              output: {
                contentItems: `Result ${cell.id}`,
                citationSources: [1, 2].map((round) => ({
                  referenceId: `turn${round}search${cell.id === "a" ? "1" : "2"}`,
                  title: `Source ${cell.id}`,
                  url: `https://example.com/${cell.id}`,
                })),
              },
              providerExecuted: true,
            })),
          ]);
        });
      }
    }
  }

  test.each(["completed", "failed", "cancelled", "interrupted"])(
    "ignores later notifications once a turn is %s",
    async (status) => {
      const { emit, router, parts, todos, usages } = createNotificationHarness();
      const completion = router.waitForCompletion().then(
        (turn) => ({ turn }),
        (error: unknown) => ({ error }),
      );
      emit("item/agentMessage/delta", { itemId: "a", delta: "accepted" });
      emit("todoList/updated", { todos: [{ content: "accepted", status: "completed" }] });
      emit("thread/tokenUsage/updated", {
        tokenUsage: { total: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
      });
      const turn = { id: "turn_1", status, items: [], error: { message: "terminal detail" } };
      emit("turn/completed", { turn });

      emit("item/agentMessage/delta", { itemId: "a", delta: " stale" });
      emit("todoList/updated", { todos: [{ content: "stale", status: "in_progress" }] });
      emit("thread/tokenUsage/updated", {
        tokenUsage: { total: { inputTokens: 200, outputTokens: 300, totalTokens: 500 } },
      });
      emit("rawResponseItem/completed", {
        item: { type: "function_call", call_id: "late-wait", name: "wait", arguments: {} },
      });
      emit("turn/completed", { turn: { ...turn, status: "completed" } });

      const outcome = await completion;
      if (status === "completed") expect(outcome).toEqual({ turn });
      else expect(outcome).toEqual({ error: expect.any(Error) });
      expect(router.assistantText()).toBe("accepted");
      expect(parts).toEqual([{ type: "text-delta", id: "a", text: "accepted" }]);
      expect(todos).toEqual([
        [{ content: "accepted", status: "completed", activeForm: "accepted" }],
      ]);
      expect(usages).toEqual([{ promptTokens: 2, completionTokens: 3, totalTokens: 5 }]);
    },
  );

  test("preserves first-seen assistant order across repeated and out-of-order item events", async () => {
    const { emit, finish, router, parts } = createNotificationHarness();
    emit("item/agentMessage/delta", { itemId: "b", delta: "B draft" });
    emit("item/started", { item: { type: "agentMessage", id: "a", text: "A draft" } });
    emit("item/started", { item: { type: "agentMessage", id: "b", text: "duplicate start" } });
    expect(router.assistantText()).toBe("B draft\nA draft");

    emit("item/completed", { item: { type: "agentMessage", id: "a", text: " A final " } });
    emit("item/completed", { item: { type: "agentMessage", id: "b", text: " B final " } });
    emit("item/completed", { item: { type: "agentMessage", id: "c", text: "C final" } });
    emit("item/agentMessage/delta", { itemId: "b", delta: "continued" });
    emit("item/completed", { item: { type: "agentMessage", id: "b", text: "" } });
    await finish();
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
  ])("normalizes and inherits assistant phase $phase", async ({ phase, normalized, text }) => {
    const { emit, finish, router, parts } = createNotificationHarness();
    emit("item/started", { item: { type: "agentMessage", id: "a", phase } });
    emit("item/agentMessage/delta", { itemId: "a", delta: "answer" });
    emit("item/completed", { item: { type: "agentMessage", id: "a", phase, text: "answer" } });
    await finish();
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
  ])("preserves file-change field precedence for $payload", async ({ payload, output }) => {
    const { emit, finish, parts } = createNotificationHarness();
    emit("item/fileChange/patchUpdated", {
      itemId: "patch_1",
      item: { type: "fileChange", patch: "item patch", diff: "item diff" },
      ...payload,
    });
    await finish();
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
