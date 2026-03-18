import type { PersistedProviderState, PersistedProviderUiState, WorkspaceRecord } from "./types";

export const DEFAULT_LM_STUDIO_UI_STATE = {
  enabled: false,
  hiddenModels: [],
} as const;

export const DEFAULT_PROVIDER_UI_STATE: PersistedProviderUiState = {
  lmstudio: {
    enabled: DEFAULT_LM_STUDIO_UI_STATE.enabled,
    hiddenModels: [...DEFAULT_LM_STUDIO_UI_STATE.hiddenModels],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeHiddenModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function deriveDefaultLmStudioUiEnabled(opts: {
  providerState?: PersistedProviderState;
  workspaces?: readonly Pick<WorkspaceRecord, "defaultProvider">[];
} = {}): boolean {
  const providerStatus = opts.providerState?.statusByName?.lmstudio;
  if (providerStatus?.authorized || providerStatus?.verified) {
    return true;
  }
  return (opts.workspaces ?? []).some((workspace) => workspace.defaultProvider === "lmstudio");
}

export function normalizePersistedProviderUiState(
  value: unknown,
  opts: {
    defaultLmStudioEnabled?: boolean;
  } = {},
): PersistedProviderUiState {
  const record = isRecord(value) ? value : {};
  const lmstudioRaw = isRecord(record.lmstudio) ? record.lmstudio : {};

  return {
    lmstudio: {
      enabled:
        typeof lmstudioRaw.enabled === "boolean"
          ? lmstudioRaw.enabled
          : (opts.defaultLmStudioEnabled ?? DEFAULT_LM_STUDIO_UI_STATE.enabled),
      hiddenModels: normalizeHiddenModels(lmstudioRaw.hiddenModels),
    },
  };
}
