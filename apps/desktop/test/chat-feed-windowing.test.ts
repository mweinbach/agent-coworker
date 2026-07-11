import { describe, expect, test } from "bun:test";
import type { FeedItem } from "../src/app/types";
import { selectFeedDerivationWindow } from "../src/ui/chat/feedWindow";

function makeFeed(count: number): FeedItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    kind: "message" as const,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    ts: "2026-07-09T00:00:00.000Z",
    text: `Message ${index + 1}`,
  }));
}

describe("chat feed derivation window", () => {
  test("derives only the newest bounded page for a long transcript", () => {
    const feed = makeFeed(2_000);

    const window = selectFeedDerivationWindow(feed, 80);

    expect(window.hiddenCount).toBe(1_920);
    expect(window.feed).toHaveLength(80);
    expect(window.feed[0]?.id).toBe("message-1921");
    expect(window.feed.at(-1)?.id).toBe("message-2000");
  });

  test("returns the original feed reference once all history is visible", () => {
    const feed = makeFeed(40);

    expect(selectFeedDerivationWindow(feed, 80)).toEqual({
      feed,
      hiddenCount: 0,
    });
    expect(selectFeedDerivationWindow(feed, 80).feed).toBe(feed);
  });
});
