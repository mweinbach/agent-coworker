export const DESKTOP_FEATURE_FLAG_IDS = [
  "remoteAccess",
  "workspacePicker",
  "workspaceLifecycle",
] as const;

export type DesktopFeatureFlagId = (typeof DESKTOP_FEATURE_FLAG_IDS)[number];

export type DesktopFeatureFlags = Record<DesktopFeatureFlagId, boolean>;
export type DesktopFeatureFlagOverrides = Partial<DesktopFeatureFlags>;

export const WORKSPACE_FEATURE_FLAG_IDS = [
  "experimentalApi",
  "a2ui",
] as const;

export type WorkspaceFeatureFlagId = (typeof WORKSPACE_FEATURE_FLAG_IDS)[number];

export type WorkspaceFeatureFlags = Record<WorkspaceFeatureFlagId, boolean>;
export type WorkspaceFeatureFlagOverrides = Partial<WorkspaceFeatureFlags>;

export type DesktopFeatureFlagDefinition = {
  id: DesktopFeatureFlagId;
  label: string;
  description: string;
  defaultEnabled: boolean;
  envOverride?: string;
  packagedAvailability?: "normal" | "forced-off";
  restartRequired?: boolean;
};

export type WorkspaceFeatureFlagDefinition = {
  id: WorkspaceFeatureFlagId;
  label: string;
  description: string;
  defaultEnabled: boolean;
};

export const DESKTOP_FEATURE_FLAG_DEFINITIONS: Record<DesktopFeatureFlagId, DesktopFeatureFlagDefinition> = {
  remoteAccess: {
    id: "remoteAccess",
    label: "Remote access",
    description: "Enable phone pairing and relay access while the desktop app is open.",
    defaultEnabled: true,
    envOverride: "COWORK_ENABLE_REMOTE_ACCESS",
    packagedAvailability: "forced-off",
    restartRequired: true,
  },
  workspacePicker: {
    id: "workspacePicker",
    label: "Workspace picker",
    description: "Show the multi-workspace picker UI in desktop and onboarding flows.",
    defaultEnabled: true,
  },
  workspaceLifecycle: {
    id: "workspaceLifecycle",
    label: "Workspace lifecycle actions",
    description: "Allow adding, removing, and reordering workspace entries from the desktop UI.",
    defaultEnabled: true,
  },
};

export const WORKSPACE_FEATURE_FLAG_DEFINITIONS: Record<WorkspaceFeatureFlagId, WorkspaceFeatureFlagDefinition> = {
  experimentalApi: {
    id: "experimentalApi",
    label: "Experimental JSON-RPC capabilities",
    description: "Expose experimental JSON-RPC capability metadata for this workspace server.",
    defaultEnabled: true,
  },
  a2ui: {
    id: "a2ui",
    label: "Generative UI (A2UI)",
    description: "Enable A2UI surfaces and action routing for this workspace.",
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

export type ResolveDesktopFeatureFlagsOptions = {
  isPackaged: boolean;
  env?: Record<string, string | undefined>;
  overrides?: DesktopFeatureFlagOverrides | null;
};

export function resolveDesktopFeatureFlags(options: ResolveDesktopFeatureFlagsOptions): DesktopFeatureFlags {
  const values: DesktopFeatureFlags = {
    remoteAccess: DESKTOP_FEATURE_FLAG_DEFINITIONS.remoteAccess.defaultEnabled,
    workspacePicker: DESKTOP_FEATURE_FLAG_DEFINITIONS.workspacePicker.defaultEnabled,
    workspaceLifecycle: DESKTOP_FEATURE_FLAG_DEFINITIONS.workspaceLifecycle.defaultEnabled,
  };

  for (const flagId of DESKTOP_FEATURE_FLAG_IDS) {
    const definition = DESKTOP_FEATURE_FLAG_DEFINITIONS[flagId];
    if (definition.envOverride) {
      const envOverride = parseBooleanFlag(options.env?.[definition.envOverride]);
      if (envOverride !== null) {
        values[flagId] = envOverride;
      }
    }
  }

  const overrides = normalizeDesktopFeatureFlagOverrides(options.overrides);
  if (overrides) {
    for (const flagId of DESKTOP_FEATURE_FLAG_IDS) {
      const override = normalizeBooleanOverride(overrides[flagId]);
      if (override !== undefined) {
        values[flagId] = override;
      }
    }
  }

  if (options.isPackaged) {
    for (const flagId of DESKTOP_FEATURE_FLAG_IDS) {
      const definition = DESKTOP_FEATURE_FLAG_DEFINITIONS[flagId];
      if (definition.packagedAvailability === "forced-off") {
        values[flagId] = false;
      }
    }
  }

  return values;
}

export function normalizeDesktopFeatureFlagOverrides(value: unknown): DesktopFeatureFlagOverrides | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const overrides: DesktopFeatureFlagOverrides = {};
  for (const flagId of DESKTOP_FEATURE_FLAG_IDS) {
    const parsed = normalizeBooleanOverride(source[flagId]);
    if (parsed !== undefined) {
      overrides[flagId] = parsed;
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function resolveWorkspaceFeatureFlags(
  overrides?: WorkspaceFeatureFlagOverrides | null,
): WorkspaceFeatureFlags {
  const values: WorkspaceFeatureFlags = {
    experimentalApi: WORKSPACE_FEATURE_FLAG_DEFINITIONS.experimentalApi.defaultEnabled,
    a2ui: WORKSPACE_FEATURE_FLAG_DEFINITIONS.a2ui.defaultEnabled,
  };

  const normalizedOverrides = normalizeWorkspaceFeatureFlagOverrides(overrides);
  if (!normalizedOverrides) {
    return values;
  }

  for (const flagId of WORKSPACE_FEATURE_FLAG_IDS) {
    const override = normalizeBooleanOverride(normalizedOverrides[flagId]);
    if (override !== undefined) {
      values[flagId] = override;
    }
  }

  return values;
}

export function normalizeWorkspaceFeatureFlagOverrides(value: unknown): WorkspaceFeatureFlagOverrides | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const overrides: WorkspaceFeatureFlagOverrides = {};
  for (const flagId of WORKSPACE_FEATURE_FLAG_IDS) {
    const parsed = normalizeBooleanOverride(source[flagId]);
    if (parsed !== undefined) {
      overrides[flagId] = parsed;
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
