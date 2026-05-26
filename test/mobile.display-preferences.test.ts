import { describe, expect, mock, test } from "bun:test";

mock.restore();

const { filterFeedForDisplay } = await import("../apps/mobile/src/features/cowork/feedDisplay");

import type { SessionFeedItem } from "../apps/mobile/src/features/cowork/protocolTypes";

describe("mobile display preferences", () => {
  test("filterFeedForDisplay hides system and log items by default", () => {
    const feed: SessionFeedItem[] = [
      {
        id: "m1",
        kind: "message",
        role: "user",
        ts: "2024-01-01T00:00:00.000Z",
        text: "hello",
      },
      {
        id: "s1",
        kind: "system",
        ts: "2024-01-01T00:00:01.000Z",
        line: "Observability: enabled=yes",
      },
      {
        id: "l1",
        kind: "log",
        ts: "2024-01-01T00:00:02.000Z",
        line: "debug line",
      },
    ];

    expect(filterFeedForDisplay(feed, false)).toEqual([feed[0]]);
    expect(filterFeedForDisplay(feed, true)).toEqual(feed);
  });

  test("display preference store updates showDebugMessages", async () => {
    mock.restore();
    const { useDisplayPreferencesStore } = await import(
      "../apps/mobile/src/features/preferences/displayPreferencesStore"
    );
    useDisplayPreferencesStore.setState({ showDebugMessages: false, hydrated: true });
    expect(useDisplayPreferencesStore.getState().showDebugMessages).toBe(false);
    useDisplayPreferencesStore.getState().setShowDebugMessages(true);
    expect(useDisplayPreferencesStore.getState().showDebugMessages).toBe(true);
    useDisplayPreferencesStore.setState({ showDebugMessages: false, hydrated: true });
  });
});
