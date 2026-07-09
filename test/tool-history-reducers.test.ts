import { describe, expect, test } from "bun:test";

import type { ProjectedItem as MobileProjectedItem } from "../apps/mobile/src/features/cowork/protocolTypes";
import {
  applyProjectedCompletion,
  createMobileFeedState,
} from "../apps/mobile/src/features/cowork/snapshotReducer";
import { applyProjectedItemCompleted, type ProjectedItem } from "../src/shared/projectedItems";

const failedTool = {
  id: "tool-call",
  type: "toolCall",
  toolName: "bash",
  state: "output-error",
  result: { error: "failed" },
} as const satisfies ProjectedItem;

const conflictingSuccess = {
  id: "tool-call",
  type: "toolCall",
  toolName: "bash",
  state: "output-available",
  result: { exitCode: 0 },
} as const satisfies ProjectedItem;

describe("tool history reducers", () => {
  test("shared reducer does not rewrite a terminal failure with a conflicting state", () => {
    let feed = applyProjectedItemCompleted([], failedTool, "2024-01-01T00:00:01.000Z");
    feed = applyProjectedItemCompleted(feed, conflictingSuccess, "2024-01-01T00:00:02.000Z");

    expect(feed).toEqual([
      expect.objectContaining({
        state: "output-error",
        result: { error: "failed" },
      }),
    ]);
  });

  test("mobile reducer preserves terminal failures and explicit retry lineage", () => {
    let state = createMobileFeedState();
    state = applyProjectedCompletion(
      state,
      failedTool satisfies MobileProjectedItem,
      "2024-01-01T00:00:01.000Z",
      1,
    );
    state = applyProjectedCompletion(
      state,
      conflictingSuccess satisfies MobileProjectedItem,
      "2024-01-01T00:00:02.000Z",
      2,
    );
    state = applyProjectedCompletion(
      state,
      {
        ...conflictingSuccess,
        id: "tool-retry",
        retryOf: "tool-call",
      } satisfies MobileProjectedItem,
      "2024-01-01T00:00:03.000Z",
      3,
    );

    expect(state.feed[0]).toMatchObject({
      state: "output-error",
      result: { error: "failed" },
    });
    expect(state.feed[1]).toMatchObject({
      state: "output-available",
      retryOf: "tool-call",
    });
  });
});
