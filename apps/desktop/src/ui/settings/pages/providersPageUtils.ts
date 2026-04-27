import type { ProviderName, SessionEvent } from "../../../lib/wsProtocol";

export type ProviderAuthMethod = Extract<
  SessionEvent,
  { type: "provider_auth_methods" }
>["methods"][string][number];
export type ProviderCatalogEntry = Extract<
  SessionEvent,
  { type: "provider_catalog" }
>["all"][number];
export type ProviderStatus = Extract<
  SessionEvent,
  { type: "provider_status" }
>["providers"][number];
type ProviderUsage = NonNullable<ProviderStatus["usage"]>;
type ProviderRateLimitEntry = ProviderUsage["rateLimits"][number];
type ProviderRateLimitWindow = NonNullable<ProviderRateLimitEntry["primaryWindow"]>;
type ProviderCredits = NonNullable<ProviderRateLimitEntry["credits"]>;

export const EXA_AUTH_METHOD_ID = "exa_api_key";
export const PARALLEL_AUTH_METHOD_ID = "parallel_api_key";
export const EXA_SECTION_ID = "provider:exa-search";
export const PARALLEL_SECTION_ID = "provider:parallel-search";

export function formatAccount(account: ProviderStatus["account"]): string {
  const name = typeof account?.name === "string" ? account.name.trim() : "";
  const email = typeof account?.email === "string" ? account.email.trim() : "";
  if (name && email) return `${name} <${email}>`;
  return name || email || "";
}

export function providerStatusLabel(status: ProviderStatus | null | undefined): string {
  if (!status) return "Not connected";
  if (
    Array.isArray(status.usage?.rateLimits) &&
    status.usage.rateLimits.some(
      (entry) =>
        (entry?.limitReached === true || entry?.allowed === false) && !isUsingCredits(entry),
    )
  ) {
    return "Rate limited";
  }
  if (status.verified) return "Connected";
  if (status.authorized) return "Connected";
  if (status.mode === "oauth_pending") return "Pending";
  return "Not connected";
}

