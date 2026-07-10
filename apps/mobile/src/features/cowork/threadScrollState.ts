export const THREAD_NEAR_TAIL_THRESHOLD_PX = 96;

export type ThreadScrollState = {
  followTail: boolean;
  unseenKeys: string[];
};

export type ThreadRowRevision = {
  key: string;
  revision: string;
};

type ThreadScrollEvent =
  | {
      type: "user-scroll";
      distanceFromBottom: number;
    }
  | {
      type: "rows-changed";
      changedKeys: readonly string[];
    }
  | {
      type: "jump";
    };

export function initialThreadScrollState(): ThreadScrollState {
  return {
    followTail: true,
    unseenKeys: [],
  };
}

export function reduceThreadScrollState(
  state: ThreadScrollState,
  event: ThreadScrollEvent,
): ThreadScrollState {
  switch (event.type) {
    case "user-scroll": {
      const followTail = event.distanceFromBottom <= THREAD_NEAR_TAIL_THRESHOLD_PX;
      if (followTail) {
        return state.followTail && state.unseenKeys.length === 0
          ? state
          : { followTail: true, unseenKeys: [] };
      }
      return state.followTail ? { ...state, followTail: false } : state;
    }
    case "rows-changed": {
      if (state.followTail || event.changedKeys.length === 0) {
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
      return state.followTail && state.unseenKeys.length === 0
        ? state
        : { followTail: true, unseenKeys: [] };
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
  return state.followTail && turnIsStreaming && changedKeys.length > 0;
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
