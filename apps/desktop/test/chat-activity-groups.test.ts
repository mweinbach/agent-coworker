import { describe, expect, test } from "bun:test";
import { latestTodosFromFeed } from "../src/app/store.helpers/threadEventReducer/feedProjection";
import type { FeedItem } from "../src/app/types";
import {
  buildChatRenderItems,
  latestRetryableActivityGroupId,
  shouldShowWorkingPlaceholder,
  summarizeActivityGroup,
  unresolvedToolFailureIds,
} from "../src/ui/chat/activityGroups";

describe("desktop chat activity groups", () => {
  test("groups consecutive reasoning and tool items into one activity block", () => {
    const feed: FeedItem[] = [
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
        id: "t2",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "grep",
        state: "output-available",
        args: { pattern: "todo" },
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
        items: [feed[1], feed[2], feed[3]],
        recoveredToolIds: [],
      },
      { kind: "feed-item", item: feed[4] },
    ]);
  });

  test("keeps todos out of the transcript so the context sidebar owns plan progress", () => {
    const feed: FeedItem[] = [
      {
        id: "m1",
        kind: "message",
        role: "user",
        ts: "2024-01-01T00:00:00.000Z",
        text: "plan this",
      },
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "todoWrite",
        state: "output-available",
        args: { todos: [{ content: "Ship it", status: "in_progress", activeForm: "Shipping" }] },
      },
      {
        id: "todos1",
        kind: "todos",
        ts: "2024-01-01T00:00:02.000Z",
        todos: [{ content: "Ship it", status: "in_progress", activeForm: "Shipping" }],
      },
      {
        id: "m2",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:03.000Z",
        text: "Working on it.",
      },
    ];

    expect(buildChatRenderItems(feed)).toEqual([
      { kind: "feed-item", item: feed[0] },
      {
        kind: "activity-group",
        id: "activity-t1",
        items: [feed[1]],
        recoveredToolIds: [],
      },
      { kind: "feed-item", item: feed[3] },
    ]);
    expect(latestTodosFromFeed(feed)).toEqual(feed[2]?.kind === "todos" ? feed[2].todos : []);
  });

  test("buildChatRenderItems preserves feed order instead of sorting by timestamps", () => {
    const feed: FeedItem[] = [
      { id: "m1", kind: "message", role: "user", ts: "2024-01-01T00:00:10.000Z", text: "start" },
      {
        id: "r1",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:30.000Z",
        text: "Later timestamp first in the trace.",
      },
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:20.000Z",
        name: "read",
        state: "output-available",
        args: { path: "a.ts" },
      },
      {
        id: "m2",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:05.000Z",
        text: "done",
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

  test("keeps a pending reasoning placeholder before summary text streams", () => {
    const feed: FeedItem[] = [
      {
        id: "m1",
        kind: "message",
        role: "user",
        ts: "2024-01-01T00:00:00.000Z",
        text: "start",
      },
      {
        id: "r-pending",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:01.000Z",
        text: "",
      },
    ];

    expect(buildChatRenderItems(feed)).toEqual([
      { kind: "feed-item", item: feed[0] },
      {
        kind: "activity-group",
        id: "activity-r-pending",
        items: [feed[1]],
        recoveredToolIds: [],
      },
    ]);
  });

  test("pending reasoning placeholders do not add trace rows once real activity arrives", () => {
    const summary = summarizeActivityGroup([
      {
        id: "r-pending",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:01.000Z",
        text: "",
      },
      {
        id: "r-summary",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:02.000Z",
        text: "Checking the source list.",
      },
    ]);

    expect(summary.entries).toHaveLength(1);
    expect(summary.reasoningCount).toBe(1);
    expect(summary.preview).toContain("Checking the source list.");
  });

  test("summary prefers reasoning preview and counts tools", () => {
    const summary = summarizeActivityGroup([
      {
        id: "r1",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:01.000Z",
        text: "Need to validate the tax assumptions before changing EBITDA.",
      },
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "read",
        state: "output-available",
        args: { path: "model.py" },
      },
    ]);

    expect(summary.title).toBe("Thought process");
    expect(summary.preview).toContain("Need to validate the tax assumptions");
    expect(summary.toolCount).toBe(1);
    expect(summary.reasoningCount).toBe(1);
    expect(summary.status).toBe("done");
    expect(summary.statusLabel).toBe("Done");
    expect(summary.elapsedLabel).toBe("1s");
  });

  test("normalizes concatenated Markdown boundaries in the reasoning preview", () => {
    const summary = summarizeActivityGroup([
      {
        id: "r1",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:01.000Z",
        text: "**Filtering the queue****Identifying affected projects**",
      },
    ]);

    expect(summary.preview).toContain("Filtering the queue");
    expect(summary.preview).toContain("Identifying affected projects");
    expect(summary.preview).not.toContain("****");
  });

  test("summary elapsed time floors activity timestamps and ignores invalid values", () => {
    const summary = summarizeActivityGroup([
      {
        id: "r1",
        kind: "reasoning",
        mode: "summary",
        ts: "not-a-date",
        text: "Planning.",
      },
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:00.400Z",
        name: "read",
        state: "output-available",
      },
      {
        id: "t2",
        kind: "tool",
        ts: "2024-01-01T00:02:56.900Z",
        name: "grep",
        state: "output-available",
      },
    ]);

    expect(summary.elapsedLabel).toBe("2m 56s");
  });

  test("summary uses a single tool's completedAt for elapsed time", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:00.000Z",
        completedAt: "2024-01-01T00:00:10.000Z",
        name: "bash",
        state: "output-available",
        result: { exitCode: 0 },
      },
    ]);

    expect(summary.status).toBe("done");
    expect(summary.elapsedLabel).toBe("10s");
  });

  test("summary treats stale input-state tools with results as completed", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:00.000Z",
        name: "todoWrite",
        state: "input-available",
        result: "Todo list updated",
      },
    ]);

    expect(summary.status).toBe("done");
    const entry = summary.entries[0];
    expect(entry?.kind).toBe("tool");
    expect(entry?.kind === "tool" ? entry.item.state : null).toBe("output-available");
  });

  test("summary preview strips a standalone markdown reasoning heading", () => {
    const summary = summarizeActivityGroup([
      {
        id: "r1",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:01.000Z",
        text: "**Planning search strategy**\n\nI need to be careful not to make assumptions.\nI should verify the current product details.",
      },
    ]);

    expect(summary.preview).toContain("I need to be careful not to make assumptions.");
    expect(summary.preview).not.toContain("Planning search strategy");
  });

  test("summary surfaces approval state ahead of completed tools", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "bash",
        state: "output-available",
        args: { cmd: "echo ok" },
      },
      {
        id: "t2",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "bash",
        state: "approval-requested",
        args: { cmd: "rm -rf /tmp/x" },
      },
    ]);

    expect(summary.status).toBe("approval");
    expect(summary.statusLabel).toBe("Needs review");
  });

  test("summary preserves a failure after later same-tool success without retry lineage", () => {
    const summary = summarizeActivityGroup([
      {
        id: "r1",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:01.000Z",
        text: "Fixing the generated script before rerunning it.",
      },
      {
        id: "t-failed",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "commandExecution",
        state: "output-error",
        args: { command: "python3 build_report.py" },
        result: { error: "TypeError: bad argument" },
      },
      {
        id: "t-edit",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "fileChange",
        state: "output-available",
        result: { paths: ["build_report.py"] },
      },
      {
        id: "t-success",
        kind: "tool",
        ts: "2024-01-01T00:00:04.000Z",
        name: "commandExecution",
        state: "output-available",
        args: { command: "python3 build_report.py" },
        result: { exitCode: 0 },
      },
    ]);

    expect(summary.status).toBe("issue");
    expect(summary.statusLabel).toBe("Issue");
    expect(summary.entries.map((entry) => entry.item.id)).toEqual([
      "r1",
      "t-failed",
      "t-edit",
      "t-success",
    ]);
    expect(summary.toolCount).toBe(3);
  });

  test("summary preserves a failed skill lookup when an unrelated tool succeeds", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t-skill",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "skill",
        state: "output-available",
        result: 'Skill "pdf" not found.',
      },
      {
        id: "r-recovery",
        kind: "reasoning",
        mode: "reasoning",
        ts: "2024-01-01T00:00:02.000Z",
        text: "Trying the supported document workflow instead.",
      },
      {
        id: "t-recovery",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "todoWrite",
        state: "output-available",
        result: { count: 3 },
      },
    ]);

    expect(summary.status).toBe("issue");
    expect(summary.entries.map((entry) => entry.item.id)).toEqual([
      "t-skill",
      "r-recovery",
      "t-recovery",
    ]);
    expect(summary.toolCount).toBe(2);
  });

  test("summary keeps unrecovered internal command failures visible", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t-failed",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "commandExecution",
        state: "output-error",
        args: { command: "python3 build_report.py" },
        result: { error: "TypeError: bad argument" },
      },
    ]);

    expect(summary.status).toBe("issue");
    expect(summary.statusLabel).toBe("Issue");
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]?.kind).toBe("tool");
    expect(summary.entries[0]?.kind === "tool" ? summary.entries[0].item.state : null).toBe(
      "output-error",
    );
  });

  test("summary keeps denied tools in issue state ahead of pending approval", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t-denied",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "bash",
        state: "output-denied",
        result: { denied: true },
      },
      {
        id: "t-approval",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "bash",
        state: "approval-requested",
      },
    ]);

    expect(summary.status).toBe("issue");
    expect(summary.statusLabel).toBe("Issue");
    expect(summary.entries).toHaveLength(2);
  });

  test("summary collapses adjacent tool lifecycle updates into one trace row", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "read",
        state: "input-available",
        args: { path: "model.py" },
      },
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "read",
        state: "output-available",
        result: { chars: 655 },
      },
    ]);

    const toolEntries = summary.entries.filter((entry) => entry.kind === "tool");
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]?.item).toMatchObject({
      id: "t1",
      name: "read",
      state: "output-available",
      args: { path: "model.py" },
      result: { chars: 655 },
      sourceIds: ["t1"],
    });
  });

  test("summary keeps back-to-back completed tools as separate trace rows", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "read",
        state: "output-available",
        args: { path: "a.py" },
        result: { chars: 20 },
      },
      {
        id: "t2",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "read",
        state: "output-available",
        args: { path: "b.py" },
        result: { chars: 30 },
      },
    ]);

    const toolEntries = summary.entries.filter((entry) => entry.kind === "tool");
    expect(toolEntries).toHaveLength(2);
    expect(toolEntries.map((entry) => entry.item.sourceIds)).toEqual([["t1"], ["t2"]]);
  });

  test("summary preserves repeated completed tools without shared lifecycle identity", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "bash",
        state: "output-available",
        args: { command: "python3 model.py" },
        result: { exitCode: 0 },
      },
      {
        id: "t2",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "bash",
        state: "output-available",
        args: { command: "python3 model.py" },
        result: { exitCode: 0 },
      },
    ]);

    const toolEntries = summary.entries.filter((entry) => entry.kind === "tool");
    expect(toolEntries).toHaveLength(2);
    expect(toolEntries.map((entry) => entry.item.sourceIds)).toEqual([["t1"], ["t2"]]);
  });

  test("summary preserves richer completed rows with distinct lifecycle identities", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "todoWrite",
        state: "output-available",
      },
      {
        id: "t2",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "todoWrite",
        state: "output-available",
        args: { count: 4 },
        result: { count: 4 },
      },
    ]);

    const toolEntries = summary.entries.filter((entry) => entry.kind === "tool");
    expect(toolEntries).toHaveLength(2);
    expect(toolEntries.map((entry) => entry.item.sourceIds)).toEqual([["t1"], ["t2"]]);
  });

  test("summary preserves compact completed rows with distinct lifecycle identities", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "read",
        state: "output-available",
        args: { filePath: "model.py", offset: 1, limit: 20 },
        result: "line 1\nline 2\nline 3",
      },
      {
        id: "t2",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "read",
        state: "output-available",
        args: { filePath: "model.py", offset: 1, limit: 20 },
        result: { chars: 18 },
      },
    ]);

    const toolEntries = summary.entries.filter((entry) => entry.kind === "tool");
    expect(toolEntries).toHaveLength(2);
    expect(toolEntries.map((entry) => entry.item.sourceIds)).toEqual([["t1"], ["t2"]]);
  });

  test("summary applies an authoritative final error to the same stable call id", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "bash",
        state: "output-available",
        result: { exitCode: 0 },
      },
      {
        id: "t1",
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
        id: "t1",
        state: "output-error",
        result: { error: "provider rejected final output" },
        sourceIds: ["t1"],
      },
    });
  });

  test("summary preserves mixed reasoning and tool chronology", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "read",
        state: "output-available",
        args: { path: "a.ts" },
      },
      {
        id: "r1",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:02.000Z",
        text: "Inspecting the file first.",
      },
      {
        id: "t2",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "grep",
        state: "output-available",
        args: { pattern: "TODO" },
      },
      {
        id: "t3",
        kind: "tool",
        ts: "2024-01-01T00:00:04.000Z",
        name: "glob",
        state: "output-available",
        args: { pattern: "**/*.ts" },
      },
      {
        id: "r2",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:05.000Z",
        text: "Now summarizing findings.",
      },
    ]);

    expect(summary.entries.map((entry) => entry.kind)).toEqual([
      "tool",
      "reasoning",
      "tool",
      "tool",
      "reasoning",
    ]);
  });

  test("summary collapses adjacent duplicate reasoning notes", () => {
    const summary = summarizeActivityGroup([
      {
        id: "r1",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:01.000Z",
        text: "Inspecting files.",
      },
      {
        id: "r2",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:02.000Z",
        text: "Inspecting files.\n",
      },
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "read",
        state: "output-available",
        args: { path: "a.ts" },
      },
      {
        id: "r3",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:04.000Z",
        text: "Summarizing findings.",
      },
    ]);

    expect(
      summary.entries.map((entry) => (entry.kind === "reasoning" ? entry.item.id : entry.item.id)),
    ).toEqual(["r1", "t1", "r3"]);
    expect(summary.reasoningCount).toBe(2);
  });

  test("reasoning boundaries prevent tool merges across the gap", () => {
    const summary = summarizeActivityGroup([
      {
        id: "t1",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "read",
        state: "output-available",
        args: { path: "a.ts" },
        result: { chars: 10 },
      },
      {
        id: "r1",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:02.000Z",
        text: "Need one more pass.",
      },
      {
        id: "t2",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "read",
        state: "output-available",
        args: { path: "a.ts" },
        result: { chars: 10 },
      },
    ]);

    const toolEntries = summary.entries.filter((entry) => entry.kind === "tool");
    expect(toolEntries).toHaveLength(2);
    expect(toolEntries.map((entry) => entry.item.sourceIds)).toEqual([["t1"], ["t2"]]);
  });

  test("explicit successful retry keeps both calls visible and resolves the targeted failure", () => {
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
        id: "replacement",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "bash",
        state: "output-available",
        args: { command: "bun test" },
        result: { exitCode: 0 },
        retryOf: "failed",
      },
    ]);

    expect(summary.status).toBe("done");
    expect(summary.recoveredToolIds).toEqual(["failed"]);
    expect(summary.entries.map((entry) => entry.item.id)).toEqual(["failed", "replacement"]);
  });

  test("a later successful attempt recovers failed descendants in the same retry chain", () => {
    const summary = summarizeActivityGroup([
      {
        id: "original",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "bash",
        state: "output-error",
        result: { error: "failed" },
      },
      {
        id: "failed-retry",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "bash",
        state: "output-error",
        result: { error: "failed again" },
        retryOf: "original",
      },
      {
        id: "successful-retry",
        kind: "tool",
        ts: "2024-01-01T00:00:03.000Z",
        name: "bash",
        state: "output-available",
        result: { ok: true },
        retryOf: "original",
      },
    ]);

    expect(summary.status).toBe("done");
    expect(summary.recoveredToolIds).toEqual(["original", "failed-retry"]);
    expect(summary.entries.map((entry) => entry.item.id)).toEqual([
      "original",
      "failed-retry",
      "successful-retry",
    ]);
  });

  test("one successful retry leaves another failure unresolved", () => {
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
        name: "bash",
        state: "output-error",
        args: { command: "bun test two" },
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
  });

  test("projects recovery across turn boundaries without deleting either call", () => {
    const feed: FeedItem[] = [
      {
        id: "failed",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "bash",
        state: "output-error",
        args: { command: "bun test" },
      },
      {
        id: "assistant-boundary",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:02.000Z",
        text: "The command failed.",
      },
      {
        id: "retry-turn",
        kind: "message",
        role: "user",
        ts: "2024-01-01T00:00:03.000Z",
        text: "Retry it.",
      },
      {
        id: "replacement",
        kind: "tool",
        ts: "2024-01-01T00:00:04.000Z",
        name: "bash",
        state: "output-available",
        args: { command: "bun test" },
        retryOf: "failed",
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
    expect(groups[0]?.recoveredToolIds).toEqual(["failed"]);
    expect(summarizeActivityGroup(groups[0]!.items, groups[0]!.recoveredToolIds).status).toBe(
      "done",
    );
    expect(unresolvedToolFailureIds(groups[0]!.items, groups[0]!.recoveredToolIds)).toEqual([]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["failed"]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(["replacement"]);
  });

  test("targets the latest unresolved group past a trailing assistant explanation", () => {
    const feed: FeedItem[] = [
      {
        id: "user",
        kind: "message",
        role: "user",
        ts: "2024-01-01T00:00:00.000Z",
        text: "Run the tests.",
      },
      {
        id: "failed",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "bash",
        state: "output-error",
        result: { error: "failed" },
      },
      {
        id: "explanation",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:02.000Z",
        text: "The test command failed.",
      },
    ];

    expect(latestRetryableActivityGroupId(buildChatRenderItems(feed))).toBe("activity-failed");
    expect(
      latestRetryableActivityGroupId(
        buildChatRenderItems([
          ...feed,
          {
            id: "new-user-turn",
            kind: "message",
            role: "user",
            ts: "2024-01-01T00:00:03.000Z",
            text: "Do something else.",
          },
        ]),
      ),
    ).toBeNull();
  });
});

describe("shouldShowWorkingPlaceholder", () => {
  const userMessage: FeedItem = {
    id: "m1",
    kind: "message",
    role: "user",
    ts: "2024-01-01T00:00:00.000Z",
    text: "hello",
  };
  const assistantMessage: FeedItem = {
    id: "m2",
    kind: "message",
    role: "assistant",
    ts: "2024-01-01T00:00:01.000Z",
    text: "Hi!",
  };
  const reasoningItem: FeedItem = {
    id: "r1",
    kind: "reasoning",
    mode: "summary",
    ts: "2024-01-01T00:00:01.000Z",
    text: "Thinking about it.",
  };

  test("shows while a busy turn has produced no output after the user message", () => {
    const renderItems = buildChatRenderItems([userMessage]);
    expect(shouldShowWorkingPlaceholder({ busy: true, turnStartPending: false, renderItems })).toBe(
      true,
    );
  });

  test("shows while the turn start is still pending", () => {
    const renderItems = buildChatRenderItems([userMessage]);
    expect(shouldShowWorkingPlaceholder({ busy: false, turnStartPending: true, renderItems })).toBe(
      true,
    );
  });

  test("hides once a reasoning/tool activity group exists", () => {
    const renderItems = buildChatRenderItems([userMessage, reasoningItem]);
    expect(shouldShowWorkingPlaceholder({ busy: true, turnStartPending: false, renderItems })).toBe(
      false,
    );
  });

  test("hides once assistant text starts streaming", () => {
    const renderItems = buildChatRenderItems([userMessage, assistantMessage]);
    expect(shouldShowWorkingPlaceholder({ busy: true, turnStartPending: false, renderItems })).toBe(
      false,
    );
  });

  test("hides when the thread is idle", () => {
    const renderItems = buildChatRenderItems([userMessage]);
    expect(
      shouldShowWorkingPlaceholder({ busy: false, turnStartPending: false, renderItems }),
    ).toBe(false);
  });

  test("hides on an empty feed", () => {
    expect(
      shouldShowWorkingPlaceholder({ busy: true, turnStartPending: false, renderItems: [] }),
    ).toBe(false);
  });

  test("skips log and system lines when deciding", () => {
    const renderItems = buildChatRenderItems([
      userMessage,
      { id: "l1", kind: "log", ts: "2024-01-01T00:00:01.000Z", line: "[MCP] server connected" },
      { id: "s1", kind: "system", ts: "2024-01-01T00:00:02.000Z", line: "Model changed" },
    ]);
    expect(shouldShowWorkingPlaceholder({ busy: true, turnStartPending: false, renderItems })).toBe(
      true,
    );
  });

  test("shows again for a steer message sent mid-turn", () => {
    const renderItems = buildChatRenderItems([
      userMessage,
      assistantMessage,
      { ...userMessage, id: "m3", ts: "2024-01-01T00:00:02.000Z", text: "also do this" },
    ]);
    expect(shouldShowWorkingPlaceholder({ busy: true, turnStartPending: false, renderItems })).toBe(
      true,
    );
  });
});
