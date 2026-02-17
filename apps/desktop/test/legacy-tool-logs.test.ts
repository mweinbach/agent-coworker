import { describe, expect, test } from "bun:test";

import type { FeedItem } from "../src/app/types";
import { normalizeFeedForToolCards, parseLegacyToolLogLine } from "../src/ui/chat/toolCards/legacyToolLogs";

describe("legacy tool log normalization", () => {
  test("parses legacy tool start/end log lines", () => {
    expect(parseLegacyToolLogLine("tool> bash {\"command\":\"echo hi\"}")).toEqual({
      direction: "start",
      name: "bash",
      payload: { command: "echo hi" },
    });

    expect(parseLegacyToolLogLine("tool< bash {\"stdout\":\"hi\"}")).toEqual({
      direction: "finish",
      name: "bash",
      payload: { stdout: "hi" },
    });
  });

  test("pairs tool start/end logs into a single done tool card item in non-developer mode", () => {
    const feed: FeedItem[] = [
      { id: "m1", kind: "message", role: "user", ts: "2026-01-01T00:00:00.000Z", text: "hi" },
      { id: "l1", kind: "log", ts: "2026-01-01T00:00:01.000Z", line: "tool> bash {\"command\":\"echo hi\"}" },
      { id: "l2", kind: "log", ts: "2026-01-01T00:00:02.000Z", line: "tool< bash {\"stdout\":\"hi\"}" },
    ];

    expect(normalizeFeedForToolCards(feed, false)).toEqual([
      { id: "m1", kind: "message", role: "user", ts: "2026-01-01T00:00:00.000Z", text: "hi" },
      {
        id: "l1",
        kind: "tool",
        ts: "2026-01-01T00:00:01.000Z",
        name: "bash",
        status: "done",
        args: { command: "echo hi" },
        result: { stdout: "hi" },
      },
    ]);
  });

  test("does not normalize logs when developer mode is enabled", () => {
    const feed: FeedItem[] = [
      { id: "l1", kind: "log", ts: "2026-01-01T00:00:01.000Z", line: "tool> bash {\"command\":\"echo hi\"}" },
      { id: "l2", kind: "log", ts: "2026-01-01T00:00:02.000Z", line: "plain line" },
    ];
    expect(normalizeFeedForToolCards(feed, true)).toEqual(feed);
  });
});
