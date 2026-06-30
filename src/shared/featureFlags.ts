export const FEATURE_FLAG_IDS = [
  "menuBar",
  "remoteAccess",
  "workspacePicker",
  "workspaceLifecycle",
  "openAiNativeConnectors",
  "canvas",
  "tasks",
] as const;

export type FeatureFlagId = (typeof FEATURE_FLAG_IDS)[number];

export type FeatureFlags = Record<FeatureFlagId, boolean>;
type FeatureFlagOverrides = Partial<FeatureFlags>;

export type FeatureFlagDefinition = {
  id: FeatureFlagId;
  label: string;
  description: string;
  defaultEnabled: boolean;
  envOverride?: string;
  experimentalEnv?: string;
  packagedAvailability?: "normal" | "forced-off";
  restartRequired?: boolean;
};

export const FEATURE_FLAG_DEFINITIONS: Record<FeatureFlagId, FeatureFlagDefinition> = {
  menuBar: {
    id: "menuBar",
    label: "Menu bar / tray",
    description:
      "Keep Cowork available from the macOS menu bar or Windows system tray, including the quick chat global shortcut.",
    defaultEnabled: true,
  },
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
    description:
      "Show multi-workspace switching UI in desktop settings, onboarding, and sidebar flows.",
    defaultEnabled: true,
  },
  workspaceLifecycle: {
    id: "workspaceLifecycle",
    label: "Workspace lifecycle actions",
    description:
      "Allow adding, removing, reordering, and restarting workspaces from the desktop UI.",
    defaultEnabled: true,
  },
  openAiNativeConnectors: {
    id: "openAiNativeConnectors",
    label: "OpenAI native connectors",
    description: "Enable the OpenAI Native Connectors settings view and Codex apps tooling.",
    defaultEnabled: false,
    restartRequired: true,
  },
  canvas: {
    id: "canvas",
    label: "Canvas",
    description:
      "Work alongside the agent on documents in the right sidebar. Allows real-time edits, commenting, and collaborative writing.",
    defaultEnabled: false,
  },
  tasks: {
    id: "tasks",
    label: "Tasks",
    description:
      "Enable the durable Tasks workspace surfaces (task list, task view, new task), the createTask agent tool, and the task/* routes.",
    defaultEnabled: false,
    envOverride: "COWORK_ENABLE_TASKS",
    restartRequired: true,
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
    menuBar: FEATURE_FLAG_DEFINITIONS.menuBar.defaultEnabled,
    remoteAccess: FEATURE_FLAG_DEFINITIONS.remoteAccess.defaultEnabled,
    workspacePicker: FEATURE_FLAG_DEFINITIONS.workspacePicker.defaultEnabled,
    workspaceLifecycle: FEATURE_FLAG_DEFINITIONS.workspaceLifecycle.defaultEnabled,
    openAiNativeConnectors: FEATURE_FLAG_DEFINITIONS.openAiNativeConnectors.defaultEnabled,
    canvas: FEATURE_FLAG_DEFINITIONS.canvas.defaultEnabled,
    tasks: FEATURE_FLAG_DEFINITIONS.tasks.defaultEnabled,
  };

  for (const flagId of FEATURE_FLAG_IDS) {
    const definition = FEATURE_FLAG_DEFINITIONS[flagId];
    if (definition.envOverride) {
      const envOverride = parseBooleanFlag(options.env?.[definition.envOverride]);
      if (envOverride !== null) {
        values[flagId] = envOverride;
      }
    }
    if (definition.experimentalEnv && options.env?.[definition.experimentalEnv] !== "1") {
      values[flagId] = false;
    }
  }

  // Locally persisted/config flag overrides (e.g. flips made in the dev-only
  // Feature Flags settings page) only apply in development. Packaged
  // (production) builds intentionally ignore them so a flag flipped on a dev
  // machine never leaks into a production build; production resolves to the
  // build-time default (plus env overrides and forced-off constraints below).
  const overrides = options.isPackaged
    ? undefined
    : normalizeFeatureFlagOverrides(options.overrides);
  if (overrides) {
    for (const flagId of FEATURE_FLAG_IDS) {
      const override = normalizeBooleanOverride(overrides[flagId]);
      if (override !== undefined) {
        const definition = FEATURE_FLAG_DEFINITIONS[flagId];
        if (!definition.experimentalEnv || options.env?.[definition.experimentalEnv] === "1") {
          values[flagId] = override;
        }
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

function normalizeFeatureFlagOverrides(value: unknown): FeatureFlagOverrides | undefined {
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
export type DesktopFeatureFlagId = FeatureFlagId;
export type DesktopFeatureFlags = FeatureFlags;
export type DesktopFeatureFlagOverrides = FeatureFlagOverrides;
export const resolveDesktopFeatureFlags = resolveFeatureFlags;
export const normalizeDesktopFeatureFlagOverrides = normalizeFeatureFlagOverrides;
