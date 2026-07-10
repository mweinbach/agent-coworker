import { describe, expect, test } from "bun:test";
import {
  buildChatRenderItems,
  parseReasoningSections,
  summarizeActivityGroup,
  unresolvedToolFailureIds,
} from "../apps/mobile/src/features/cowork/activityGroups";
import type { SessionFeedItem } from "../apps/mobile/src/features/cowork/protocolTypes";

describe("mobile chat activity groups", () => {
  test("groups consecutive reasoning and tool items into one activity block", () => {
    const feed: SessionFeedItem[] = [
      {
        id: "m1",
        kind: "message",
        role: "user",
        ts: "2024-01-01T00:00:00.000Z",
        text: "review it",
      },
      {
        id: "r1",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:01.000Z",
        text: "Reviewing the model plan.",
      },
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "read",
        state: "output-available",
        args: { path: "a.ts" },
      },
      {
        id: "m2",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:04.000Z",
        text: "Here is the review.",
      },
    ];

    expect(buildChatRenderItems(feed)).toEqual([
      { kind: "feed-item", item: feed[0] },
      {
        kind: "activity-group",
        id: "activity-r1",
        items: [feed[1], feed[2]],
        recoveredToolIds: [],
      },
      { kind: "feed-item", item: feed[3] },
    ]);
  });

  test("summarizeActivityGroup exposes worked-for elapsed label", () => {
    const items = [
      {
        id: "r1",
        kind: "reasoning" as const,
        mode: "summary" as const,
        ts: "2024-01-01T00:00:00.000Z",
        text: "**Searching for Apple Intelligence features**\nLooking up docs.",
      },
      {
        id: "t1",
        kind: "tool" as const,
        ts: "2024-01-01T00:00:02.000Z",
        completedAt: "2024-01-01T00:00:05.000Z",
        name: "webSearch",
        state: "output-available" as const,
        args: { query: "Apple Intelligence features" },
      },
    ];

    const summary = summarizeActivityGroup(items);
    expect(summary.elapsedLabel).toBe("5s");
    expect(summary.entries).toHaveLength(2);
    expect(summary.status).toBe("done");
  });

  test("matches desktop failure classification for tool results", () => {
    const cases: Array<{
      expectedState: "output-denied" | "output-error";
      name: string;
      result: unknown;
      toolName: string;
    }> = [
      {
        name: "structured ok false",
        toolName: "bash",
        result: { ok: false, message: "command failed" },
        expectedState: "output-error",
      },
      {
        name: "structured error",
        toolName: "read",
        result: { error: "permission denied" },
        expectedState: "output-error",
      },
      {
        name: "structured denial",
        toolName: "bash",
        result: { denied: true },
        expectedState: "output-denied",
      },
      {
        name: "skill not-found string",
        toolName: "skill",
        result: 'Skill "pdf" not found.',
        expectedState: "output-error",
      },
    ];

    for (const testCase of cases) {
      const summary = summarizeActivityGroup([
        {
          id: testCase.name,
          kind: "tool",
          ts: "2024-01-01T00:00:01.000Z",
          name: testCase.toolName,
          state: "output-available",
          result: testCase.result,
        },
      ]);

      expect(summary.status, testCase.name).toBe("issue");
      expect(summary.entries[0]?.kind, testCase.name).toBe("tool");
      expect(
        summary.entries[0]?.kind === "tool" ? summary.entries[0].item.state : null,
        testCase.name,
      ).toBe(testCase.expectedState);
    }
  });

  test("preserves unrelated and repeated same-tool failures without retry lineage", () => {
    const summary = summarizeActivityGroup([
      {
        id: "failed",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "bash",
        state: "output-error",
        args: { command: "bun test" },
        result: { error: "failed" },
      },
      {
        id: "unrelated",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "read",
        state: "output-available",
        result: "ok",
      },
      {
        id: "repeated",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "bash",
        state: "output-available",
        args: { command: "bun test" },
        result: { exitCode: 0 },
      },
    ]);

    expect(summary.status).toBe("issue");
    expect(summary.entries.map((entry) => entry.item.id)).toEqual([
      "failed",
      "unrelated",
      "repeated",
    ]);
  });

  test("coalesces lifecycle updates by stable call id and applies the final error", () => {
    const summary = summarizeActivityGroup([
      {
        id: "tool-call",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "bash",
        state: "input-streaming",
        args: { command: "bun test" },
      },
      {
        id: "tool-call",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "bash",
        state: "output-available",
        result: { exitCode: 0 },
      },
      {
        id: "tool-call",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "bash",
        state: "output-error",
        result: { error: "provider rejected final output" },
      },
    ]);

    expect(summary.status).toBe("issue");
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]).toMatchObject({
      kind: "tool",
      item: {
        id: "tool-call",
        state: "output-error",
        args: { command: "bun test" },
        result: { error: "provider rejected final output" },
        sourceIds: ["tool-call"],
      },
    });
  });

  test("shows recovered failures and keeps the group unresolved until every failure recovers", () => {
    const summary = summarizeActivityGroup([
      {
        id: "failed-one",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "bash",
        state: "output-error",
        args: { command: "bun test one" },
      },
      {
        id: "failed-two",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "read",
        state: "output-error",
        args: { path: "missing.ts" },
      },
      {
        id: "replacement",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "bash",
        state: "output-available",
        args: { command: "bun test one" },
        retryOf: "failed-one",
      },
    ]);

    expect(summary.status).toBe("issue");
    expect(summary.recoveredToolIds).toEqual(["failed-one"]);
    expect(summary.entries.map((entry) => entry.item.id)).toEqual([
      "failed-one",
      "failed-two",
      "replacement",
    ]);
  });

  test("hides the legacy retry transport marker while grouping retry activity", () => {
    const feed: SessionFeedItem[] = [
      {
        id: "failed",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "bash",
        state: "output-error",
        args: { command: "bun test" },
      },
      {
        id: "transport",
        kind: "message",
        role: "user",
        ts: "2024-01-01T00:00:02.000Z",
        text: "[[cowork:hidden-retry-turn]]\nContinue.",
      },
      {
        id: "replacement",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "bash",
        state: "output-available",
        args: { command: "bun test" },
        retryOf: "failed",
      },
    ];

    expect(buildChatRenderItems(feed)).toEqual([
      {
        kind: "activity-group",
        id: "activity-failed",
        items: [feed[0], feed[2]],
        recoveredToolIds: ["failed"],
      },
    ]);
  });

  test("projects recovered status across separate turns", () => {
    const feed: SessionFeedItem[] = [
      {
        id: "failed-one",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "bash",
        state: "output-error",
        args: { command: "bun test one" },
      },
      {
        id: "failed-two",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "read",
        state: "output-denied",
        args: { path: "private.ts" },
      },
      {
        id: "assistant-boundary",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:03.000Z",
        text: "One command failed and one read was denied.",
      },
      {
        id: "retry-turn",
        kind: "message",
        role: "user",
        ts: "2024-01-01T00:00:04.000Z",
        text: "Retry the command.",
      },
      {
        id: "replacement",
        kind: "tool",
        ts: "2024-01-01T00:00:05.000Z",
        name: "bash",
        state: "output-available",
        args: { command: "bun test one" },
        retryOf: "failed-one",
      },
    ];

    const groups = buildChatRenderItems(feed).filter(
      (
        item,
      ): item is Extract<
        ReturnType<typeof buildChatRenderItems>[number],
        { kind: "activity-group" }
      > => item.kind === "activity-group",
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.recoveredToolIds).toEqual(["failed-one"]);
    expect(summarizeActivityGroup(groups[0]!.items, groups[0]!.recoveredToolIds).status).toBe(
      "issue",
    );
    expect(unresolvedToolFailureIds(groups[0]!.items, groups[0]!.recoveredToolIds)).toEqual([
      "failed-two",
    ]);
  });

  test("parseReasoningSections splits bold headings into collapsible sections", () => {
    expect(
      parseReasoningSections(
        "**Searching for Apple Intelligence features**\nThe user wants specifics.\n**Verifying results**\nCross-checking docs.",
      ),
    ).toEqual([
      {
        title: "Searching for Apple Intelligence features",
        body: "The user wants specifics.",
      },
      {
        title: "Verifying results",
        body: "Cross-checking docs.",
      },
    ]);
  });
});
