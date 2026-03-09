import { PROVIDER_NAMES, type ProviderName } from "../lib/wsProtocol";
import type { PersistedProviderState, PersistedProviderStatus } from "./types";

const PROVIDER_STATUS_MODES = new Set(["missing", "error", "api_key", "oauth", "oauth_pending"]);
const DEFAULT_CHECKED_AT = new Date(0).toISOString();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeProviderStatusMode(value: unknown): PersistedProviderStatus["mode"] {
  return typeof value === "string" && PROVIDER_STATUS_MODES.has(value)
    ? value as PersistedProviderStatus["mode"]
    : "missing";
}

function normalizeAccount(value: unknown): PersistedProviderStatus["account"] {
  if (!isRecord(value)) return null;
  const email = asNonEmptyString(value.email);
  const name = asNonEmptyString(value.name);
  if (!email && !name) return null;
  return {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };
}

function normalizeSavedApiKeyMasks(value: unknown): PersistedProviderStatus["savedApiKeyMasks"] {
  if (!isRecord(value)) return undefined;
  const entries: Array<readonly [string, string]> = [];
  for (const [key, rawMask] of Object.entries(value)) {
    const normalizedKey = asNonEmptyString(key);
    const normalizedMask = asNonEmptyString(rawMask);
    if (!normalizedKey || !normalizedMask) continue;
    entries.push([normalizedKey, normalizedMask] as const);
  }
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

export function normalizePersistedProviderStatus(
  expectedProvider: ProviderName,
  value: unknown,
): PersistedProviderStatus | null {
  if (!isRecord(value) || value.provider !== expectedProvider) return null;

  const authorized = typeof value.authorized === "boolean" ? value.authorized : false;
  const verified = typeof value.verified === "boolean" ? value.verified : false;
  const account = normalizeAccount(value.account);
  const message =
    asNonEmptyString(value.message) ??
    (authorized || verified ? "Connected." : "Not connected.");
  const checkedAt = asNonEmptyString(value.checkedAt) ?? DEFAULT_CHECKED_AT;
  const savedApiKeyMasks = normalizeSavedApiKeyMasks(value.savedApiKeyMasks);

  return {
    provider: expectedProvider,
    authorized,
    verified,
    mode: normalizeProviderStatusMode(value.mode),
    account,
    message,
    checkedAt,
    ...(savedApiKeyMasks ? { savedApiKeyMasks } : {}),
    ...(isRecord(value.usage) ? { usage: value.usage as PersistedProviderStatus["usage"] } : {}),
  };
}

export function normalizePersistedProviderState(value: unknown): PersistedProviderState | undefined {
  if (!isRecord(value)) return undefined;

  const rawStatusByName = isRecord(value.statusByName) ? value.statusByName : {};
  const statusByName: Partial<Record<ProviderName, PersistedProviderStatus>> = {};
  for (const provider of PROVIDER_NAMES) {
    const status = normalizePersistedProviderStatus(provider, rawStatusByName[provider]);
    if (status) {
      statusByName[provider] = status;
    }
  }

  const statusLastUpdatedAt = asNonEmptyString(value.statusLastUpdatedAt) ?? null;
  if (Object.keys(statusByName).length === 0 && !statusLastUpdatedAt) {
    return undefined;
  }

  return {
    ...(Object.keys(statusByName).length > 0 ? { statusByName } : {}),
    statusLastUpdatedAt,
  };
}

export function deriveConnectedProviders(providerState?: PersistedProviderState): ProviderName[] {
  if (!providerState?.statusByName) return [];
  return PROVIDER_NAMES.filter((provider) => {
    const status = providerState.statusByName?.[provider];
    return Boolean(status?.authorized || status?.verified);
  });
}
