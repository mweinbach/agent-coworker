import { describe, expect, test } from "bun:test";
import { composeFeedItemUpdates } from "../src/app/store.helpers/threadEventReducer/feedProjection";
import type { FeedItem } from "../src/app/types";

describe("model-stream feed update coalescing", () => {
  test("preserves an earlier text delta when a later update adds annotations", () => {
    const item: FeedItem = {
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      ts: "2026-07-09T00:00:00.000Z",
      text: "Hello",
    };
    const update = composeFeedItemUpdates(
      (current) =>
        current.kind === "message" ? { ...current, text: `${current.text} world` } : current,
      (current) =>
        current.kind === "message"
          ? { ...current, annotations: [{ type: "citation", url: "https://example.com" }] }
          : current,
    );

    expect(update(item)).toEqual({
      ...item,
      text: "Hello world",
      annotations: [{ type: "citation", url: "https://example.com" }],
    });
  });
});
