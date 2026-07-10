import { describe, expect, test } from "bun:test";

import {
  changedThreadRows,
  initialThreadScrollState,
  reduceThreadScrollState,
  shouldFollowChangedRows,
} from "../apps/mobile/src/features/cowork/threadScrollState";

describe("mobile thread follow-tail state", () => {
  test("follows streaming rows while the user remains pinned", () => {
    const state = initialThreadScrollState();
    const changedKeys = ["assistant-1"];

    expect(shouldFollowChangedRows(state, changedKeys, true)).toBe(true);
    expect(
      reduceThreadScrollState(state, {
        type: "rows-changed",
        changedKeys,
      }),
    ).toEqual(state);
  });

  test("scrolling away freezes follow-tail and counts distinct unseen rows", () => {
    const unpinned = reduceThreadScrollState(initialThreadScrollState(), {
      type: "user-scroll",
      distanceFromBottom: 240,
    });
    const firstDelta = reduceThreadScrollState(unpinned, {
      type: "rows-changed",
      changedKeys: ["assistant-1"],
    });
    const repeatedDelta = reduceThreadScrollState(firstDelta, {
      type: "rows-changed",
      changedKeys: ["assistant-1"],
    });
    const nextMessage = reduceThreadScrollState(repeatedDelta, {
      type: "rows-changed",
      changedKeys: ["assistant-2"],
    });

    expect(unpinned.followTail).toBe(false);
    expect(shouldFollowChangedRows(unpinned, ["assistant-1"], true)).toBe(false);
    expect(repeatedDelta.unseenKeys).toEqual(["assistant-1"]);
    expect(nextMessage.unseenKeys).toEqual(["assistant-1", "assistant-2"]);
  });

  test("Jump clears unseen rows and resumes following", () => {
    const unpinned = reduceThreadScrollState(
      reduceThreadScrollState(initialThreadScrollState(), {
        type: "user-scroll",
        distanceFromBottom: 240,
      }),
      {
        type: "rows-changed",
        changedKeys: ["assistant-1", "activity-1"],
      },
    );

    expect(reduceThreadScrollState(unpinned, { type: "jump" })).toEqual({
      followTail: true,
      unseenKeys: [],
    });
  });

  test("returning near the tail is a user-controlled resume", () => {
    const unpinned = reduceThreadScrollState(initialThreadScrollState(), {
      type: "user-scroll",
      distanceFromBottom: 240,
    });
    const nearTail = reduceThreadScrollState(unpinned, {
      type: "user-scroll",
      distanceFromBottom: 72,
    });

    expect(nearTail).toEqual({
      followTail: true,
      unseenKeys: [],
    });
  });

  test("completion never forces a pinned or unpinned jump", () => {
    const pinned = initialThreadScrollState();
    const unpinned = reduceThreadScrollState(pinned, {
      type: "user-scroll",
      distanceFromBottom: 240,
    });

    expect(shouldFollowChangedRows(pinned, ["activity-1"], false)).toBe(false);
    expect(shouldFollowChangedRows(unpinned, ["activity-1"], false)).toBe(false);
    expect(
      reduceThreadScrollState(unpinned, {
        type: "rows-changed",
        changedKeys: ["activity-1"],
      }).followTail,
    ).toBe(false);
  });

  test("detects only inserted or revised rows", () => {
    const previous = [
      { key: "user-1", revision: "hello" },
      { key: "assistant-1", revision: "draft" },
    ];
    const next = [
      { key: "user-1", revision: "hello" },
      { key: "assistant-1", revision: "complete" },
      { key: "activity-1", revision: "running" },
    ];

    expect(changedThreadRows(previous, next)).toEqual(["assistant-1", "activity-1"]);
  });
});
