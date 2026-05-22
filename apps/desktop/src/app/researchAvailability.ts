import type { PersistedProviderStatus } from "./types";

export function hasGoogleApiKeyForResearch(
  status:
    | Pick<
        PersistedProviderStatus,
        "authorized" | "verified" | "mode" | "methodId" | "savedApiKeyMasks"
      >
    | null
    | undefined,
): boolean {
  if (!status) return false;
  if (typeof status.savedApiKeyMasks?.api_key === "string") return true;
  if (status.mode !== "api_key") return false;
  return Boolean(status.authorized || status.verified);
}
