import type { PersistedProviderStatus } from "./types";

export function hasGoogleApiKeyForResearch(
  status: Pick<PersistedProviderStatus, "savedApiKeyMasks"> | null | undefined,
): boolean {
  const savedGoogleApiKeyMask = status?.savedApiKeyMasks?.api_key;
  return typeof savedGoogleApiKeyMask === "string" && savedGoogleApiKeyMask.trim().length > 0;
}
