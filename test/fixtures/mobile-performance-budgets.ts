// Long-list and runtime profiling budgets for the mobile performance tests.
export const MOBILE_LONG_FIXTURE_SIZE = 1_000;
const MOBILE_PROFILED_ROW_WINDOW = 40;

export const MOBILE_STREAM_PERFORMANCE_BUDGET = {
  deltaEvents: MOBILE_LONG_FIXTURE_SIZE,
  maxRetainedFeedItems: 1,
  maxChangedRowsPerDelta: 1,
  maxNetworkRequests: 0,
} as const;

export const MOBILE_RUNTIME_PROFILE_BUDGET = {
  profiledRowWindow: MOBILE_PROFILED_ROW_WINDOW,
  expectedUpdateCommits: MOBILE_LONG_FIXTURE_SIZE,
  maxRowRenders: MOBILE_LONG_FIXTURE_SIZE + MOBILE_PROFILED_ROW_WINDOW,
  frameDurationMs: 1_000 / 60,
  maxFrameBudgetMisses: 10,
  maxTotalUpdateCommitDurationMs: 1_500,
  maxLongFixtureHeapBytes: 96 * 1024 * 1024,
  maxStreamingHeapBytes: 112 * 1024 * 1024,
  maxStreamingHeapGrowthBytes: 48 * 1024 * 1024,
  maxNetworkRequests: 0,
} as const;
