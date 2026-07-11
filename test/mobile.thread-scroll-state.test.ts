import { describe, expect, test } from "bun:test";

import {
  beginThreadProgrammaticMomentum,
  beginThreadProgrammaticScroll,
  finishThreadProgrammaticScroll,
  isThreadProgrammaticScrollActive,
  shouldApplyThreadUserScroll,
} from "../apps/mobile/src/features/cowork/threadProgrammaticScrollGuard";
import {
  changedThreadRows,
  initialThreadScrollState,
  measuredThreadDistanceFromBottom,
  reduceThreadScrollState,
  shouldFollowChangedRows,
} from "../apps/mobile/src/features/cowork/threadScrollState";

describe("mobile thread follow-tail state", () => {
  test("empty-to-hydrated rows do not claim follow-tail before the measured tail", () => {
    const initial = initialThreadScrollState();

    expect(initial.followTail).toBe(false);
    expect(initial.position).toBe("unmeasured");
    expect(
      measuredThreadDistanceFromBottom({
        contentHeight: null,
        offsetY: 0,
        viewportHeight: 720,
      }),
    ).toBeNull();

    const away = reduceThreadScrollState(initial, {
      type: "position-observed",
      distanceFromBottom: 320,
    });
    expect(away.followTail).toBe(false);
    expect(away.position).toBe("away");

    const nearTail = reduceThreadScrollState(away, {
      type: "position-observed",
      distanceFromBottom: 0,
    });
    expect(nearTail.followTail).toBe(true);
    expect(nearTail.position).toBe("near-tail");
  });

  test("follows streaming rows while the user remains pinned", () => {
    const state = reduceThreadScrollState(initialThreadScrollState(), {
      type: "position-observed",
      distanceFromBottom: 0,
    });
    const changedKeys = ["assistant-1"];

    expect(shouldFollowChangedRows(state, changedKeys, true)).toBe(true);
    expect(
      reduceThreadScrollState(state, {
        type: "rows-changed",
        changedKeys,
      }),
    ).toEqual(state);
  });

  test("content growth keeps following the user's measured tail intent", () => {
    const pinned = reduceThreadScrollState(initialThreadScrollState(), {
      type: "position-observed",
      distanceFromBottom: 0,
    });
    const contentGrew = reduceThreadScrollState(pinned, {
      type: "position-observed",
      distanceFromBottom: 120,
    });

    expect(contentGrew.followTail).toBe(false);
    expect(contentGrew.followTailIntent).toBe(true);
    expect(shouldFollowChangedRows(contentGrew, ["assistant-1"], true)).toBe(true);
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
    expect(unpinned.followTailIntent).toBe(false);
    expect(shouldFollowChangedRows(unpinned, ["assistant-1"], true)).toBe(false);
    expect(repeatedDelta.unseenKeys).toEqual(["assistant-1"]);
    expect(nextMessage.unseenKeys).toEqual(["assistant-1", "assistant-2"]);
  });

  test("Jump clears unseen rows but waits for an observed bottom before following", () => {
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

    const jumping = reduceThreadScrollState(unpinned, { type: "jump" });
    expect(jumping).toEqual({
      followTail: false,
      followTailIntent: true,
      position: "unmeasured",
      unseenKeys: [],
    });
    expect(
      reduceThreadScrollState(jumping, {
        type: "position-observed",
        distanceFromBottom: 0,
      }),
    ).toEqual({
      followTail: true,
      followTailIntent: true,
      position: "near-tail",
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
      followTailIntent: true,
      position: "near-tail",
      unseenKeys: [],
    });
  });

  test("completion never forces a pinned or unpinned jump", () => {
    const pinned = reduceThreadScrollState(initialThreadScrollState(), {
      type: "position-observed",
      distanceFromBottom: 0,
    });
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

  test("Android programmatic momentum cannot turn a Jump into user scroll", () => {
    const unpinned = reduceThreadScrollState(initialThreadScrollState(), {
      type: "user-scroll",
      distanceFromBottom: 240,
    });
    let scrollState = reduceThreadScrollState(unpinned, { type: "jump" });
    let guard = beginThreadProgrammaticScroll(true);

    guard = beginThreadProgrammaticMomentum(guard);
    expect(isThreadProgrammaticScrollActive(guard)).toBe(true);
    expect(guard.momentumStarted).toBe(true);
    expect(shouldApplyThreadUserScroll(guard, true)).toBe(false);

    scrollState = reduceThreadScrollState(scrollState, {
      type: "position-observed",
      distanceFromBottom: 240,
    });
    expect(scrollState.followTailIntent).toBe(true);
    expect(scrollState.followTail).toBe(false);

    scrollState = reduceThreadScrollState(scrollState, {
      type: "position-observed",
      distanceFromBottom: 0,
    });
    guard = finishThreadProgrammaticScroll();
    expect(scrollState.followTail).toBe(true);
    expect(scrollState.followTailIntent).toBe(true);
    expect(shouldApplyThreadUserScroll(guard, false)).toBe(false);
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
