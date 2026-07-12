export type MobilePlatform = "ios" | "android";

export const IOS_MINIMUM_TOUCH_TARGET = 44;
export const ANDROID_MINIMUM_TOUCH_TARGET = 48;
export const MAX_DYNAMIC_TYPE_MULTIPLIER = 2;

export function resolveMobilePlatform(platform = process.env.EXPO_OS): MobilePlatform {
  return platform === "ios" ? "ios" : "android";
}

export function minimumTouchTarget(platform = resolveMobilePlatform()): number {
  return platform === "ios" ? IOS_MINIMUM_TOUCH_TARGET : ANDROID_MINIMUM_TOUCH_TARGET;
}

export function shouldAnimateLayout(reducedMotionEnabled: boolean): boolean {
  return !reducedMotionEnabled;
}
