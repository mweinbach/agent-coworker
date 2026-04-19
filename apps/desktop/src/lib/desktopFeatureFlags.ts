import {
  FEATURE_FLAG_DEFINITIONS,
  FEATURE_FLAG_IDS,
  normalizeFeatureFlagOverrides,
  resolveFeatureFlags as resolveSharedFeatureFlags,
  type FeatureFlagId,
  type FeatureFlagOverrides,
  type FeatureFlags,
  type ResolveFeatureFlagsOptions,
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
  FeatureFlagId,
  FeatureFlagOverrides,
  FeatureFlags,
  DesktopFeatureFlagId,
  DesktopFeatureFlagOverrides,
  DesktopFeatureFlags,
};

export {
  FEATURE_FLAG_DEFINITIONS,
  FEATURE_FLAG_IDS,
  normalizeFeatureFlagOverrides,
  DESKTOP_FEATURE_FLAG_DEFINITIONS,
  DESKTOP_FEATURE_FLAG_IDS,
  normalizeDesktopFeatureFlagOverrides,
};

export function resolveFeatureFlags(options: ResolveFeatureFlagsOptions): FeatureFlags {
  return resolveSharedFeatureFlags(options);
}

export function resolveDesktopFeatureFlags(options: ResolveDesktopFeatureFlagsOptions): DesktopFeatureFlags {
  return resolveSharedDesktopFeatureFlags(options);
}
