import { Fragment, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { Input } from "../../../components/ui/input";
import { modelChoicesFromCatalog, UI_DISABLED_PROVIDERS } from "../../../lib/modelChoices";
import { compareProviderNamesForSettings } from "../../../lib/providerOrdering";
import type { ProviderName, ServerEvent } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { cn } from "../../../lib/utils";
import {
  displayProviderName,
  isProviderNameString,
} from "../../../lib/providerDisplayNames";

type ProviderAuthMethod = Extract<ServerEvent, { type: "provider_auth_methods" }>["methods"][string][number];
type ProviderCatalogEntry = Extract<ServerEvent, { type: "provider_catalog" }>["all"][number];
type ProviderStatus = Extract<ServerEvent, { type: "provider_status" }>["providers"][number];

const EXA_AUTH_METHOD_ID = "exa_api_key";
export const EXA_SECTION_ID = "provider:exa-search";

type ProvidersPageProps = {
  initialExpandedSectionId?: string | null;
};

function formatAccount(account: any): string {
  const name = typeof account?.name === "string" ? account.name.trim() : "";
  const email = typeof account?.email === "string" ? account.email.trim() : "";
  if (name && email) return `${name} <${email}>`;
  return name || email || "";
}

function providerStatusLabel(status: any): string {
  if (!status) return "Not connected";
  if (
    Array.isArray(status.usage?.rateLimits) &&
    status.usage.rateLimits.some((entry: any) =>
      (entry?.limitReached === true || entry?.allowed === false) && !isUsingCredits(entry)
    )
  ) {
    return "Rate limited";
  }
  if (status.verified) return "Connected";
  if (status.authorized) return "Connected";
  if (status.mode === "oauth_pending") return "Pending";
  return "Not connected";
}

function lmStudioStatusMessage(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function lmStudioStatusKind(opts: {
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

function describeLmStudioCard(opts: {
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
  const noModelsMessage = anyMessage || "LM Studio is reachable, but it is not exposing any LLMs right now.";
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
      subtitle: opts.totalModelCount > 0
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

function describeAwsBedrockProxyCard(opts: {
  enabled: boolean;
  connected: boolean;
  status?: ProviderStatus;
  modelCount: number;
}): {
  badgeLabel: string;
  subtitle: string;
} {
  if (!opts.enabled) {
    return {
      badgeLabel: "Disabled",
      subtitle: "Disabled providers stay out of provider and model selectors until you re-enable them here.",
    };
  }

  return {
    badgeLabel: providerStatusLabel(opts.status),
    subtitle: opts.connected
      ? opts.status?.account
        ? formatAccount(opts.status.account)
        : `${opts.modelCount} model${opts.modelCount !== 1 ? "s" : ""} available`
      : "Click to set up",
  };
}

function formatRateLimitName(entry: any): string {
  const raw: string = typeof entry?.limitName === "string" && entry.limitName.trim() ? entry.limitName.trim() : "";
  if (raw) return raw;
  const limitId: string = typeof entry?.limitId === "string" && entry.limitId.trim() ? entry.limitId.trim() : "";
  if (!limitId) return "Unknown";
  return limitId
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDurationSeconds(totalSeconds: unknown): string {
  if (typeof totalSeconds !== "number" || !Number.isFinite(totalSeconds) || totalSeconds < 0) return "unknown";
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  if (totalSeconds < 3600) return `${Math.round(totalSeconds / 60)}m`;
  if (totalSeconds < 86400) return `${Math.round(totalSeconds / 3600)}h`;
  return `${Math.round(totalSeconds / 86400)}d`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function usedPercentFromWindow(window: any): number | null {
  if (!window || typeof window !== "object") return null;
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return null;
  return clampPercent(window.usedPercent);
}

function remainingPercentFromWindow(window: any): number | null {
  const usedPercent = usedPercentFromWindow(window);
  if (usedPercent === null) return null;
  return clampPercent(100 - usedPercent);
}

function formatWindowMeta(window: any): string {
  if (!window || typeof window !== "object") return "No usage data";
  const windowSize = typeof window.windowSeconds === "number" && Number.isFinite(window.windowSeconds)
    ? `${formatDurationSeconds(window.windowSeconds)} window`
    : "window unknown";
  const reset = typeof window.resetAfterSeconds === "number" && Number.isFinite(window.resetAfterSeconds)
    ? `resets in ${formatDurationSeconds(window.resetAfterSeconds)}`
      : typeof window.resetAt === "string" && window.resetAt.trim()
      ? `resets ${window.resetAt}`
      : "reset unknown";
  return `${windowSize} • ${reset}`;
}

function formatCreditsBalance(balance: unknown): string | null {
  if (typeof balance !== "string" || !balance.trim()) return null;
  const parsed = Number(balance);
  if (!Number.isFinite(parsed)) return balance.trim();
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(parsed);
}

function hasUsableCredits(credits: any): boolean {
  if (!credits || typeof credits !== "object") return false;
  if (credits.unlimited === true) return true;
  if (credits.hasCredits === true) return true;
  const parsedBalance = Number(credits.balance);
  return Number.isFinite(parsedBalance) && parsedBalance > 0;
}

function isUsingCredits(entry: any): boolean {
  return remainingPercentFromWindow(entry?.primaryWindow) === 0 && hasUsableCredits(entry?.credits);
}

function formatCreditsSummary(entry: any): string {
  const credits = entry?.credits;
  if (!credits || typeof credits !== "object") return "";

  const usingCredits = isUsingCredits(entry);
  const balance = formatCreditsBalance(credits.balance);

  if (usingCredits) {
    if (credits.unlimited === true) return "Using credits";
    if (balance) return `Using credits • ${balance} remaining`;
    return "Using credits";
  }

  if (credits.unlimited === true) return "Unlimited credits";
  if (balance && hasUsableCredits(credits)) return `${balance} credits remaining`;
  if (credits.hasCredits === true) return "Credits available";
  return "";
}

function isVisibleUsageRateLimit(entry: any): boolean {
  const limitId = typeof entry?.limitId === "string" ? entry.limitId.trim().toLowerCase() : "";
  const limitName = typeof entry?.limitName === "string" ? entry.limitName.trim().toLowerCase() : "";
  return limitId !== "code_review" && limitName !== "code review";
}

function siblingOpenCodeProvider(provider: ProviderName): ProviderName | null {
  if (provider === "opencode-go") return "opencode-zen";
  if (provider === "opencode-zen") return "opencode-go";
  return null;
}

function fallbackExaAuthMethod(): ProviderAuthMethod {
  return { id: EXA_AUTH_METHOD_ID, type: "api", label: "Exa API key (web search)" };
}

function fallbackAuthMethods(provider: ProviderName): ProviderAuthMethod[] {
  if (provider === "google") {
    return [
      { id: "api_key", type: "api", label: "API key" },
      fallbackExaAuthMethod(),
    ];
  }
  if (provider === "codex-cli") {
    return [
      { id: "oauth_cli", type: "oauth", label: "Sign in with ChatGPT (browser)", oauthMode: "auto" },
    ];
  }
  if (provider === "lmstudio") {
    return [];
  }
  return [{ id: "api_key", type: "api", label: "API key" }];
}

function methodStateKey(provider: ProviderName, methodId: string): string {
  return `${provider}:${methodId}`;
}

function providerSectionId(provider: ProviderName): string {
  return `provider:${provider}`;
}

function visibleAuthMethods(provider: ProviderName, methods: ProviderAuthMethod[]): ProviderAuthMethod[] {
  if (provider === "google") {
    return methods.filter((method) => method.id !== EXA_AUTH_METHOD_ID);
  }
  if (provider === "codex-cli") {
    return methods.filter((method) => method.id !== "api_key");
  }
  return methods;
}

function exaConnectionSummary(hasSavedApiKey: boolean): string {
  return hasSavedApiKey ? "Web search API key saved" : "Add a key to use Exa-backed web search";
}

function initialTabForSection(
  initialExpandedSectionId: string | null,
  toolProviders: ProviderName[],
): "models" | "tools" {
  if (initialExpandedSectionId === EXA_SECTION_ID) return "tools";
  if (!initialExpandedSectionId?.startsWith("provider:")) return "models";

  const requestedProvider = initialExpandedSectionId.slice("provider:".length);
  return toolProviders.some((provider) => provider === requestedProvider) ? "tools" : "models";
}

export function ProvidersPage({ initialExpandedSectionId = null }: ProvidersPageProps = {}) {
  const workspacesFromStore = useAppStore((s) => s.workspaces);
  const selectedWorkspaceIdFromStore = useAppStore((s) => s.selectedWorkspaceId);
  const serverState = typeof window === "undefined" ? useAppStore.getState() : null;
  const workspaces = serverState?.workspaces ?? workspacesFromStore;
  const selectedWorkspaceId = serverState?.selectedWorkspaceId ?? selectedWorkspaceIdFromStore;
  const hasWorkspace = workspaces.length > 0;
  const canConnectProvider = hasWorkspace;
  const canEditGlobalProxyUrl = hasWorkspace;

  const setProviderApiKey = useAppStore((s) => s.setProviderApiKey);
  const copyProviderApiKey = useAppStore((s) => s.copyProviderApiKey);
  const authorizeProviderAuth = useAppStore((s) => s.authorizeProviderAuth);
  const logoutProviderAuth = useAppStore((s) => s.logoutProviderAuth);
  const callbackProviderAuth = useAppStore((s) => s.callbackProviderAuth);
  const requestProviderCatalog = useAppStore((s) => s.requestProviderCatalog);
  const requestProviderAuthMethods = useAppStore((s) => s.requestProviderAuthMethods);
  const requestUserConfig = useAppStore((s) => s.requestUserConfig);
  const setGlobalOpenAiProxyBaseUrl = useAppStore((s) => s.setGlobalOpenAiProxyBaseUrl);
  const refreshProviderStatus = useAppStore((s) => s.refreshProviderStatus);
  const restartWorkspaceServer = useAppStore((s) => s.restartWorkspaceServer);
  const providerStatusByNameFromStore = useAppStore((s) => s.providerStatusByName);
  const providerStatusRefreshingFromStore = useAppStore((s) => s.providerStatusRefreshing);
  const providerCatalogFromStore = useAppStore((s) => s.providerCatalog);
  const providerAuthMethodsByProviderFromStore = useAppStore((s) => s.providerAuthMethodsByProvider);
  const providerLastAuthChallengeFromStore = useAppStore((s) => s.providerLastAuthChallenge);
  const providerLastAuthResultFromStore = useAppStore((s) => s.providerLastAuthResult);
  const userConfigFromStore = useAppStore((s) => s.userConfig);
  const userConfigLastResultFromStore = useAppStore((s) => s.userConfigLastResult);
  const workspaceRuntimeByIdFromStore = useAppStore((s) => s.workspaceRuntimeById);
  const providerUiStateFromStore = useAppStore((s) => s.providerUiState);
  const setAwsBedrockProxyEnabled = useAppStore((s) => s.setAwsBedrockProxyEnabled);
  const setLmStudioEnabled = useAppStore((s) => s.setLmStudioEnabled);
  const setLmStudioModelVisible = useAppStore((s) => s.setLmStudioModelVisible);
  const providerStatusByName = serverState?.providerStatusByName ?? providerStatusByNameFromStore;
  const providerStatusRefreshing = serverState?.providerStatusRefreshing ?? providerStatusRefreshingFromStore;
  const providerCatalog = serverState?.providerCatalog ?? providerCatalogFromStore;
  const providerAuthMethodsByProvider = serverState?.providerAuthMethodsByProvider ?? providerAuthMethodsByProviderFromStore;
  const providerLastAuthChallenge = serverState?.providerLastAuthChallenge ?? providerLastAuthChallengeFromStore;
  const providerLastAuthResult = serverState?.providerLastAuthResult ?? providerLastAuthResultFromStore;
  const userConfig = serverState?.userConfig ?? userConfigFromStore;
  const userConfigLastResult = serverState?.userConfigLastResult ?? userConfigLastResultFromStore;
  const workspaceRuntimeById = serverState?.workspaceRuntimeById ?? workspaceRuntimeByIdFromStore;
  const providerUiState = serverState?.providerUiState ?? providerUiStateFromStore;
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [workspaces, selectedWorkspaceId],
  );
  const selectedWorkspaceRuntime = selectedWorkspace ? workspaceRuntimeById[selectedWorkspace.id] : null;
  const selectedWorkspaceServerError = selectedWorkspaceRuntime?.error?.trim() ?? "";
  const selectedWorkspaceStarting = selectedWorkspaceRuntime?.starting === true;

  const [apiKeysByMethod, setApiKeysByMethod] = useState<Record<string, string>>({});
  const [apiKeyEditingByMethod, setApiKeyEditingByMethod] = useState<Record<string, boolean>>({});
  const [revealApiKeyByMethod, setRevealApiKeyByMethod] = useState<Record<string, boolean>>({});
  const [optimisticApiKeyMaskByMethod, setOptimisticApiKeyMaskByMethod] = useState<Record<string, string>>({});
  const [oauthCodesByMethod, setOauthCodesByMethod] = useState<Record<string, string>>({});
  const [expandedSectionId, setExpandedSectionId] = useState<string | null>(initialExpandedSectionId);
  const [openAiProxyBaseUrlInput, setOpenAiProxyBaseUrlInput] = useState("");
  const [savingOpenAiProxyBaseUrl, setSavingOpenAiProxyBaseUrl] = useState(false);
  const [dismissedRestartPrompt, setDismissedRestartPrompt] = useState(false);
  const [providerCatalogVersion, setProviderCatalogVersion] = useState(0);
  const [bedrockModelsRefreshing, setBedrockModelsRefreshing] = useState(false);
  const [bedrockModelsRefreshStartVersion, setBedrockModelsRefreshStartVersion] = useState(0);
  const [bedrockModelsRefreshResult, setBedrockModelsRefreshResult] = useState<{ ok: boolean; message: string } | null>(null);

  const modelChoices = useMemo(() => modelChoicesFromCatalog(providerCatalog), [providerCatalog]);

  const { modelProviders, toolProviders } = useMemo(() => {
    const fromCatalog = providerCatalog
      .map((entry) => entry.id)
      .filter((provider): provider is ProviderName => isProviderNameString(provider));
    const source = fromCatalog.length > 0 ? fromCatalog : [...PROVIDER_NAMES];
    const filtered = source.filter((provider) => !UI_DISABLED_PROVIDERS.has(provider));

    const isModelProvider = (provider: ProviderName) =>
      provider === "lmstudio" ||
      provider === "aws-bedrock-proxy" ||
      (provider in modelChoices && modelChoices[provider]!.length > 0);

    const sortProviders = (providers: ProviderName[]) => [...providers].sort((a, b) => {
      const aStatus = providerStatusByName[a];
      const bStatus = providerStatusByName[b];
      const aEnabled = a === "lmstudio"
        ? providerUiState.lmstudio.enabled
        : a === "aws-bedrock-proxy"
          ? providerUiState.awsBedrockProxy.enabled
          : true;
      const bEnabled = b === "lmstudio"
        ? providerUiState.lmstudio.enabled
        : b === "aws-bedrock-proxy"
          ? providerUiState.awsBedrockProxy.enabled
          : true;
      const aConnected = aEnabled && Boolean(aStatus?.verified || aStatus?.authorized);
      const bConnected = bEnabled && Boolean(bStatus?.verified || bStatus?.authorized);

      // 1. Connected vs Disconnected
      if (aConnected && !bConnected) return -1;
      if (!aConnected && bConnected) return 1;

      // 2. Preserve the product-specific provider sequence within each group
      return compareProviderNamesForSettings(a, b);
    });

    const mProviders = sortProviders(filtered.filter(isModelProvider));
    const tProviders = sortProviders(filtered.filter((provider) => !isModelProvider(provider)));

    return { modelProviders: mProviders, toolProviders: tProviders };
  }, [providerCatalog, providerStatusByName, modelChoices, providerUiState]);

  const catalogNameByProvider = useMemo(() => {
    const map = new Map<ProviderName, string>();
    for (const entry of providerCatalog) {
      if (!isProviderNameString(entry.id)) continue;
      map.set(entry.id, entry.name);
    }
    return map;
  }, [providerCatalog]);

  const authMethodsForProvider = (provider: ProviderName): ProviderAuthMethod[] => {
    const fromStore = providerAuthMethodsByProvider[provider];
    if (Array.isArray(fromStore) && fromStore.length > 0) return fromStore;
    return fallbackAuthMethods(provider);
  };

  useEffect(() => {
    if (!canConnectProvider) return;
    void requestProviderCatalog();
    void requestProviderAuthMethods();
    void requestUserConfig();
  }, [canConnectProvider, requestProviderAuthMethods, requestProviderCatalog, requestUserConfig]);

  useEffect(() => {
    setOpenAiProxyBaseUrlInput(userConfig.awsBedrockProxyBaseUrl ?? "");
  }, [userConfig.awsBedrockProxyBaseUrl]);

  useEffect(() => {
    setProviderCatalogVersion((version) => version + 1);
  }, [providerCatalog]);

  useEffect(() => {
    if (!bedrockModelsRefreshing) return;
    if (providerCatalogVersion <= bedrockModelsRefreshStartVersion) return;
    setBedrockModelsRefreshing(false);
    const entry = providerCatalog.find((candidate) => candidate.id === "aws-bedrock-proxy");
    if (!entry) {
      setBedrockModelsRefreshResult({
        ok: false,
        message: "Model catalog refreshed, but the AWS Bedrock Proxy entry was missing.",
      });
      return;
    }
    if (entry.state === "unreachable") {
      setBedrockModelsRefreshResult({
        ok: false,
        message: typeof entry.message === "string" && entry.message.trim()
          ? entry.message
          : "Model fetch failed. Check proxy URL/token and try again.",
      });
      return;
    }
    if (!Array.isArray(entry.models) || entry.models.length === 0) {
      setBedrockModelsRefreshResult({
        ok: false,
        message: "Model catalog refreshed, but no models were reported by the proxy.",
      });
      return;
    }
    setBedrockModelsRefreshResult({
      ok: true,
      message: `Model catalog refreshed (${entry.models.length} model${entry.models.length === 1 ? "" : "s"}).`,
    });
  }, [bedrockModelsRefreshStartVersion, bedrockModelsRefreshing, providerCatalog, providerCatalogVersion]);

  useEffect(() => {
    if (!bedrockModelsRefreshing) return;
    const timeout = setTimeout(() => {
      setBedrockModelsRefreshing(false);
      setBedrockModelsRefreshResult({
        ok: false,
        message: "Model fetch timed out. Check proxy URL/token and try again.",
      });
    }, 8_000);
    return () => clearTimeout(timeout);
  }, [bedrockModelsRefreshing]);

  useEffect(() => {
    if (!userConfigLastResult) return;
    setSavingOpenAiProxyBaseUrl(false);
    if (userConfigLastResult.ok) {
      setDismissedRestartPrompt(false);
    }
  }, [userConfigLastResult]);

  useEffect(() => {
    if (!providerLastAuthResult?.ok) return;
    const providerMethods = authMethodsForProvider(providerLastAuthResult.provider);
    const method = providerMethods.find((candidate) => candidate.id === providerLastAuthResult.methodId);
    if (method?.type !== "api") return;
    const stateKey = methodStateKey(providerLastAuthResult.provider, providerLastAuthResult.methodId);
    const refreshedMask = providerStatusByName[providerLastAuthResult.provider]?.savedApiKeyMasks?.[providerLastAuthResult.methodId];
    const nextMask = typeof refreshedMask === "string" && refreshedMask.trim().length > 0 ? refreshedMask : "••••••••";
    setApiKeysByMethod((s) => ({ ...s, [stateKey]: "" }));
    setApiKeyEditingByMethod((s) => ({ ...s, [stateKey]: false }));
    setRevealApiKeyByMethod((s) => ({ ...s, [stateKey]: false }));
    setOptimisticApiKeyMaskByMethod((s) => ({ ...s, [stateKey]: nextMask }));
  }, [providerAuthMethodsByProvider, providerLastAuthResult, providerStatusByName]);

  const startOauthSignIn = (provider: ProviderName, method: ProviderAuthMethod, code?: string) => {
    void (async () => {
      await authorizeProviderAuth(provider, method.id);
      if (method.oauthMode !== "code") {
        await callbackProviderAuth(provider, method.id, code);
      }
    })();
  };

  const renderAuthMethod = (opts: {
    provider: ProviderName;
    providerDisplayName: string;
    status: any;
    method: ProviderAuthMethod;
  }) => {
    const stateKey = methodStateKey(opts.provider, opts.method.id);
    const apiKeyValue = apiKeysByMethod[stateKey] ?? "";
    const codeValue = oauthCodesByMethod[stateKey] ?? "";
    const savedApiKeyMask = opts.status?.savedApiKeyMasks?.[opts.method.id] ?? optimisticApiKeyMaskByMethod[stateKey];
    const hasSavedApiKey = typeof savedApiKeyMask === "string" && savedApiKeyMask.trim().length > 0;
    const isEditingApiKey = apiKeyEditingByMethod[stateKey] ?? !hasSavedApiKey;
    const revealApiKey = Boolean(revealApiKeyByMethod[stateKey]);
    const challengeMatch =
      providerLastAuthChallenge?.provider === opts.provider && providerLastAuthChallenge?.methodId === opts.method.id
        ? providerLastAuthChallenge
        : null;
    const challengeUrl =
      opts.provider === "codex-cli" && opts.method.id === "oauth_cli"
        ? undefined
        : challengeMatch?.challenge.url;
    const resultMatch =
      providerLastAuthResult?.provider === opts.provider && providerLastAuthResult?.methodId === opts.method.id
        ? providerLastAuthResult
        : null;
    const showLogout =
      opts.provider === "codex-cli" &&
      opts.method.id === "oauth_cli" &&
      opts.status?.mode === "oauth" &&
      Boolean(opts.status?.authorized);
    const siblingProvider =
      opts.method.type === "api" && opts.method.id === "api_key"
        ? siblingOpenCodeProvider(opts.provider)
        : null;
    const siblingStatus = siblingProvider ? providerStatusByName[siblingProvider] : null;
    const siblingSavedApiKeyMask = siblingStatus?.savedApiKeyMasks?.api_key;
    const siblingDisplayName = siblingProvider
      ? catalogNameByProvider.get(siblingProvider) ?? displayProviderName(siblingProvider)
      : null;
    const canCopySiblingApiKey =
      Boolean(siblingProvider)
      && typeof siblingSavedApiKeyMask === "string"
      && siblingSavedApiKeyMask.trim().length > 0
      && !hasSavedApiKey;
    const isAwsBedrockProxyTokenMethod =
      opts.provider === "aws-bedrock-proxy" &&
      opts.method.type === "api" &&
      opts.method.id === "api_key";
    const credentialDisplayName = isAwsBedrockProxyTokenMethod ? "Proxy token" : opts.method.label;

    return (
      <div key={stateKey} className="space-y-2 border-t border-border/70 pt-4 first:border-t-0 first:pt-0">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{credentialDisplayName}</div>

        {opts.method.type === "api" ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="max-w-md"
                value={isEditingApiKey ? apiKeyValue : savedApiKeyMask ?? "••••••••"}
                onChange={(e) => {
                  if (!isEditingApiKey) return;
                  const nextValue = e.currentTarget.value;
                  setApiKeysByMethod((s) => ({ ...s, [stateKey]: nextValue }));
                }}
                placeholder={
                  isEditingApiKey
                    ? opts.method.id === EXA_AUTH_METHOD_ID
                      ? "Paste your Exa API key"
                      : isAwsBedrockProxyTokenMethod
                        ? "Paste your LiteLLM proxy token"
                        : "Paste your API key"
                    : isAwsBedrockProxyTokenMethod
                      ? "Saved token (hidden)"
                      : "Saved key (hidden)"
                }
                type={revealApiKey ? "text" : "password"}
                readOnly={!isEditingApiKey}
                aria-label={`${opts.providerDisplayName} ${credentialDisplayName} API key`}
              />
              <Button
                variant="outline"
                type="button"
                disabled={!hasSavedApiKey}
                onClick={() =>
                  setRevealApiKeyByMethod((s) => ({ ...s, [stateKey]: !revealApiKey }))
                }
              >
                {revealApiKey ? "Hide" : "Reveal"}
              </Button>
              {!isEditingApiKey ? (
                <Button
                  type="button"
                  disabled={!canConnectProvider}
                  title={!canConnectProvider ? "Add a workspace first." : undefined}
                  onClick={() => {
                    setApiKeyEditingByMethod((s) => ({ ...s, [stateKey]: true }));
                    setApiKeysByMethod((s) => ({ ...s, [stateKey]: "" }));
                    setRevealApiKeyByMethod((s) => ({ ...s, [stateKey]: false }));
                  }}
                >
                  {isAwsBedrockProxyTokenMethod ? "Replace token" : "Replace key"}
                </Button>
              ) : null}
              {isEditingApiKey && hasSavedApiKey ? (
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setApiKeyEditingByMethod((s) => ({ ...s, [stateKey]: false }));
                    setApiKeysByMethod((s) => ({ ...s, [stateKey]: "" }));
                    setRevealApiKeyByMethod((s) => ({ ...s, [stateKey]: false }));
                  }}
                >
                  Cancel
                </Button>
              ) : null}
              {isEditingApiKey ? (
                <Button
                  type="button"
                  disabled={!canConnectProvider || !apiKeyValue.trim()}
                  title={!canConnectProvider ? "Add a workspace first." : undefined}
                  onClick={() => {
                    void setProviderApiKey(opts.provider, opts.method.id, apiKeyValue.trim());
                  }}
                >
                  Save
                </Button>
              ) : null}
              {canCopySiblingApiKey && siblingProvider && siblingDisplayName ? (
                <Button
                  variant="outline"
                  type="button"
                  disabled={!canConnectProvider}
                  title={!canConnectProvider ? "Add a workspace first." : undefined}
                  onClick={() => {
                    void copyProviderApiKey(opts.provider, siblingProvider);
                  }}
                >
                  {`Use ${siblingDisplayName} key`}
                </Button>
              ) : null}
            </div>
            {isAwsBedrockProxyTokenMethod ? (
              <div className="text-xs text-muted-foreground">
                Use the LiteLLM proxy token configured on your proxy server, not an upstream OpenAI/Anthropic key like{" "}
                <code className="rounded bg-muted/45 px-1.5 py-0.5">sk-...</code>.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={!canConnectProvider}
              title={!canConnectProvider ? "Add a workspace first." : undefined}
              onClick={() => {
                startOauthSignIn(opts.provider, opts.method);
              }}
            >
              Sign in
            </Button>
            {showLogout ? (
              <Button
                variant="outline"
                type="button"
                disabled={!canConnectProvider}
                title={!canConnectProvider ? "Add a workspace first." : undefined}
                onClick={() => {
                  void logoutProviderAuth(opts.provider);
                }}
              >
                Log out
              </Button>
            ) : null}
            {opts.method.oauthMode === "code" ? (
              <>
                <Input
                  className="max-w-xs"
                  value={codeValue}
                  onChange={(e) => {
                    const nextValue = e.currentTarget.value;
                    setOauthCodesByMethod((s) => ({ ...s, [stateKey]: nextValue }));
                  }}
                  placeholder="Paste authorization code"
                  type="text"
                  aria-label={`${opts.providerDisplayName} ${opts.method.label} authorization code`}
                />
                <Button
                  variant="outline"
                  type="button"
                  disabled={!canConnectProvider}
                  onClick={() => {
                    void callbackProviderAuth(opts.provider, opts.method.id, codeValue);
                  }}
                >
                  Submit
                </Button>
              </>
            ) : null}
          </div>
        )}

        {challengeMatch ? (
          <div className="text-xs text-muted-foreground">
            {challengeMatch.challenge.instructions}
            {challengeUrl ? (
              <>
                {" "}
                <a href={challengeUrl} target="_blank" rel="noreferrer" className="underline">
                  Open link
                </a>
              </>
            ) : null}
            {challengeMatch.challenge.command ? (
              <>
                {" "}
                Run: <code className="rounded bg-muted/45 px-1.5 py-0.5">{challengeMatch.challenge.command}</code>
              </>
            ) : null}
          </div>
        ) : null}

        {resultMatch ? (
          <div className={cn("text-xs", resultMatch.ok ? "text-success" : "text-destructive")}>
            {resultMatch.message}
          </div>
        ) : null}
      </div>
    );
  };

  const renderProviderCard = (provider: ProviderName) => {
    const status = providerStatusByName[provider];
    const label = providerStatusLabel(status);
    const sectionId = providerSectionId(provider);
    const isExpanded = expandedSectionId === sectionId;
    const catalogEntry = providerCatalog.find((entry): entry is ProviderCatalogEntry => entry.id === provider);
    const methods = visibleAuthMethods(provider, authMethodsForProvider(provider));
    const connected = Boolean(status?.authorized || status?.verified);
    const providerDisplayName = catalogNameByProvider.get(provider) ?? displayProviderName(provider);
    const isOpenAiProxy = provider === "aws-bedrock-proxy";
    const awsBedrockProxyEnabled = isOpenAiProxy ? providerUiState.awsBedrockProxy.enabled : true;
    const models = isOpenAiProxy
      ? (modelChoices[provider] ?? [])
      : (modelChoices[provider] ?? []).slice(0, 8);
    const bedrockCard = isOpenAiProxy
      ? describeAwsBedrockProxyCard({
          enabled: awsBedrockProxyEnabled,
          connected,
          status,
          modelCount: models.length,
        })
      : null;
    const visibleRateLimits = Array.isArray(status?.usage?.rateLimits)
      ? status.usage.rateLimits.filter(isVisibleUsageRateLimit)
      : [];
    const hasSavedOpenAiProxyBaseUrl = typeof userConfig.awsBedrockProxyBaseUrl === "string" && userConfig.awsBedrockProxyBaseUrl.trim().length > 0;
    const runningWorkspaceIds = workspaces
      .filter((workspace) => {
        const runtime = workspaceRuntimeById[workspace.id];
        return typeof runtime?.serverUrl === "string" && runtime.serverUrl.trim().length > 0;
      })
      .map((workspace) => workspace.id);
    const showRestartPrompt =
      Boolean(userConfigLastResult?.ok)
      && runningWorkspaceIds.length > 0
      && !dismissedRestartPrompt;

    if (provider === "lmstudio") {
      const lmStudioEnabled = providerUiState.lmstudio.enabled;
      const lmStudioModels = Array.isArray(catalogEntry?.models) ? catalogEntry.models : [];
      const hiddenModels = new Set(providerUiState.lmstudio.hiddenModels);
      const visibleLmStudioModels = lmStudioModels.filter((model) => !hiddenModels.has(model.id));
      const lmStudioCard = describeLmStudioCard({
        enabled: lmStudioEnabled,
        status,
        catalogEntry,
        visibleModelCount: visibleLmStudioModels.length,
        totalModelCount: lmStudioModels.length,
      });

      return (
        <Card key={provider} className={cn("provider-settings-card border-border/80 bg-card/85", isExpanded && "border-primary/35")}>
          <Collapsible open={isExpanded} onOpenChange={(nextOpen) => setExpandedSectionId(nextOpen ? sectionId : null)}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-between gap-3 rounded-none px-5 py-4 text-left hover:bg-transparent"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">{providerDisplayName}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{lmStudioCard.subtitle}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={lmStudioEnabled && connected ? "default" : "secondary"}>{lmStudioCard.badgeLabel}</Badge>
                  <span className="text-xs text-muted-foreground">{isExpanded ? "▾" : "▸"}</span>
                </div>
              </Button>
            </CollapsibleTrigger>

            <CollapsibleContent>
              <CardContent id={`provider-panel-${provider}`} className="space-y-4 border-t border-border/70 px-4 py-3.5">
              <div className="text-sm text-muted-foreground">
                LM Studio runs on a local server. Connect it once to make its models available in Cowork, then choose which discovered models should appear in the main chat UI.
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    void setLmStudioEnabled(!lmStudioEnabled);
                  }}
                >
                  {lmStudioEnabled ? "Disable" : "Connect"}
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => void refreshProviderStatus()}
                  disabled={providerStatusRefreshing}
                >
                  {providerStatusRefreshing ? "Refreshing..." : "Refresh"}
                </Button>
              </div>

              {lmStudioCard.subtitle ? (
                <div className="text-sm text-muted-foreground">{lmStudioCard.subtitle}</div>
              ) : null}

              <div className="space-y-2 border-t border-border/70 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Models shown in chat</div>
                  {providerUiState.lmstudio.hiddenModels.length > 0 ? (
                    <Button
                      variant="outline"
                      type="button"
                      size="sm"
                      className="h-7 rounded-sm px-2 text-xs shadow-none"
                      onClick={() => {
                        for (const modelId of providerUiState.lmstudio.hiddenModels) {
                          void setLmStudioModelVisible(modelId, true);
                        }
                      }}
                    >
                      Show all
                    </Button>
                  ) : null}
                </div>

                {lmStudioModels.length > 0 ? (
                  <div className="space-y-2">
                    <div className="grid gap-2">
                      {lmStudioModels.map((model) => {
                        const checked = !hiddenModels.has(model.id);
                        return (
                          <label
                            key={model.id}
                            className="flex items-start gap-3 rounded-sm border border-border/60 px-3 py-2 text-sm"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(nextChecked) => {
                                void setLmStudioModelVisible(model.id, nextChecked === true);
                              }}
                              aria-label={`Show LM Studio model ${model.id} in chat`}
                            />
                            <div className="min-w-0">
                              <div className="truncate font-medium text-foreground">
                                {typeof model.displayName === "string" && model.displayName.trim() ? model.displayName : model.id}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">{model.id}</div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Hidden models stay available in LM Studio but are removed from the main chat selector. Newly discovered models are shown automatically.
                    </div>
                  </div>
                ) : (
                  <div className="rounded-sm border border-dashed border-border/60 px-3 py-2 text-sm text-muted-foreground">
                    {lmStudioCard.emptyStateMessage}
                  </div>
                )}
              </div>
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      );
    }

    return (
      <Card key={provider} className={cn("provider-settings-card border-border/80 bg-card/85", isExpanded && "border-primary/35")}>
        <Collapsible open={isExpanded} onOpenChange={(nextOpen) => setExpandedSectionId(nextOpen ? sectionId : null)}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-between gap-3 rounded-none px-5 py-4 text-left hover:bg-transparent"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">{providerDisplayName}</div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {bedrockCard
                    ? bedrockCard.subtitle
                    : connected
                    ? status?.account
                      ? formatAccount(status.account)
                      : `${models.length} model${models.length !== 1 ? "s" : ""} available`
                    : "Click to set up"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={connected && awsBedrockProxyEnabled ? "default" : "secondary"}>
                  {bedrockCard ? bedrockCard.badgeLabel : label}
                </Badge>
                <span className="text-xs text-muted-foreground">{isExpanded ? "▾" : "▸"}</span>
              </div>
            </Button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent id={`provider-panel-${provider}`} className="space-y-3.5 border-t border-border/70 px-4 py-3.5">
            {isOpenAiProxy ? (
              <div className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  Keep AWS Bedrock Proxy configured while hiding it from provider and model selectors until you re-enable it here.
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    onClick={() => {
                      void setAwsBedrockProxyEnabled(!awsBedrockProxyEnabled);
                    }}
                  >
                    {awsBedrockProxyEnabled ? "Disable" : "Enable"}
                  </Button>
                </div>
              </div>
            ) : null}
            {provider === "aws-bedrock-proxy" ? (
              <div className="rounded-sm border border-border/60 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                {workspaceAwsBedrockProxyBaseUrl
                  ? (
                    <>
                      Using workspace proxy URL <code className="rounded bg-muted/45 px-1.5 py-0.5">{workspaceAwsBedrockProxyBaseUrl}</code>.
                      Update it in Workspaces settings if needed.
                    </>
                  )
                  : "Set your AWS Bedrock Proxy URL in Workspaces settings before saving this API key."}
              </div>
            ) : null}

            {methods.map((method) =>
              renderAuthMethod({
                provider,
                providerDisplayName,
                status,
                method,
              }),
            )}

            {isOpenAiProxy ? (
              <div className="space-y-3 border-t border-border/70 pt-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Global proxy URL</div>
                <div className="text-sm text-muted-foreground">
                  Saved in <code className="rounded bg-muted/45 px-1.5 py-0.5">~/.agent/config.json</code> and shared across workspaces.
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="max-w-xl"
                    value={openAiProxyBaseUrlInput}
                    onChange={(e) => setOpenAiProxyBaseUrlInput(e.currentTarget.value)}
                    placeholder="https://proxy.example.com/v1"
                    type="text"
                    aria-label="AWS Bedrock Proxy base URL"
                  />
                  <Button
                    type="button"
                    disabled={!canEditGlobalProxyUrl || savingOpenAiProxyBaseUrl || !openAiProxyBaseUrlInput.trim()}
                    title={!canEditGlobalProxyUrl ? "Add a workspace first." : undefined}
                    onClick={() => {
                      setSavingOpenAiProxyBaseUrl(true);
                      void setGlobalOpenAiProxyBaseUrl(openAiProxyBaseUrlInput.trim());
                    }}
                  >
                    {savingOpenAiProxyBaseUrl ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    disabled={!canEditGlobalProxyUrl || savingOpenAiProxyBaseUrl || !hasSavedOpenAiProxyBaseUrl}
                    title={!canEditGlobalProxyUrl ? "Add a workspace first." : undefined}
                    onClick={() => {
                      setSavingOpenAiProxyBaseUrl(true);
                      void setGlobalOpenAiProxyBaseUrl(null);
                    }}
                  >
                    Clear
                  </Button>
                </div>
                {userConfigLastResult ? (
                  <div className={cn("text-xs", userConfigLastResult.ok ? "text-emerald-600" : "text-destructive")}>
                    {userConfigLastResult.message}
                  </div>
                ) : null}
                {showRestartPrompt ? (
                  <div className="rounded-md border border-border/70 bg-muted/20 p-3">
                    <div className="text-sm text-muted-foreground">
                      Running workspaces need a restart before this proxy URL is used.
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        onClick={() => {
                          void Promise.all(runningWorkspaceIds.map(async (workspaceId) => {
                            await restartWorkspaceServer(workspaceId);
                          }));
                          setDismissedRestartPrompt(true);
                        }}
                      >
                        Restart running workspaces
                      </Button>
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => setDismissedRestartPrompt(true)}
                      >
                        Later
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {status?.usage ? (
              <div className="space-y-2.5 border-t border-border/70 pt-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Usage</div>
                  {typeof status.usage.planType === "string" && status.usage.planType.trim() ? (
                    <div className="text-xs text-muted-foreground">
                      Plan <span className="font-medium text-foreground">{status.usage.planType.trim()}</span>
                    </div>
                  ) : null}
                </div>

                <div className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[4.75rem_minmax(0,1fr)]">
                  {typeof status.usage.email === "string" && status.usage.email.trim() ? (
                    <>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Email</div>
                      <div className="min-w-0 truncate text-sm text-foreground/95" title={status.usage.email}>
                        {status.usage.email}
                      </div>
                    </>
                  ) : null}
                  {typeof status.message === "string" && status.message.trim() ? (
                    <>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Status</div>
                      <div className="text-sm text-foreground/95">{status.message}</div>
                    </>
                  ) : null}
                </div>

                {visibleRateLimits.length > 0 ? (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Rate limits</div>
                    <div className="divide-y divide-border/50 rounded-sm border border-border/50 bg-muted/5">
                      {visibleRateLimits.map((entry: any, index: number) => {
                        const creditsSummary = formatCreditsSummary(entry);
                        const primaryUsedPercent = usedPercentFromWindow(entry?.primaryWindow);
                        const primaryRemainingPercent = remainingPercentFromWindow(entry?.primaryWindow);
                        const isQuotaBlocked = (entry?.limitReached === true || entry?.allowed === false) && !isUsingCredits(entry);
                        const primaryMeta = formatWindowMeta(entry.primaryWindow);
                        const secondaryMeta = entry?.secondaryWindow ? `Secondary ${formatWindowMeta(entry.secondaryWindow)}` : "";
                        const detailLine = [creditsSummary, primaryMeta, secondaryMeta].filter(Boolean).join(" • ");
                        return (
                          <div key={`${entry?.limitId ?? "limit"}:${index}`} className="space-y-1 px-2.5 py-2">
                            <div className="flex items-baseline justify-between gap-3">
                              <div className="text-sm font-medium text-foreground">{formatRateLimitName(entry)}</div>
                              <div className="text-[11px] font-medium text-foreground/90">
                                {primaryRemainingPercent === null ? "--" : `${Math.round(primaryRemainingPercent)}% remaining`}
                              </div>
                            </div>
                            {entry?.primaryWindow ? (
                              <div className="space-y-1">
                                <div className="h-1 overflow-hidden rounded-full bg-border/70">
                                  <div
                                    className={cn(
                                      "h-full rounded-full transition-[width]",
                                      isQuotaBlocked
                                        ? "bg-destructive/90"
                                        : isUsingCredits(entry)
                                        ? "bg-foreground/70"
                                        : "bg-primary/70",
                                    )}
                                    style={{ width: `${primaryUsedPercent ?? 0}%` }}
                                  />
                                </div>
                                {detailLine ? (
                                  <div className="text-[11px] leading-4 text-muted-foreground">{detailLine}</div>
                                ) : null}
                              </div>
                            ) : null}
                            {isQuotaBlocked ? (
                              <div className="pt-0.5">
                                <Badge
                                  variant="destructive"
                                  className="h-5 rounded-sm px-1.5 text-[10px] font-medium"
                                >
                                  Limit reached
                                </Badge>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : typeof status?.message === "string" && status.message.trim() ? (
              <div className="border-t border-border/70 pt-4 text-sm text-muted-foreground">{status.message}</div>
            ) : null}

            {models.length > 0 || isOpenAiProxy ? (
              <div className="space-y-2 border-t border-border/70 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Available models</div>
                  {isOpenAiProxy ? (
                    <Button
                      variant="outline"
                      type="button"
                      size="sm"
                      disabled={!canConnectProvider || bedrockModelsRefreshing}
                      title={!canConnectProvider ? "Add a workspace first." : undefined}
                      onClick={() => {
                        setBedrockModelsRefreshResult(null);
                        setBedrockModelsRefreshStartVersion(providerCatalogVersion);
                        setBedrockModelsRefreshing(true);
                        void requestProviderCatalog();
                      }}
                    >
                      {bedrockModelsRefreshing ? "Fetching..." : "Fetch models"}
                    </Button>
                  ) : null}
                </div>
                {models.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {models.map((model) => (
                      <Badge key={model} variant="secondary">{model}</Badge>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">No models loaded yet.</div>
                )}
                {isOpenAiProxy && bedrockModelsRefreshResult ? (
                  <div className={cn("text-xs", bedrockModelsRefreshResult.ok ? "text-emerald-600" : "text-destructive")}>
                    {bedrockModelsRefreshResult.message}
                  </div>
                ) : null}
              </div>
            ) : null}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    );
  };

  const renderExaCard = () => {
    const provider = "google";
    const exaMethod = authMethodsForProvider(provider).find((method) => method.id === EXA_AUTH_METHOD_ID) ?? fallbackExaAuthMethod();
    const exaSavedApiKeyMask = providerStatusByName.google?.savedApiKeyMasks?.[EXA_AUTH_METHOD_ID] ??
      optimisticApiKeyMaskByMethod[methodStateKey("google", EXA_AUTH_METHOD_ID)];
    const exaConnected = typeof exaSavedApiKeyMask === "string" && exaSavedApiKeyMask.trim().length > 0;
    const exaExpanded = expandedSectionId === EXA_SECTION_ID;

    // To place Exa properly with the same top-level "connected" sorting as providers, we calculate its status here
    // But since the user wants sections split visually, we just always render it in Tool Providers

    return (
      <Card key="exa" className={cn("provider-settings-card border-border/80 bg-card/85", exaExpanded && "border-primary/35")}>
        <Collapsible open={exaExpanded} onOpenChange={(nextOpen) => setExpandedSectionId(nextOpen ? EXA_SECTION_ID : null)}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-between gap-3 rounded-none px-5 py-4 text-left hover:bg-transparent"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">Exa Search</div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{exaConnectionSummary(exaConnected)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={exaConnected ? "default" : "secondary"}>
                  {exaConnected ? "Connected" : "Not connected"}
                </Badge>
                <span className="text-xs text-muted-foreground">{exaExpanded ? "▾" : "▸"}</span>
              </div>
            </Button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent id="provider-panel-exa-search" className="space-y-4 border-t border-border/70 px-5 py-4">
              <div className="text-sm text-muted-foreground">
                Use Exa for better web search results when Cowork searches the web.
              </div>
              {renderAuthMethod({
                provider: "google",
                providerDisplayName: "Exa Search",
                status: providerStatusByName.google,
                method: exaMethod,
              })}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    );
  };

  const exaSavedApiKeyMask = providerStatusByName.google?.savedApiKeyMasks?.[EXA_AUTH_METHOD_ID] ?? optimisticApiKeyMaskByMethod[methodStateKey("google", EXA_AUTH_METHOD_ID)];
  const isExaConnected = typeof exaSavedApiKeyMask === "string" && exaSavedApiKeyMask.trim().length > 0;

  // Add Exa manually into tool providers sorting if we want, but it's easier to just split render arrays based on connected state.
  // Since we want connected first, we split toolProviders + exa into connected / disconnected
  const connectedToolProviders = toolProviders.filter((provider) => {
    const s = providerStatusByName[provider];
    return s?.verified || s?.authorized;
  });
  const disconnectedToolProviders = toolProviders.filter((provider) => {
    const s = providerStatusByName[provider];
    return !(s?.verified || s?.authorized);
  });

  const allToolElements = [
    ...connectedToolProviders.map(renderProviderCard),
    ...(isExaConnected ? [renderExaCard()] : []),
    ...disconnectedToolProviders.map(renderProviderCard),
    ...(!isExaConnected ? [renderExaCard()] : []),
  ];

  const [activeTab, setActiveTab] = useState<"models" | "tools">(() =>
    initialTabForSection(initialExpandedSectionId, toolProviders),
  );

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Providers</h1>
        <p className="text-sm text-muted-foreground">
          Manage the providers Cowork can use in this app and check whether each one is ready.{" "}
          <Button
            variant="link"
            className="h-auto px-0"
            type="button"
            onClick={() => {
              void requestProviderCatalog();
              void requestProviderAuthMethods();
              void requestUserConfig();
              void refreshProviderStatus();
            }}
            disabled={providerStatusRefreshing}
          >
            {providerStatusRefreshing ? "Refreshing..." : "Refresh status"}
          </Button>
        </p>
      </div>

      {!canConnectProvider ? (
        <Card className="border-border/80 bg-card/85">
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            Add a workspace first to connect providers.
          </CardContent>
        </Card>
      ) : null}
      {canConnectProvider && selectedWorkspace && selectedWorkspaceServerError ? (
        <Card className="border-destructive/40 bg-destructive/10">
          <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-semibold text-destructive">Workspace server unavailable</div>
              <div className="text-sm text-muted-foreground">
                {selectedWorkspace.name} failed to start. Provider setup is unavailable until the workspace server boots.
              </div>
              <div className="break-words text-xs text-destructive">{selectedWorkspaceServerError}</div>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={selectedWorkspaceStarting}
              onClick={() => void restartWorkspaceServer(selectedWorkspace.id)}
            >
              {selectedWorkspaceStarting ? "Retrying..." : "Restart workspace server"}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="app-shadow-surface relative mb-2 flex max-w-fit space-x-1 rounded-xl border border-border/70 bg-foreground/[0.04] p-1.5 backdrop-blur-sm">
        {(["models", "tools"] as const).map((tab) => (
          <Button
            key={tab}
            onClick={() => { setActiveTab(tab); setExpandedSectionId(null); }}
            className={cn(
              "relative z-10 h-auto rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors",
              activeTab === tab ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            type="button"
            variant="ghost"
          >
            {activeTab === tab && (
              <motion.div
                layoutId="providers-active-tab"
                className="app-shadow-surface absolute inset-0 -z-10 rounded-lg border border-border/55 bg-panel/85 backdrop-blur-sm"
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              />
            )}
            {tab === "models" ? "Model Providers" : "Tool Providers"}
          </Button>
        ))}
      </div>

      <div className={cn("space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300", activeTab !== "models" && "hidden")}>
        {modelProviders.map(renderProviderCard)}
      </div>
      <div className={cn("space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300", activeTab !== "tools" && "hidden")}>
        {allToolElements}
      </div>
    </div>
  );
}
