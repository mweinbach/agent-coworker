export const THREAD_NEAR_TAIL_THRESHOLD_PX = 96;

export type ThreadTailPosition = "unmeasured" | "near-tail" | "away";

export type ThreadScrollState = {
  followTail: boolean;
  followTailIntent: boolean;
  position: ThreadTailPosition;
  unseenKeys: string[];
};

export type ThreadRowRevision = {
  key: string;
  revision: string;
};

export type ThreadScrollMetrics = {
  contentHeight: number | null;
  offsetY: number;
  viewportHeight: number | null;
};

export type ThreadScrollEvent =
  | {
      type: "user-scroll";
      distanceFromBottom: number;
    }
  | {
      type: "rows-changed";
      changedKeys: readonly string[];
    }
  | {
      type: "position-observed";
      distanceFromBottom: number;
    }
  | {
      type: "jump";
    };

export function initialThreadScrollState(): ThreadScrollState {
  return {
    followTail: false,
    followTailIntent: true,
    position: "unmeasured",
    unseenKeys: [],
  };
}

export function measuredThreadDistanceFromBottom(metrics: ThreadScrollMetrics): number | null {
  if (
    metrics.contentHeight === null ||
    metrics.viewportHeight === null ||
    metrics.viewportHeight <= 0
  ) {
    return null;
  }
  return Math.max(0, metrics.contentHeight - metrics.viewportHeight - metrics.offsetY);
}

export function reduceThreadScrollState(
  state: ThreadScrollState,
  event: ThreadScrollEvent,
): ThreadScrollState {
  switch (event.type) {
    case "user-scroll": {
      const followTail = event.distanceFromBottom <= THREAD_NEAR_TAIL_THRESHOLD_PX;
      if (followTail) {
        return state.followTail &&
          state.followTailIntent &&
          state.position === "near-tail" &&
          state.unseenKeys.length === 0
          ? state
          : {
              followTail: true,
              followTailIntent: true,
              position: "near-tail",
              unseenKeys: [],
            };
      }
      return !state.followTail && !state.followTailIntent && state.position === "away"
        ? state
        : {
            ...state,
            followTail: false,
            followTailIntent: false,
            position: "away",
          };
    }
    case "position-observed": {
      const position: ThreadTailPosition =
        event.distanceFromBottom <= THREAD_NEAR_TAIL_THRESHOLD_PX ? "near-tail" : "away";
      const followTail = position === "near-tail" && state.followTailIntent;
      if (
        state.followTail === followTail &&
        state.position === position &&
        (!followTail || state.unseenKeys.length === 0)
      ) {
        return state;
      }
      return {
        ...state,
        followTail,
        position,
        unseenKeys: followTail ? [] : state.unseenKeys,
      };
    }
    case "rows-changed": {
      if (
        state.followTail ||
        (state.followTailIntent && state.position === "unmeasured") ||
        event.changedKeys.length === 0
      ) {
        return state;
      }
      const unseenKeys = new Set(state.unseenKeys);
      for (const key of event.changedKeys) {
        unseenKeys.add(key);
      }
      if (unseenKeys.size === state.unseenKeys.length) {
        return state;
      }
      return {
        ...state,
        unseenKeys: [...unseenKeys],
      };
    }
    case "jump":
      return state.followTail &&
        state.followTailIntent &&
        state.position === "near-tail" &&
        state.unseenKeys.length === 0
        ? state
        : {
            followTail: false,
            followTailIntent: true,
            position: "unmeasured",
            unseenKeys: [],
          };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function shouldFollowChangedRows(
  state: ThreadScrollState,
  changedKeys: readonly string[],
  turnIsStreaming: boolean,
): boolean {
  return (
    state.followTailIntent &&
    state.position !== "unmeasured" &&
    turnIsStreaming &&
    changedKeys.length > 0
  );
}

export function changedThreadRows(
  previous: readonly ThreadRowRevision[],
  next: readonly ThreadRowRevision[],
): string[] {
  const previousRevisions = new Map(previous.map((row) => [row.key, row.revision]));
  const changed: string[] = [];
  for (const row of next) {
    if (previousRevisions.get(row.key) !== row.revision) {
      changed.push(row.key);
    }
  }
  return changed;
}
