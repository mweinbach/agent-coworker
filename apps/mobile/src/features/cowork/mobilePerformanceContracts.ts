export type MobilePlatformContract = "ios" | "android";
export type MobileListSurface = "thread" | "home";

export type MobileListPerformanceContract = {
  initialNumToRender: number;
  maxToRenderPerBatch: number;
  updateCellsBatchingPeriod: number;
  windowSize: number;
  removeClippedSubviews: boolean;
};

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

const MOBILE_LIST_PERFORMANCE_CONTRACTS: Record<
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
