import { describe, expect, test } from "bun:test";

import type { ProjectedItem as MobileProjectedItem } from "../apps/mobile/src/features/cowork/protocolTypes";
import {
  applyProjectedCompletion,
  createMobileFeedState,
} from "../apps/mobile/src/features/cowork/snapshotReducer";
import { applyProjectedItemCompleted, type ProjectedItem } from "../src/shared/projectedItems";

const provisionalSuccess = {
  id: "tool-call",
  type: "toolCall",
  toolName: "bash",
  state: "output-available",
  args: { command: "bun test" },
  result: { exitCode: 0 },
} as const satisfies ProjectedItem;

const finalError = {
  id: "tool-call",
  type: "toolCall",
  toolName: "bash",
  state: "output-error",
  args: { command: "bun test" },
  result: { error: "provider rejected final output" },
} as const satisfies ProjectedItem;

describe("tool lifecycle reducers", () => {
  test("shared reducer applies the authoritative final state for one stable call id", () => {
    let feed = applyProjectedItemCompleted([], provisionalSuccess, "2024-01-01T00:00:01.000Z");
    feed = applyProjectedItemCompleted(feed, finalError, "2024-01-01T00:00:02.000Z");

    expect(feed).toEqual([
      expect.objectContaining({
        state: "output-error",
        args: { command: "bun test" },
        result: { error: "provider rejected final output" },
      }),
    ]);
  });

  test("mobile reducer applies the authoritative final state for one stable call id", () => {
    let state = createMobileFeedState();
    state = applyProjectedCompletion(
      state,
      provisionalSuccess satisfies MobileProjectedItem,
      "2024-01-01T00:00:01.000Z",
      1,
    );
    state = applyProjectedCompletion(
      state,
      finalError satisfies MobileProjectedItem,
      "2024-01-01T00:00:02.000Z",
      2,
    );

    expect(state.feed).toEqual([
      expect.objectContaining({
        state: "output-error",
        args: { command: "bun test" },
        result: { error: "provider rejected final output" },
      }),
    ]);
  });
});
