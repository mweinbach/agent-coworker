import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button, buttonVariants } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { Input } from "../../../components/ui/input";
import { modelChoicesFromCatalog, UI_DISABLED_PROVIDERS } from "../../../lib/modelChoices";
import {
  displayProviderName,
  fallbackAuthMethods,
  isProviderNameString,
  visibleAuthMethods,
} from "../../../lib/providerDisplayNames";
import { compareProviderNamesForSettings } from "../../../lib/providerOrdering";
import { cn } from "../../../lib/utils";
import type { ProviderName } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { useOptionalSettingsChrome } from "../SettingsChromeContext";
import {
  describeLmStudioCard,
  EXA_AUTH_METHOD_ID,
  EXA_SECTION_ID,
  fallbackExaAuthMethod,
  fallbackParallelAuthMethod,
  formatAccount,
  formatCreditsSummary,
  formatRateLimitName,
  formatWindowMeta,
  initialTabForSection,
  isUsingCredits,
  isVisibleUsageRateLimit,
  methodStateKey,
  PARALLEL_AUTH_METHOD_ID,
  PARALLEL_SECTION_ID,
  type ProviderAuthMethod,
  type ProviderCatalogEntry,
  providerSectionId,
  providerStatusLabel,
  remainingPercentFromWindow,
  siblingOpenCodeProvider,
  toolProviderConnectionSummary,
  usedPercentFromWindow,
} from "./providersPageUtils";

export { EXA_SECTION_ID, PARALLEL_SECTION_ID } from "./providersPageUtils";

type ProvidersPageProps = {
  initialExpandedSectionId?: string | null;
};

