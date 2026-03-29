export type DesktopFeatureFlags = {
  remoteAccess: boolean;
};

type DesktopFeatureFlagOptions = {
  isPackaged: boolean;
  env?: Record<string, string | undefined>;
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

export function resolveDesktopFeatureFlags(options: DesktopFeatureFlagOptions): DesktopFeatureFlags {
  const remoteAccessOverride = parseBooleanFlag(options.env?.COWORK_ENABLE_REMOTE_ACCESS);

  return {
    // Remote access is a development-only feature for now. The env flag can
    // disable it in dev, but packaged builds must keep it hidden.
    remoteAccess: !options.isPackaged && (remoteAccessOverride ?? true),
  };
}
