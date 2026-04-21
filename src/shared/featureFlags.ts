export const FEATURE_FLAG_IDS = [
  "remoteAccess",
  "workspacePicker",
  "workspaceLifecycle",
  "a2ui",
] as const;

export type FeatureFlagId = (typeof FEATURE_FLAG_IDS)[number];

export type FeatureFlags = Record<FeatureFlagId, boolean>;
export type FeatureFlagOverrides = Partial<FeatureFlags>;

export type FeatureFlagDefinition = {
  id: FeatureFlagId;
  label: string;
  description: string;
  defaultEnabled: boolean;
  envOverride?: string;
  packagedAvailability?: "normal" | "forced-off";
  restartRequired?: boolean;
};

export const FEATURE_FLAG_DEFINITIONS: Record<FeatureFlagId, FeatureFlagDefinition> = {
  remoteAccess: {
    id: "remoteAccess",
    label: "Remote access",
    description: "Enable phone pairing and relay access while the desktop app is open.",
    defaultEnabled: false,
    envOverride: "COWORK_ENABLE_REMOTE_ACCESS",
    packagedAvailability: "forced-off",
    restartRequired: true,
  },
  workspacePicker: {
    id: "workspacePicker",
    label: "Workspace picker",
    description: "Show multi-workspace switching UI in desktop settings, onboarding, and sidebar flows.",
    defaultEnabled: true,
  },
  workspaceLifecycle: {
    id: "workspaceLifecycle",
    label: "Workspace lifecycle actions",
    description: "Allow adding, removing, reordering, and restarting workspaces from the desktop UI.",
    defaultEnabled: true,
  },
  a2ui: {
    id: "a2ui",
    label: "Generative UI (A2UI)",
    description: "Enable A2UI surfaces and action routing across all workspaces.",
    defaultEnabled: false,
  },
};

function parseBooleanFlag(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return null;
}

function normalizeBooleanOverride(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export type ResolveFeatureFlagsOptions = {
  isPackaged: boolean;
  env?: Record<string, string | undefined>;
  overrides?: FeatureFlagOverrides | null;
};

export function resolveFeatureFlags(options: ResolveFeatureFlagsOptions): FeatureFlags {
  const values: FeatureFlags = {
    remoteAccess: FEATURE_FLAG_DEFINITIONS.remoteAccess.defaultEnabled,
    workspacePicker: FEATURE_FLAG_DEFINITIONS.workspacePicker.defaultEnabled,
    workspaceLifecycle: FEATURE_FLAG_DEFINITIONS.workspaceLifecycle.defaultEnabled,
    a2ui: FEATURE_FLAG_DEFINITIONS.a2ui.defaultEnabled,
  };

  for (const flagId of FEATURE_FLAG_IDS) {
    const definition = FEATURE_FLAG_DEFINITIONS[flagId];
    if (definition.envOverride) {
      const envOverride = parseBooleanFlag(options.env?.[definition.envOverride]);
      if (envOverride !== null) {
        values[flagId] = envOverride;
      }
    }
  }

  const overrides = normalizeFeatureFlagOverrides(options.overrides);
  if (overrides) {
    for (const flagId of FEATURE_FLAG_IDS) {
      const override = normalizeBooleanOverride(overrides[flagId]);
      if (override !== undefined) {
        values[flagId] = override;
      }
    }
  }

  if (options.isPackaged) {
    for (const flagId of FEATURE_FLAG_IDS) {
      const definition = FEATURE_FLAG_DEFINITIONS[flagId];
      if (definition.packagedAvailability === "forced-off") {
        values[flagId] = false;
      }
    }
  }

  return values;
}

export function normalizeFeatureFlagOverrides(value: unknown): FeatureFlagOverrides | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const overrides: FeatureFlagOverrides = {};
  for (const flagId of FEATURE_FLAG_IDS) {
    const parsed = normalizeBooleanOverride(source[flagId]);
    if (parsed !== undefined) {
      overrides[flagId] = parsed;
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

// Backward-compat aliases while desktop migrates imports.
export const DESKTOP_FEATURE_FLAG_IDS = FEATURE_FLAG_IDS;
export type DesktopFeatureFlagId = FeatureFlagId;
export type DesktopFeatureFlags = FeatureFlags;
export type DesktopFeatureFlagOverrides = FeatureFlagOverrides;
export type DesktopFeatureFlagDefinition = FeatureFlagDefinition;
export const DESKTOP_FEATURE_FLAG_DEFINITIONS = FEATURE_FLAG_DEFINITIONS;
export type ResolveDesktopFeatureFlagsOptions = ResolveFeatureFlagsOptions;
export const resolveDesktopFeatureFlags = resolveFeatureFlags;
export const normalizeDesktopFeatureFlagOverrides = normalizeFeatureFlagOverrides;
