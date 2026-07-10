import { describe, expect, test } from "bun:test";

import { projectedItemSchema } from "../src/shared/projectedItems";
import { type SessionFeedItem, sessionSnapshotSchema } from "../src/shared/sessionSnapshot";
import { createToolRetryMatcher, resolveToolRetryIntent } from "../src/shared/toolRetry";

const failedTool = (
  id: string,
  name = "bash",
  args: unknown = { command: "bun test" },
): Extract<SessionFeedItem, { kind: "tool" }> => ({
  id,
  kind: "tool",
  ts: "2026-07-10T00:00:00.000Z",
  name,
  state: "output-error",
  args,
  result: { error: "failed" },
});

describe("explicit tool retry lineage", () => {
  test("confirms only an explicitly targeted tool with the same name and canonical args", () => {
    const intent = resolveToolRetryIntent([failedTool("failure")], {
      toolItemIds: ["failure"],
    });

    expect(createToolRetryMatcher(intent).confirm("read", { command: "bun test" })).toBeUndefined();
    expect(
      createToolRetryMatcher(intent).confirm("bash", { command: "bun test --watch" }),
    ).toBeUndefined();

    const matcher = createToolRetryMatcher(intent);
    expect(matcher.confirm("bash", { command: "bun test" })).toBe("failure");
    expect(matcher.confirm("bash", { command: "bun test" })).toBeUndefined();
  });

  test("matches object arguments independent of key order and consumes multiple targets once", () => {
    const intent = resolveToolRetryIntent(
      [
        failedTool("first", "write", { path: "a.ts", content: "one" }),
        failedTool("second", "write", { path: "b.ts", content: "two" }),
      ],
      { toolItemIds: ["first", "second"] },
    );
    const matcher = createToolRetryMatcher(intent);

    expect(matcher.confirm("write", { content: "two", path: "b.ts" })).toBe("second");
    expect(matcher.confirm("write", { content: "one", path: "a.ts" })).toBe("first");
  });

  test("rejects legacy, successful, recovered, and unsafe retry targets", () => {
    expect(() => resolveToolRetryIntent([], { toolItemIds: ["missing"] })).toThrow(
      "not an unresolved failed tool",
    );
    expect(() =>
      resolveToolRetryIntent(
        [{ ...failedTool("success"), state: "output-available", result: { ok: true } }],
        { toolItemIds: ["success"] },
      ),
    ).toThrow("not an unresolved failed tool");
    expect(() =>
      resolveToolRetryIntent(
        [
          failedTool("recovered"),
          {
            id: "retry",
            kind: "tool",
            ts: "2026-07-10T00:00:01.000Z",
            name: "bash",
            state: "output-available",
            args: { command: "bun test" },
            retryOf: "recovered",
          },
        ],
        { toolItemIds: ["recovered"] },
      ),
    ).toThrow("already recovered");
    expect(() =>
      resolveToolRetryIntent(
        [
          {
            ...failedTool("no-args"),
            args: undefined,
          },
        ],
        {
          toolItemIds: ["no-args"],
        },
      ),
    ).toThrow("safely matchable arguments");
  });

  test("lineage is additive for projected items and survives snapshot hydration", () => {
    expect(
      projectedItemSchema.parse({
        id: "replacement",
        type: "toolCall",
        toolName: "bash",
        state: "output-available",
        args: { command: "bun test" },
        retryOf: "failure",
      }),
    ).toMatchObject({ retryOf: "failure" });

    const snapshot = sessionSnapshotSchema.parse({
      sessionId: "session",
      title: "Retry",
      titleSource: "default",
      titleModel: null,
      provider: "anthropic",
      model: "model",
      sessionKind: "root",
      parentSessionId: null,
      role: null,
      mode: null,
      depth: null,
      nickname: null,
      taskType: null,
      targetPaths: null,
      profile: null,
      requestedModel: null,
      effectiveModel: null,
      requestedReasoningEffort: null,
      effectiveReasoningEffort: null,
      executionState: null,
      lastMessagePreview: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      messageCount: 0,
      lastEventSeq: 0,
      feed: [
        failedTool("failure"),
        {
          id: "replacement",
          kind: "tool",
          ts: "2026-07-10T00:00:01.000Z",
          name: "bash",
          state: "output-available",
          args: { command: "bun test" },
          retryOf: "failure",
        },
      ],
      agents: [],
      todos: [],
      sessionUsage: null,
      lastTurnUsage: null,
      hasPendingAsk: false,
      hasPendingApproval: false,
    });

    expect(snapshot.feed[1]).toMatchObject({ retryOf: "failure" });
    const legacy = structuredClone(snapshot);
    if (legacy.feed[1]?.kind === "tool") delete legacy.feed[1].retryOf;
    expect(sessionSnapshotSchema.parse(legacy).feed[1]).not.toHaveProperty("retryOf");
  });
});