export function lmStudioStatusMessage(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function lmStudioStatusKind(opts: {
  enabled: boolean;
  status?: ProviderStatus;
  catalogEntry?: ProviderCatalogEntry;
}): "disabled" | "connected" | "no-models" | "unavailable" | "checking" {
  if (!opts.enabled) return "disabled";
  if (opts.catalogEntry?.state === "empty") return "no-models";
  if (opts.catalogEntry?.state === "unreachable") return "unavailable";
  if (opts.status?.mode === "error") return "unavailable";
  if (lmStudioStatusMessage(opts.status?.message).toLowerCase().includes("no llms are available")) {
    return "no-models";
  }
  if (opts.status?.authorized || opts.status?.verified) return "connected";
  return "checking";
}

export function describeLmStudioCard(opts: {
  enabled: boolean;
  status?: ProviderStatus;
  catalogEntry?: ProviderCatalogEntry;
  visibleModelCount: number;
  totalModelCount: number;
}): {
  badgeLabel: string;
  subtitle: string;
  emptyStateMessage: string;
} {
  const statusMessage = lmStudioStatusMessage(opts.status?.message);
  const catalogMessage = lmStudioStatusMessage(opts.catalogEntry?.message);
  const anyMessage = catalogMessage || statusMessage;
  const noModelsMessage =
    anyMessage || "LM Studio is reachable, but it is not exposing any LLMs right now.";
  const kind = lmStudioStatusKind(opts);

  if (kind === "disabled") {
    return {
      badgeLabel: "Disabled",
      subtitle: "Connect once to show LM Studio in Cowork.",
      emptyStateMessage: "Refresh once LM Studio is running to discover available models.",
    };
  }

  if (kind === "no-models") {
    return {
      badgeLabel: "No models",
      subtitle: noModelsMessage,
      emptyStateMessage: "LM Studio is reachable, but it is not exposing any LLMs right now.",
    };
  }

  if (kind === "unavailable") {
    return {
      badgeLabel: "Unavailable",
      subtitle: anyMessage || "Unable to reach your local LM Studio server.",
      emptyStateMessage: "Refresh once LM Studio is running to discover available models.",
    };
  }

  if (kind === "connected") {
    return {
      badgeLabel: "Connected",
      subtitle:
        opts.totalModelCount > 0
          ? `${opts.visibleModelCount}/${opts.totalModelCount} model${opts.totalModelCount === 1 ? "" : "s"} shown in chat`
          : noModelsMessage,
      emptyStateMessage: "LM Studio is reachable, but it is not exposing any LLMs right now.",
    };
  }

  return {
    badgeLabel: "Checking",
    subtitle: anyMessage || "Checking your local LM Studio server.",
    emptyStateMessage: "Refresh once LM Studio is running to discover available models.",
  };
}

export function formatRateLimitName(entry: ProviderRateLimitEntry): string {
  const raw: string =
    typeof entry?.limitName === "string" && entry.limitName.trim() ? entry.limitName.trim() : "";
  if (raw) return raw;
  const limitId: string =
    typeof entry?.limitId === "string" && entry.limitId.trim() ? entry.limitId.trim() : "";
  if (!limitId) return "Unknown";
  return limitId
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatDurationSeconds(totalSeconds: unknown): string {
  if (typeof totalSeconds !== "number" || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "unknown";
  }
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  if (totalSeconds < 3600) return `${Math.round(totalSeconds / 60)}m`;
  if (totalSeconds < 86400) return `${Math.round(totalSeconds / 3600)}h`;
  return `${Math.round(totalSeconds / 86400)}d`;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function usedPercentFromWindow(
  window: ProviderRateLimitWindow | null | undefined,
): number | null {
  if (!window || typeof window !== "object") return null;
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return null;
  return clampPercent(window.usedPercent);
}

export function remainingPercentFromWindow(
  window: ProviderRateLimitWindow | null | undefined,
): number | null {
  const usedPercent = usedPercentFromWindow(window);
  if (usedPercent === null) return null;
  return clampPercent(100 - usedPercent);
}

export function formatWindowMeta(window: ProviderRateLimitWindow | null | undefined): string {
  if (!window || typeof window !== "object") return "No usage data";
  const windowSize =
    typeof window.windowSeconds === "number" && Number.isFinite(window.windowSeconds)
      ? `${formatDurationSeconds(window.windowSeconds)} window`
      : "window unknown";
  const reset =
    typeof window.resetAfterSeconds === "number" && Number.isFinite(window.resetAfterSeconds)
      ? `resets in ${formatDurationSeconds(window.resetAfterSeconds)}`
      : typeof window.resetAt === "string" && window.resetAt.trim()
        ? `resets ${window.resetAt}`
        : "reset unknown";
  return `${windowSize} \u2022 ${reset}`;
}

export function formatCreditsBalance(balance: unknown): string | null {
  if (typeof balance !== "string" || !balance.trim()) return null;
  const parsed = Number(balance);
  if (!Number.isFinite(parsed)) return balance.trim();
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(parsed);
}

export function hasUsableCredits(credits: ProviderCredits | null | undefined): boolean {
  if (!credits || typeof credits !== "object") return false;
  if (credits.unlimited === true) return true;
  if (credits.hasCredits === true) return true;
  const parsedBalance = Number(credits.balance);
  return Number.isFinite(parsedBalance) && parsedBalance > 0;
}

export function isUsingCredits(entry: ProviderRateLimitEntry): boolean {
  return remainingPercentFromWindow(entry?.primaryWindow) === 0 && hasUsableCredits(entry?.credits);
}

export function formatCreditsSummary(entry: ProviderRateLimitEntry): string {
  const credits = entry?.credits;
  if (!credits || typeof credits !== "object") return "";

  const usingCredits = isUsingCredits(entry);
  const balance = formatCreditsBalance(credits.balance);

  if (usingCredits) {
    if (credits.unlimited === true) return "Using credits";
    if (balance) return `Using credits \u2022 ${balance} remaining`;
    return "Using credits";
  }

  if (credits.unlimited === true) return "Unlimited credits";
  if (balance && hasUsableCredits(credits)) return `${balance} credits remaining`;
  if (credits.hasCredits === true) return "Credits available";
  return "";
}

export function isVisibleUsageRateLimit(entry: ProviderRateLimitEntry): boolean {
  const limitId = typeof entry?.limitId === "string" ? entry.limitId.trim().toLowerCase() : "";
  const limitName =
    typeof entry?.limitName === "string" ? entry.limitName.trim().toLowerCase() : "";
  return limitId !== "code_review" && limitName !== "code review";
}

export function siblingOpenCodeProvider(provider: ProviderName): ProviderName | null {
  if (provider === "opencode-go") return "opencode-zen";
  if (provider === "opencode-zen") return "opencode-go";
  return null;
}

export function fallbackExaAuthMethod(): ProviderAuthMethod {
  return { id: EXA_AUTH_METHOD_ID, type: "api", label: "Exa API key (web search)" };
}

export function fallbackParallelAuthMethod(): ProviderAuthMethod {
  return { id: PARALLEL_AUTH_METHOD_ID, type: "api", label: "Parallel API key (web search)" };
}

export function methodStateKey(provider: ProviderName, methodId: string): string {
  return `${provider}:${methodId}`;
}

export function providerSectionId(provider: ProviderName): string {
  return `provider:${provider}`;
}

export function toolProviderConnectionSummary(label: string, hasSavedApiKey: boolean): string {
  return hasSavedApiKey
    ? "Web search API key saved"
    : `Add a key to use ${label} for local web search`;
}

export function initialTabForSection(
  initialExpandedSectionId: string | null,
  toolProviders: ProviderName[],
): "models" | "tools" {
  if (
    initialExpandedSectionId === EXA_SECTION_ID ||
    initialExpandedSectionId === PARALLEL_SECTION_ID
  ) {
    return "tools";
  }
  if (!initialExpandedSectionId?.startsWith("provider:")) return "models";

  const requestedProvider = initialExpandedSectionId.slice("provider:".length);
  return toolProviders.some((provider) => provider === requestedProvider) ? "tools" : "models";
}
