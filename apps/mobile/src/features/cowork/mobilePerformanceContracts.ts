export type MobilePlatformContract = "ios" | "android";
export type MobileListSurface = "thread" | "home";

export type MobileListPerformanceContract = {
  initialNumToRender: number;
  maxToRenderPerBatch: number;
  updateCellsBatchingPeriod: number;
  windowSize: number;
  removeClippedSubviews: boolean;
  maxScheduledRows: number;
};

export const MOBILE_LONG_FIXTURE_SIZE = 1_000;

export const MOBILE_STREAM_PERFORMANCE_BUDGET = {
  deltaEvents: MOBILE_LONG_FIXTURE_SIZE,
  maxRetainedFeedItems: 1,
  maxChangedRowsPerDelta: 1,
  maxNetworkRequests: 0,
} as const;

export const MOBILE_MODEL_MEMORY_BUDGET_BYTES = {
  thread: 512_000,
  home: 768_000,
} as const;

const sharedThreadContract = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 8,
  updateCellsBatchingPeriod: 16,
  windowSize: 7,
  maxScheduledRows: 80,
} as const;

const sharedHomeContract = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 8,
  updateCellsBatchingPeriod: 24,
  windowSize: 7,
  maxScheduledRows: 80,
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

export function maximumScheduledRows(contract: MobileListPerformanceContract): number {
  return contract.initialNumToRender + contract.maxToRenderPerBatch * (contract.windowSize + 1);
}
