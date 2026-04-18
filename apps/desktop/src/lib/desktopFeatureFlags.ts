import {
  DESKTOP_FEATURE_FLAG_DEFINITIONS,
  DESKTOP_FEATURE_FLAG_IDS,
  normalizeDesktopFeatureFlagOverrides,
  resolveDesktopFeatureFlags as resolveSharedDesktopFeatureFlags,
  type DesktopFeatureFlagId,
  type DesktopFeatureFlagOverrides,
  type DesktopFeatureFlags,
  type ResolveDesktopFeatureFlagsOptions,
} from "../../../../src/shared/featureFlags";

export type {
  DesktopFeatureFlagId,
  DesktopFeatureFlagOverrides,
  DesktopFeatureFlags,
};

export {
  DESKTOP_FEATURE_FLAG_DEFINITIONS,
  DESKTOP_FEATURE_FLAG_IDS,
  normalizeDesktopFeatureFlagOverrides,
};

export function resolveDesktopFeatureFlags(options: ResolveDesktopFeatureFlagsOptions): DesktopFeatureFlags {
  return resolveSharedDesktopFeatureFlags(options);
}
