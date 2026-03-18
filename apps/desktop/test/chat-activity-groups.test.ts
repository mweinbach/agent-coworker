import { describe, expect, test } from "bun:test";

import type { FeedItem } from "../src/app/types";
import { buildChatRenderItems, summarizeActivityGroup } from "../src/ui/chat/activityGroups";

describe("desktop chat activity groups", () => {
  test("groups consecutive reasoning and tool items into one activity block", () => {
    const feed: FeedItem[] = [
      { id: "m1", kind: "message", role: "user", ts: "2024-01-01T00:00:00.000Z", text: "review it" },
      { id: "r1", kind: "reasoning", mode: "summary", ts: "2024-01-01T00:00:01.000Z", text: "Reviewing the model plan." },
      { id: "t1", kind: "tool", ts: "2024-01-01T00:00:02.000Z", name: "read", state: "output-available", args: { path: "a.ts" } },
      { id: "t2", kind: "tool", ts: "2024-01-01T00:00:03.000Z", name: "grep", state: "output-available", args: { pattern: "todo" } },
      { id: "m2", kind: "message", role: "assistant", ts: "2024-01-01T00:00:04.000Z", text: "Here is the review." },
    ];

    expect(buildChatRenderItems(feed)).toEqual([
      { kind: "feed-item", item: feed[0] },
      { kind: "activity-group", id: "activity-r1", items: [feed[1], feed[2], feed[3]] },
      { kind: "feed-item", item: feed[4] },
    ]);
  });

  test("buildChatRenderItems preserves feed order instead of sorting by timestamps", () => {
    const feed: FeedItem[] = [
      { id: "m1", kind: "message", role: "user", ts: "2024-01-01T00:00:10.000Z", text: "start" },
      { id: "r1", kind: "reasoning", mode: "summary", ts: "2024-01-01T00:00:30.000Z", text: "Later timestamp first in the trace." },
      { id: "t1", kind: "tool", ts: "2024-01-01T00:00:20.000Z", name: "read", state: "output-available", args: { path: "a.ts" } },
      { id: "m2", kind: "message", role: "assistant", ts: "2024-01-01T00:00:05.000Z", text: "done" },
    ];

    expect(buildChatRenderItems(feed)).toEqual([
      { kind: "feed-item", item: feed[0] },
      { kind: "activity-group", id: "activity-r1", items: [feed[1], feed[2]] },
      { kind: "feed-item", item: feed[3] },
    ]);
  });

  test("summary prefers reasoning preview and counts tools", () => {
    const summary = summarizeActivityGroup([
      { id: "r1", kind: "reasoning", mode: "summary", ts: "2024-01-01T00:00:01.000Z", text: "Need to validate the tax assumptions before changing EBITDA." },
      { id: "t1", kind: "tool", ts: "2024-01-01T00:00:02.000Z", name: "read", state: "output-available", args: { path: "model.py" } },
    ]);

    expect(summary.title).toBe("Thought process");
    expect(summary.preview).toContain("Need to validate the tax assumptions");
    expect(summary.toolCount).toBe(1);
    expect(summary.reasoningCount).toBe(1);
    expect(summary.status).toBe("done");
    expect(summary.statusLabel).toBe("Done");
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
      { id: "t1", kind: "tool", ts: "2024-01-01T00:00:02.000Z", name: "bash", state: "output-available", args: { cmd: "echo ok" } },
      { id: "t2", kind: "tool", ts: "2024-01-01T00:00:03.000Z", name: "bash", state: "approval-requested", args: { cmd: "rm -rf /tmp/x" } },
    ]);

    expect(summary.status).toBe("approval");
    expect(summary.statusLabel).toBe("Needs review");
  });

  test("summary collapses adjacent tool lifecycle updates into one trace row", () => {
    const summary = summarizeActivityGroup([
      { id: "t1", kind: "tool", ts: "2024-01-01T00:00:02.000Z", name: "read", state: "input-available", args: { path: "model.py" } },
      { id: "t2", kind: "tool", ts: "2024-01-01T00:00:03.000Z", name: "read", state: "output-available", result: { chars: 655 } },
    ]);

    const toolEntries = summary.entries.filter((entry) => entry.kind === "tool");
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]?.item).toMatchObject({
      id: "t1",
      name: "read",
      state: "output-available",
      args: { path: "model.py" },
      result: { chars: 655 },
      sourceIds: ["t1", "t2"],
    });
  });

  test("summary keeps back-to-back completed tools as separate trace rows", () => {
    const summary = summarizeActivityGroup([
      { id: "t1", kind: "tool", ts: "2024-01-01T00:00:02.000Z", name: "read", state: "output-available", args: { path: "a.py" }, result: { chars: 20 } },
      { id: "t2", kind: "tool", ts: "2024-01-01T00:00:03.000Z", name: "read", state: "output-available", args: { path: "b.py" }, result: { chars: 30 } },
    ]);

    const toolEntries = summary.entries.filter((entry) => entry.kind === "tool");
    expect(toolEntries).toHaveLength(2);
    expect(toolEntries.map((entry) => entry.item.sourceIds)).toEqual([["t1"], ["t2"]]);
  });

  test("summary merges adjacent duplicate completed tool rows with identical args and result", () => {
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
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]?.item.sourceIds).toEqual(["t1", "t2"]);
  });

  test("summary merges a generic completed row with a richer adjacent completed row for the same tool", () => {
    const summary = summarizeActivityGroup([
      { id: "t1", kind: "tool", ts: "2024-01-01T00:00:02.000Z", name: "todoWrite", state: "output-available" },
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
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]?.item).toMatchObject({
      id: "t1",
      name: "todoWrite",
      state: "output-available",
      args: { count: 4 },
      result: { count: 4 },
      sourceIds: ["t1", "t2"],
    });
  });

  test("summary merges a verbose string result with a compact summary result for the same tool call", () => {
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
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]?.item).toMatchObject({
      id: "t1",
      name: "read",
      state: "output-available",
      args: { filePath: "model.py", offset: 1, limit: 20 },
      result: { chars: 18 },
      sourceIds: ["t1", "t2"],
    });
  });

  test("summary preserves mixed reasoning and tool chronology", () => {
    const summary = summarizeActivityGroup([
      { id: "t1", kind: "tool", ts: "2024-01-01T00:00:01.000Z", name: "read", state: "output-available", args: { path: "a.ts" } },
      { id: "r1", kind: "reasoning", mode: "summary", ts: "2024-01-01T00:00:02.000Z", text: "Inspecting the file first." },
      { id: "t2", kind: "tool", ts: "2024-01-01T00:00:03.000Z", name: "grep", state: "output-available", args: { pattern: "TODO" } },
      { id: "t3", kind: "tool", ts: "2024-01-01T00:00:04.000Z", name: "glob", state: "output-available", args: { pattern: "**/*.ts" } },
      { id: "r2", kind: "reasoning", mode: "summary", ts: "2024-01-01T00:00:05.000Z", text: "Now summarizing findings." },
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
      { id: "r1", kind: "reasoning", mode: "summary", ts: "2024-01-01T00:00:01.000Z", text: "Inspecting files." },
      { id: "r2", kind: "reasoning", mode: "summary", ts: "2024-01-01T00:00:02.000Z", text: "Inspecting files.\n" },
      { id: "t1", kind: "tool", ts: "2024-01-01T00:00:03.000Z", name: "read", state: "output-available", args: { path: "a.ts" } },
      { id: "r3", kind: "reasoning", mode: "summary", ts: "2024-01-01T00:00:04.000Z", text: "Summarizing findings." },
    ]);

    expect(summary.entries.map((entry) => entry.kind === "reasoning" ? entry.item.id : entry.item.id)).toEqual([
      "r1",
      "t1",
      "r3",
    ]);
    expect(summary.reasoningCount).toBe(2);
  });

  test("reasoning boundaries prevent tool merges across the gap", () => {
    const summary = summarizeActivityGroup([
      { id: "t1", kind: "tool", ts: "2024-01-01T00:00:01.000Z", name: "read", state: "output-available", args: { path: "a.ts" }, result: { chars: 10 } },
      { id: "r1", kind: "reasoning", mode: "summary", ts: "2024-01-01T00:00:02.000Z", text: "Need one more pass." },
      { id: "t2", kind: "tool", ts: "2024-01-01T00:00:03.000Z", name: "read", state: "output-available", args: { path: "a.ts" }, result: { chars: 10 } },
    ]);

    const toolEntries = summary.entries.filter((entry) => entry.kind === "tool");
    expect(toolEntries).toHaveLength(2);
    expect(toolEntries.map((entry) => entry.item.sourceIds)).toEqual([["t1"], ["t2"]]);
  });
});
