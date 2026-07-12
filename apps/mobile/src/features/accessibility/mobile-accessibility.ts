import { type RefObject, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, findNodeHandle, LayoutAnimation, type View } from "react-native";

import { shouldAnimateLayout } from "./mobile-accessibility-policy";

export {
  ANDROID_MINIMUM_TOUCH_TARGET,
  IOS_MINIMUM_TOUCH_TARGET,
  MAX_DYNAMIC_TYPE_MULTIPLIER,
  type MobilePlatform,
  minimumTouchTarget,
  resolveMobilePlatform,
} from "./mobile-accessibility-policy";

export function useReducedMotionEnabled(): boolean {
  const [reducedMotionEnabled, setReducedMotionEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) {
        setReducedMotionEnabled(enabled);
      }
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotionEnabled,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reducedMotionEnabled;
}

export function runAccessibleLayoutAnimation(
  reducedMotionEnabled: boolean,
  configure: () => void = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  },
): boolean {
  if (!shouldAnimateLayout(reducedMotionEnabled)) {
    return false;
  }
  configure();
  return true;
}

export function announceForAccessibility(message: string, queue = true): void {
  if (!message.trim()) {
    return;
  }
  AccessibilityInfo.announceForAccessibilityWithOptions(message, {
    queue,
    priority: "default",
  });
}

export function useAccessibilityAnnouncement(message: string | null): void {
  const previousMessageRef = useRef<string | null>(null);

  useEffect(() => {
    if (!message) {
      previousMessageRef.current = null;
      return;
    }
    if (message === previousMessageRef.current) {
      return;
    }
    previousMessageRef.current = message;
    announceForAccessibility(message);
  }, [message]);
}

export function useAccessibilityFocus<T extends View>(
  focusKey: string | null,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!focusKey) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const handle = findNodeHandle(ref.current);
      if (handle !== null) {
        AccessibilityInfo.setAccessibilityFocus(handle);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey]);

  return ref;
}
