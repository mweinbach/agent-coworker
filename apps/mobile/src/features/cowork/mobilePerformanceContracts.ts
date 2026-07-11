export type MobilePlatformContract = "ios" | "android";
export type MobileListSurface = "thread" | "home";

export type MobileListPerformanceContract = {
  initialNumToRender: number;
  maxToRenderPerBatch: number;
  updateCellsBatchingPeriod: number;
  windowSize: number;
  removeClippedSubviews: boolean;
};

export const MOBILE_LONG_FIXTURE_SIZE = 1_000;
export const MOBILE_PROFILED_ROW_WINDOW = 40;

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

const sharedThreadContract = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 8,
  updateCellsBatchingPeriod: 16,
  windowSize: 7,
} as const;

const sharedHomeContract = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 8,
  updateCellsBatchingPeriod: 24,
  windowSize: 7,
} as const;

export const MOBILE_LIST_PERFORMANCE_CONTRACTS: Record<
  MobilePlatformContract,
  Record<MobileListSurface, MobileListPerformanceContract>
> = {
  ios: {
    thread: {
      ...sharedThreadContract,
      removeClippedSubviews: false,
    },
    home: {
      ...sharedHomeContract,
      removeClippedSubviews: false,
    },
  },
  android: {
    thread: {
      ...sharedThreadContract,
      removeClippedSubviews: true,
    },
    home: {
      ...sharedHomeContract,
      removeClippedSubviews: true,
    },
  },
};

export function getMobileListPerformanceContract(
  platform: MobilePlatformContract,
  surface: MobileListSurface,
): MobileListPerformanceContract {
  return MOBILE_LIST_PERFORMANCE_CONTRACTS[platform][surface];
}
