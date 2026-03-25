import type { ProviderName } from "../lib/wsProtocol";
import type { PersistedProviderState, PersistedProviderUiState, WorkspaceRecord } from "./types";

export const DEFAULT_LM_STUDIO_UI_STATE = {
  enabled: false,
  hiddenModels: [],
} as const;

export const DEFAULT_AWS_BEDROCK_PROXY_UI_STATE = {
  enabled: true,
} as const;

export const DEFAULT_PROVIDER_UI_STATE: PersistedProviderUiState = {
  lmstudio: {
    enabled: DEFAULT_LM_STUDIO_UI_STATE.enabled,
    hiddenModels: [...DEFAULT_LM_STUDIO_UI_STATE.hiddenModels],
  },
  awsBedrockProxy: {
    enabled: DEFAULT_AWS_BEDROCK_PROXY_UI_STATE.enabled,
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
  const awsBedrockProxyRaw = isRecord(record.awsBedrockProxy) ? record.awsBedrockProxy : {};

  return {
    lmstudio: {
      enabled:
        typeof lmstudioRaw.enabled === "boolean"
          ? lmstudioRaw.enabled
          : (opts.defaultLmStudioEnabled ?? DEFAULT_LM_STUDIO_UI_STATE.enabled),
      hiddenModels: normalizeHiddenModels(lmstudioRaw.hiddenModels),
    },
    awsBedrockProxy: {
      enabled:
        typeof awsBedrockProxyRaw.enabled === "boolean"
          ? awsBedrockProxyRaw.enabled
          : DEFAULT_AWS_BEDROCK_PROXY_UI_STATE.enabled,
    },
  };
}

export function hiddenProviderNamesFromUiState(providerUiState: PersistedProviderUiState): ProviderName[] {
  const hiddenProviders: ProviderName[] = [];
  if (!providerUiState.lmstudio.enabled) {
    hiddenProviders.push("lmstudio");
  }
  if (!providerUiState.awsBedrockProxy.enabled) {
    hiddenProviders.push("aws-bedrock-proxy");
  }
  return hiddenProviders;
}