export function ProvidersPage({ initialExpandedSectionId = null }: ProvidersPageProps = {}) {
  const workspacesFromStore = useAppStore((s) => s.workspaces);
  const selectedWorkspaceIdFromStore = useAppStore((s) => s.selectedWorkspaceId);
  const serverState = typeof window === "undefined" ? useAppStore.getState() : null;
  const workspaces = serverState?.workspaces ?? workspacesFromStore;
  const selectedWorkspaceId = serverState?.selectedWorkspaceId ?? selectedWorkspaceIdFromStore;
  const hasWorkspace = workspaces.length > 0;
  const canConnectProvider = hasWorkspace || selectedWorkspaceId !== null;

  const setProviderApiKey = useAppStore((s) => s.setProviderApiKey);
  const setProviderConfig = useAppStore((s) => s.setProviderConfig);
  const copyProviderApiKey = useAppStore((s) => s.copyProviderApiKey);
  const authorizeProviderAuth = useAppStore((s) => s.authorizeProviderAuth);
  const logoutProviderAuth = useAppStore((s) => s.logoutProviderAuth);
  const callbackProviderAuth = useAppStore((s) => s.callbackProviderAuth);
  const refreshProviderStatus = useAppStore((s) => s.refreshProviderStatus);
  const providerStatusByNameFromStore = useAppStore((s) => s.providerStatusByName);
  const providerStatusRefreshingFromStore = useAppStore((s) => s.providerStatusRefreshing);
  const providerCatalogFromStore = useAppStore((s) => s.providerCatalog);
  const providerAuthMethodsByProviderFromStore = useAppStore(
    (s) => s.providerAuthMethodsByProvider,
  );
  const providerLastAuthChallengeFromStore = useAppStore((s) => s.providerLastAuthChallenge);
  const providerLastAuthResultFromStore = useAppStore((s) => s.providerLastAuthResult);
  const providerUiStateFromStore = useAppStore((s) => s.providerUiState);
  const setLmStudioEnabled = useAppStore((s) => s.setLmStudioEnabled);
  const setLmStudioModelVisible = useAppStore((s) => s.setLmStudioModelVisible);
  const providerStatusByName = serverState?.providerStatusByName ?? providerStatusByNameFromStore;
  const providerStatusRefreshing =
    serverState?.providerStatusRefreshing ?? providerStatusRefreshingFromStore;
  const providerCatalog = serverState?.providerCatalog ?? providerCatalogFromStore;
  const providerAuthMethodsByProvider =
    serverState?.providerAuthMethodsByProvider ?? providerAuthMethodsByProviderFromStore;
  const providerLastAuthChallenge =
    serverState?.providerLastAuthChallenge ?? providerLastAuthChallengeFromStore;
  const providerLastAuthResult =
    serverState?.providerLastAuthResult ?? providerLastAuthResultFromStore;
  const providerUiState = serverState?.providerUiState ?? providerUiStateFromStore;

  const [apiKeysByMethod, setApiKeysByMethod] = useState<Record<string, string>>({});
  const [credentialValuesByMethod, setCredentialValuesByMethod] = useState<
    Record<string, Record<string, string>>
  >({});
  const [apiKeyEditingByMethod, setApiKeyEditingByMethod] = useState<Record<string, boolean>>({});
  const [credentialEditingByMethod, setCredentialEditingByMethod] = useState<
    Record<string, boolean>
  >({});
  const [revealApiKeyByMethod, setRevealApiKeyByMethod] = useState<Record<string, boolean>>({});
  const [optimisticApiKeyMaskByMethod, setOptimisticApiKeyMaskByMethod] = useState<
    Record<string, string>
  >({});
  const [optimisticFieldMasksByMethod, setOptimisticFieldMasksByMethod] = useState<
    Record<string, Record<string, string>>
  >({});
  const [oauthCodesByMethod, setOauthCodesByMethod] = useState<Record<string, string>>({});
  const [expandedSectionId, setExpandedSectionId] = useState<string | null>(
    initialExpandedSectionId,
  );

  const modelChoices = useMemo(() => modelChoicesFromCatalog(providerCatalog), [providerCatalog]);

  const { modelProviders, toolProviders } = useMemo(() => {
    const fromCatalog = providerCatalog
      .map((entry) => entry.id)
      .filter((provider): provider is ProviderName => isProviderNameString(provider));
    const source = fromCatalog.length > 0 ? fromCatalog : [...PROVIDER_NAMES];
    const filtered = source.filter((provider) => !UI_DISABLED_PROVIDERS.has(provider));

    const isModelProvider = (provider: ProviderName) =>
      provider === "lmstudio" || (provider in modelChoices && modelChoices[provider]?.length > 0);

    const sortProviders = (providers: ProviderName[]) =>
      [...providers].sort((a, b) => {
        const aStatus = providerStatusByName[a];
        const bStatus = providerStatusByName[b];
        const aConnected =
          a === "lmstudio"
            ? providerUiState.lmstudio.enabled && Boolean(aStatus?.verified || aStatus?.authorized)
            : Boolean(aStatus?.verified || aStatus?.authorized);
        const bConnected =
          b === "lmstudio"
            ? providerUiState.lmstudio.enabled && Boolean(bStatus?.verified || bStatus?.authorized)
            : Boolean(bStatus?.verified || bStatus?.authorized);

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

  const authMethodsForProvider = useCallback(
    (provider: ProviderName): ProviderAuthMethod[] => {
      const fromStore = providerAuthMethodsByProvider[provider];
      if (Array.isArray(fromStore) && fromStore.length > 0) return fromStore;
      return fallbackAuthMethods(provider);
    },
    [providerAuthMethodsByProvider],
  );

  useEffect(() => {
    if (!canConnectProvider) return;
    void refreshProviderStatus();
  }, [canConnectProvider, refreshProviderStatus]);

  const settingsChrome = useOptionalSettingsChrome();
  useEffect(() => {
    if (!settingsChrome) return;
    settingsChrome.setChrome({
      headerActions: canConnectProvider ? (
        <button
          type="button"
          className={buttonVariants({ variant: "outline", size: "sm", className: "shrink-0" })}
          onClick={() => void refreshProviderStatus({ refreshBedrockDiscovery: true })}
          disabled={providerStatusRefreshing}
        >
          {providerStatusRefreshing ? "Refreshing…" : "Refresh status"}
        </button>
      ) : null,
    });
    return () => {
      settingsChrome.setChrome(null);
    };
  }, [settingsChrome, canConnectProvider, providerStatusRefreshing, refreshProviderStatus]);

  useEffect(() => {
    if (!providerLastAuthResult?.ok) return;
    const providerMethods = authMethodsForProvider(providerLastAuthResult.provider);
    const method = providerMethods.find(
      (candidate) => candidate.id === providerLastAuthResult.methodId,
    );
    if (method?.type !== "api") return;
    const stateKey = methodStateKey(
      providerLastAuthResult.provider,
      providerLastAuthResult.methodId,
    );
    if ((method.fields?.length ?? 0) > 0) {
      const rawMasks =
        providerStatusByName[providerLastAuthResult.provider]?.methodId ===
        providerLastAuthResult.methodId
          ? providerStatusByName[providerLastAuthResult.provider]?.savedFieldMasks
          : undefined;
      const nextMasks = Object.fromEntries(
        Object.entries(rawMasks ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      setCredentialValuesByMethod((s) => ({ ...s, [stateKey]: {} }));
      setCredentialEditingByMethod((s) => ({ ...s, [stateKey]: false }));
      setOptimisticFieldMasksByMethod((s) => ({ ...s, [stateKey]: nextMasks }));
      return;
    }
    const refreshedMask =
      providerStatusByName[providerLastAuthResult.provider]?.savedApiKeyMasks?.[
        providerLastAuthResult.methodId
      ];
    const nextMask =
      typeof refreshedMask === "string" && refreshedMask.trim().length > 0
        ? refreshedMask
        : "••••••••";
    setApiKeysByMethod((s) => ({ ...s, [stateKey]: "" }));
    setApiKeyEditingByMethod((s) => ({ ...s, [stateKey]: false }));
    setRevealApiKeyByMethod((s) => ({ ...s, [stateKey]: false }));
    setOptimisticApiKeyMaskByMethod((s) => ({ ...s, [stateKey]: nextMask }));
  }, [authMethodsForProvider, providerLastAuthResult, providerStatusByName]);

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
    const isStructuredMethod = (opts.method.fields?.length ?? 0) > 0;
    const apiKeyValue = apiKeysByMethod[stateKey] ?? "";
    const credentialValues = credentialValuesByMethod[stateKey] ?? {};
    const codeValue = oauthCodesByMethod[stateKey] ?? "";
    const savedApiKeyMask =
      opts.status?.savedApiKeyMasks?.[opts.method.id] ?? optimisticApiKeyMaskByMethod[stateKey];
    const savedFieldMasks =
      opts.status?.methodId === opts.method.id
        ? (opts.status?.savedFieldMasks ?? optimisticFieldMasksByMethod[stateKey])
        : optimisticFieldMasksByMethod[stateKey];
    const hasSavedApiKey = typeof savedApiKeyMask === "string" && savedApiKeyMask.trim().length > 0;
    const hasSavedFields = Boolean(savedFieldMasks && Object.keys(savedFieldMasks).length > 0);
    const isEditingApiKey = apiKeyEditingByMethod[stateKey] ?? !hasSavedApiKey;
    const isEditingCredentials = credentialEditingByMethod[stateKey] ?? !hasSavedFields;
    const revealApiKey = Boolean(revealApiKeyByMethod[stateKey]);
    const challengeMatch =
      providerLastAuthChallenge?.provider === opts.provider &&
      providerLastAuthChallenge?.methodId === opts.method.id
        ? providerLastAuthChallenge
        : null;
    const challengeUrl =
      opts.provider === "codex-cli" && opts.method.id === "oauth_cli"
        ? undefined
        : challengeMatch?.challenge.url;
    const resultMatch =
      providerLastAuthResult?.provider === opts.provider &&
      providerLastAuthResult?.methodId === opts.method.id
        ? providerLastAuthResult
        : null;
    const showLogout =
      opts.provider === "codex-cli" &&
      opts.method.id === "oauth_cli" &&
      opts.status?.mode === "oauth" &&
      Boolean(opts.status?.authorized);
    const siblingProvider =
      opts.method.type === "api" && opts.method.id === "api_key" && !isStructuredMethod
        ? siblingOpenCodeProvider(opts.provider)
        : null;
    const siblingStatus = siblingProvider ? providerStatusByName[siblingProvider] : null;
    const siblingSavedApiKeyMask = siblingStatus?.savedApiKeyMasks?.api_key;
    const siblingDisplayName = siblingProvider
      ? (catalogNameByProvider.get(siblingProvider) ?? displayProviderName(siblingProvider))
      : null;
    const canCopySiblingApiKey =
      Boolean(siblingProvider) &&
      typeof siblingSavedApiKeyMask === "string" &&
      siblingSavedApiKeyMask.trim().length > 0 &&
      !hasSavedApiKey;
    const canSaveStructuredMethod = (opts.method.fields ?? []).every(
      (field) => !field.required || (credentialValues[field.id] ?? "").trim().length > 0,
    );

    return (
      <div
        key={stateKey}
        className="space-y-2 border-t border-border/70 pt-4 first:border-t-0 first:pt-0"
      >
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {opts.method.label}
        </div>

        {opts.method.type === "api" ? (
          isStructuredMethod ? (
            <div className="space-y-3">
              <div className="grid gap-2 md:grid-cols-2">
                {(opts.method.fields ?? []).map((field) => {
                  const savedValue = savedFieldMasks?.[field.id] ?? "";
                  const fieldValue = credentialValues[field.id] ?? "";
                  return (
                    <Input
                      key={`${stateKey}:${field.id}`}
                      className="max-w-md"
                      value={isEditingCredentials ? fieldValue : savedValue}
                      onChange={(e) => {
                        if (!isEditingCredentials) return;
                        const nextValue = e.currentTarget.value;
                        setCredentialValuesByMethod((s) => ({
                          ...s,
                          [stateKey]: {
                            ...(s[stateKey] ?? {}),
                            [field.id]: nextValue,
                          },
                        }));
                      }}
                      placeholder={
                        isEditingCredentials ? (field.placeholder ?? field.label) : "Saved value"
                      }
                      type={field.kind === "password" ? "password" : "text"}
                      readOnly={!isEditingCredentials}
                      aria-label={`${opts.providerDisplayName} ${field.label}`}
                    />
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!isEditingCredentials ? (
                  <Button
                    type="button"
                    disabled={!canConnectProvider}
                    title={!canConnectProvider ? "Add a workspace first." : undefined}
                    onClick={() => {
                      setCredentialEditingByMethod((s) => ({ ...s, [stateKey]: true }));
                      setCredentialValuesByMethod((s) => ({ ...s, [stateKey]: {} }));
                    }}
                  >
                    Update credentials
                  </Button>
                ) : null}
                {isEditingCredentials && hasSavedFields ? (
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => {
                      setCredentialEditingByMethod((s) => ({ ...s, [stateKey]: false }));
                      setCredentialValuesByMethod((s) => ({ ...s, [stateKey]: {} }));
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
                {isEditingCredentials ? (
                  <Button
                    type="button"
                    disabled={!canConnectProvider || !canSaveStructuredMethod}
                    title={!canConnectProvider ? "Add a workspace first." : undefined}
                    onClick={() => {
                      const nextValues = Object.fromEntries(
                        (opts.method.fields ?? []).map((field) => [
                          field.id,
                          (credentialValues[field.id] ?? "").trim(),
                        ]),
                      );
                      void setProviderConfig(opts.provider, opts.method.id, nextValues);
                    }}
                  >
                    Save
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="max-w-md"
                value={isEditingApiKey ? apiKeyValue : (savedApiKeyMask ?? "••••••••")}
                onChange={(e) => {
                  if (!isEditingApiKey) return;
                  const nextValue = e.currentTarget.value;
                  setApiKeysByMethod((s) => ({ ...s, [stateKey]: nextValue }));
                }}
                placeholder={
                  isEditingApiKey
                    ? opts.method.id === EXA_AUTH_METHOD_ID
                      ? "Paste your Exa API key"
                      : opts.method.id === PARALLEL_AUTH_METHOD_ID
                        ? "Paste your Parallel API key"
                        : "Paste your API key"
                    : "Saved key (hidden)"
                }
                type={revealApiKey ? "text" : "password"}
                readOnly={!isEditingApiKey}
                aria-label={`${opts.providerDisplayName} ${opts.method.label} API key`}
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
                  Replace key
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
          )
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
                Run:{" "}
                <code className="rounded bg-muted/45 px-1.5 py-0.5">
                  {challengeMatch.challenge.command}
                </code>
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
    const catalogEntry = providerCatalog.find(
      (entry): entry is ProviderCatalogEntry => entry.id === provider,
    );
    const methods = visibleAuthMethods(provider, authMethodsForProvider(provider));
    const connected = Boolean(status?.authorized || status?.verified);
    const providerDisplayName =
      catalogNameByProvider.get(provider) ?? displayProviderName(provider);
    const models = (modelChoices[provider] ?? []).slice(0, 8);
    const visibleRateLimits = Array.isArray(status?.usage?.rateLimits)
      ? status.usage.rateLimits.filter(isVisibleUsageRateLimit)
      : [];

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
        <Card
          key={provider}
          className={cn(
            "provider-settings-card border-border/80 bg-card/85",
            isExpanded && "border-primary/35",
          )}
        >
          <Collapsible
            open={isExpanded}
            onOpenChange={(nextOpen) => setExpandedSectionId(nextOpen ? sectionId : null)}
          >
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-between gap-3 rounded-none px-5 py-4 text-left hover:bg-transparent"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {providerDisplayName}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {lmStudioCard.subtitle}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={lmStudioEnabled && connected ? "default" : "secondary"}>
                    {lmStudioCard.badgeLabel}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{isExpanded ? "▾" : "▸"}</span>
                </div>
              </Button>
            </CollapsibleTrigger>

            <CollapsibleContent>
              <CardContent
                id={`provider-panel-${provider}`}
                className="space-y-4 border-t border-border/70 px-4 py-3.5"
              >
                <div className="text-sm text-muted-foreground">
                  LM Studio runs on a local server. Connect it once to make its models available in
                  Cowork, then choose which discovered models should appear in the main chat UI.
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
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Models shown in chat
                    </div>
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
                          const checkboxId = `lmstudio-model-${model.id}`;
                          return (
                            <div
                              key={model.id}
                              className="flex items-start gap-3 rounded-sm border border-border/60 px-3 py-2 text-sm"
                            >
                              <Checkbox
                                id={checkboxId}
                                checked={checked}
                                onCheckedChange={(nextChecked) => {
                                  void setLmStudioModelVisible(model.id, nextChecked === true);
                                }}
                                aria-label={`Show LM Studio model ${model.id} in chat`}
                              />
                              <label htmlFor={checkboxId} className="min-w-0">
                                <div className="truncate font-medium text-foreground">
                                  {typeof model.displayName === "string" && model.displayName.trim()
                                    ? model.displayName
                                    : model.id}
                                </div>
                                <div className="truncate text-xs text-muted-foreground">
                                  {model.id}
                                </div>
                              </label>
                            </div>
                          );
                        })}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Hidden models stay available in LM Studio but are removed from the main chat
                        selector. Newly discovered models are shown automatically.
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
      <Card
        key={provider}
        className={cn(
          "provider-settings-card border-border/80 bg-card/85",
          isExpanded && "border-primary/35",
        )}
      >
        <Collapsible
          open={isExpanded}
          onOpenChange={(nextOpen) => setExpandedSectionId(nextOpen ? sectionId : null)}
        >
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-between gap-3 rounded-none px-5 py-4 text-left hover:bg-transparent"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">
                  {providerDisplayName}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {connected
                    ? status?.account
                      ? formatAccount(status.account)
                      : `${models.length} model${models.length !== 1 ? "s" : ""} available`
                    : "Click to set up"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={connected ? "default" : "secondary"}>{label}</Badge>
                <span className="text-xs text-muted-foreground">{isExpanded ? "▾" : "▸"}</span>
              </div>
            </Button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent
              id={`provider-panel-${provider}`}
              className="space-y-3.5 border-t border-border/70 px-4 py-3.5"
            >
              {methods.map((method) =>
                renderAuthMethod({
                  provider,
                  providerDisplayName,
                  status,
                  method,
                }),
              )}

              {status?.usage ? (
                <div className="space-y-2.5 border-t border-border/70 pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Usage
                    </div>
                    {typeof status.usage.planType === "string" && status.usage.planType.trim() ? (
                      <div className="text-xs text-muted-foreground">
                        Plan{" "}
                        <span className="font-medium text-foreground">
                          {status.usage.planType.trim()}
                        </span>
                      </div>
                    ) : null}
                  </div>

                  <div className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[4.75rem_minmax(0,1fr)]">
                    {typeof status.usage.email === "string" && status.usage.email.trim() ? (
                      <>
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">
                          Email
                        </div>
                        <div
                          className="min-w-0 truncate text-sm text-foreground/95"
                          title={status.usage.email}
                        >
                          {status.usage.email}
                        </div>
                      </>
                    ) : null}
                    {typeof status.message === "string" && status.message.trim() ? (
                      <>
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">
                          Status
                        </div>
                        <div className="text-sm text-foreground/95">{status.message}</div>
                      </>
                    ) : null}
                  </div>

                  {visibleRateLimits.length > 0 ? (
                    <div className="space-y-1.5">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Rate limits
                      </div>
                      <div className="divide-y divide-border/50 rounded-sm border border-border/50 bg-muted/5">
                        {visibleRateLimits.map((entry: any) => {
                          const creditsSummary = formatCreditsSummary(entry);
                          const primaryUsedPercent = usedPercentFromWindow(entry?.primaryWindow);
                          const primaryRemainingPercent = remainingPercentFromWindow(
                            entry?.primaryWindow,
                          );
                          const isQuotaBlocked =
                            (entry?.limitReached === true || entry?.allowed === false) &&
                            !isUsingCredits(entry);
                          const primaryMeta = formatWindowMeta(entry.primaryWindow);
                          const secondaryMeta = entry?.secondaryWindow
                            ? `Secondary ${formatWindowMeta(entry.secondaryWindow)}`
                            : "";
                          const detailLine = [creditsSummary, primaryMeta, secondaryMeta]
                            .filter(Boolean)
                            .join(" • ");
                          return (
                            <div
                              key={[
                                entry?.limitId ?? "limit",
                                formatRateLimitName(entry),
                                creditsSummary,
                                primaryMeta,
                                secondaryMeta,
                              ].join(":")}
                              className="space-y-1 px-2.5 py-2"
                            >
                              <div className="flex items-baseline justify-between gap-3">
                                <div className="text-sm font-medium text-foreground">
                                  {formatRateLimitName(entry)}
                                </div>
                                <div className="text-[11px] font-medium text-foreground/90">
                                  {primaryRemainingPercent === null
                                    ? "--"
                                    : `${Math.round(primaryRemainingPercent)}% remaining`}
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
                                    <div className="text-[11px] leading-4 text-muted-foreground">
                                      {detailLine}
                                    </div>
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
                <div className="border-t border-border/70 pt-4 text-sm text-muted-foreground">
                  {status.message}
                </div>
              ) : null}

              {models.length > 0 ? (
                <div className="space-y-2 border-t border-border/70 pt-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Available models
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {models.map((model) => (
                      <Badge key={model} variant="secondary">
                        {model}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    );
  };

  const renderSearchToolCard = (opts: {
    key: string;
    title: string;
    description: string;
    sectionId: string;
    panelId: string;
    methodId: string;
    fallbackMethod: ProviderAuthMethod;
  }) => {
    const provider = "google";
    const method =
      authMethodsForProvider(provider).find((entry) => entry.id === opts.methodId) ??
      opts.fallbackMethod;
    const savedApiKeyMask =
      providerStatusByName.google?.savedApiKeyMasks?.[opts.methodId] ??
      optimisticApiKeyMaskByMethod[methodStateKey("google", opts.methodId)];
    const connected = typeof savedApiKeyMask === "string" && savedApiKeyMask.trim().length > 0;
    const expanded = expandedSectionId === opts.sectionId;

    return (
      <Card
        key={opts.key}
        className={cn(
          "provider-settings-card border-border/80 bg-card/85",
          expanded && "border-primary/35",
        )}
      >
        <Collapsible
          open={expanded}
          onOpenChange={(nextOpen) => setExpandedSectionId(nextOpen ? opts.sectionId : null)}
        >
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-between gap-3 rounded-none px-5 py-4 text-left hover:bg-transparent"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">{opts.title}</div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {toolProviderConnectionSummary(opts.title, connected)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={connected ? "default" : "secondary"}>
                  {connected ? "Connected" : "Not connected"}
                </Badge>
                <span className="text-xs text-muted-foreground">{expanded ? "▾" : "▸"}</span>
              </div>
            </Button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent
              id={opts.panelId}
              className="space-y-4 border-t border-border/70 px-5 py-4"
            >
              <div className="text-sm text-muted-foreground">{opts.description}</div>
              {renderAuthMethod({
                provider: "google",
                providerDisplayName: opts.title,
                status: providerStatusByName.google,
                method,
              })}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    );
  };

  const renderExaCard = () =>
    renderSearchToolCard({
      key: "exa",
      title: "Exa Search",
      description: "Use Exa for better web search results when Cowork searches the web.",
      sectionId: EXA_SECTION_ID,
      panelId: "provider-panel-exa-search",
      methodId: EXA_AUTH_METHOD_ID,
      fallbackMethod: fallbackExaAuthMethod(),
    });

  const renderParallelCard = () =>
    renderSearchToolCard({
      key: "parallel",
      title: "Parallel Search",
      description: "Use Parallel for local web search when Cowork needs fresh web results.",
      sectionId: PARALLEL_SECTION_ID,
      panelId: "provider-panel-parallel-search",
      methodId: PARALLEL_AUTH_METHOD_ID,
      fallbackMethod: fallbackParallelAuthMethod(),
    });

  const exaSavedApiKeyMask =
    providerStatusByName.google?.savedApiKeyMasks?.[EXA_AUTH_METHOD_ID] ??
    optimisticApiKeyMaskByMethod[methodStateKey("google", EXA_AUTH_METHOD_ID)];
  const isExaConnected =
    typeof exaSavedApiKeyMask === "string" && exaSavedApiKeyMask.trim().length > 0;
  const parallelSavedApiKeyMask =
    providerStatusByName.google?.savedApiKeyMasks?.[PARALLEL_AUTH_METHOD_ID] ??
    optimisticApiKeyMaskByMethod[methodStateKey("google", PARALLEL_AUTH_METHOD_ID)];
  const isParallelConnected =
    typeof parallelSavedApiKeyMask === "string" && parallelSavedApiKeyMask.trim().length > 0;

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
    ...(isParallelConnected ? [renderParallelCard()] : []),
    ...disconnectedToolProviders.map(renderProviderCard),
    ...(!isExaConnected ? [renderExaCard()] : []),
    ...(!isParallelConnected ? [renderParallelCard()] : []),
  ];

  const [activeTab, setActiveTab] = useState<"models" | "tools">(() =>
    initialTabForSection(initialExpandedSectionId, toolProviders),
  );

  return (
    <div className="space-y-5">
      {!canConnectProvider ? (
        <Card className="border-border/80 bg-card/85">
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            Add a workspace first to connect providers.
          </CardContent>
        </Card>
      ) : null}

      <div className="app-shadow-surface relative mb-2 flex max-w-fit space-x-1 rounded-xl border border-border/70 bg-foreground/[0.04] p-1.5 backdrop-blur-sm">
        {(["models", "tools"] as const).map((tab) => (
          <Button
            key={tab}
            onClick={() => {
              setActiveTab(tab);
              setExpandedSectionId(null);
            }}
            className={cn(
              "relative z-10 h-auto rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors",
              activeTab === tab ? "text-foreground" : "text-muted-foreground hover:text-foreground",
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

      <div
        className={cn(
          "space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300",
          activeTab !== "models" && "hidden",
        )}
      >
        {modelProviders.map(renderProviderCard)}
      </div>
      <div
        className={cn(
          "space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300",
          activeTab !== "tools" && "hidden",
        )}
      >
        {allToolElements}
      </div>
    </div>
  );
}
