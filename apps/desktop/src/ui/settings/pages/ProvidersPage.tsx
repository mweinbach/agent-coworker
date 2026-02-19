import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import type { ProviderName, ServerEvent } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { MODEL_CHOICES, UI_DISABLED_PROVIDERS } from "../../../lib/modelChoices";
import { cn } from "../../../lib/utils";

type ProviderAuthMethod = Extract<ServerEvent, { type: "provider_auth_methods" }>["methods"][string][number];

function formatAccount(account: any): string {
  const name = typeof account?.name === "string" ? account.name.trim() : "";
  const email = typeof account?.email === "string" ? account.email.trim() : "";
  if (name && email) return `${name} <${email}>`;
  return name || email || "";
}

function providerStatusLabel(status: any): string {
  if (!status) return "Not connected";
  if (status.verified) return "Connected";
  if (status.authorized) return "Connected";
  if (status.mode === "oauth_pending") return "Pending";
  return "Not connected";
}

function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

function displayProviderName(provider: ProviderName): string {
  const names: Partial<Record<ProviderName, string>> = {
    google: "Google",
    openai: "OpenAI",
    anthropic: "Anthropic",
    "codex-cli": "Codex CLI",
  };
  return names[provider] ?? provider;
}

function fallbackAuthMethods(provider: ProviderName): ProviderAuthMethod[] {
  if (provider === "google") {
    return [
      { id: "api_key", type: "api", label: "API key" },
      { id: "exa_api_key", type: "api", label: "Exa API key (web search)" },
    ];
  }
  if (provider === "codex-cli") {
    return [
      { id: "oauth_cli", type: "oauth", label: "Sign in with ChatGPT (browser)", oauthMode: "auto" },
      { id: "oauth_device", type: "oauth", label: "Sign in with ChatGPT (device code)", oauthMode: "auto" },
      { id: "api_key", type: "api", label: "API key" },
    ];
  }
  return [{ id: "api_key", type: "api", label: "API key" }];
}

function methodStateKey(provider: ProviderName, methodId: string): string {
  return `${provider}:${methodId}`;
}

export function ProvidersPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const hasWorkspace = workspaces.length > 0;
  const canConnectProvider = hasWorkspace || selectedWorkspaceId !== null;

  const setProviderApiKey = useAppStore((s) => s.setProviderApiKey);
  const authorizeProviderAuth = useAppStore((s) => s.authorizeProviderAuth);
  const callbackProviderAuth = useAppStore((s) => s.callbackProviderAuth);
  const requestProviderCatalog = useAppStore((s) => s.requestProviderCatalog);
  const requestProviderAuthMethods = useAppStore((s) => s.requestProviderAuthMethods);
  const refreshProviderStatus = useAppStore((s) => s.refreshProviderStatus);
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const providerStatusRefreshing = useAppStore((s) => s.providerStatusRefreshing);
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const providerAuthMethodsByProvider = useAppStore((s) => s.providerAuthMethodsByProvider);
  const providerLastAuthChallenge = useAppStore((s) => s.providerLastAuthChallenge);
  const providerLastAuthResult = useAppStore((s) => s.providerLastAuthResult);

  const [apiKeysByMethod, setApiKeysByMethod] = useState<Record<string, string>>({});
  const [apiKeyEditingByMethod, setApiKeyEditingByMethod] = useState<Record<string, boolean>>({});
  const [revealApiKeyByMethod, setRevealApiKeyByMethod] = useState<Record<string, boolean>>({});
  const [optimisticApiKeyMaskByMethod, setOptimisticApiKeyMaskByMethod] = useState<Record<string, string>>({});
  const [oauthCodesByMethod, setOauthCodesByMethod] = useState<Record<string, string>>({});
  const [expandedProvider, setExpandedProvider] = useState<ProviderName | null>(null);

  const providerRows = useMemo(() => {
    const fromCatalog = providerCatalog
      .map((entry) => entry.id)
      .filter((provider): provider is ProviderName => isProviderName(provider));
    const source = fromCatalog.length > 0 ? fromCatalog : [...PROVIDER_NAMES];
    return source.filter((provider) => !UI_DISABLED_PROVIDERS.has(provider));
  }, [providerCatalog]);

  const catalogNameByProvider = useMemo(() => {
    const map = new Map<ProviderName, string>();
    for (const entry of providerCatalog) {
      if (!isProviderName(entry.id)) continue;
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
  }, [canConnectProvider, requestProviderAuthMethods, requestProviderCatalog]);

  useEffect(() => {
    if (!providerLastAuthResult?.ok) return;
    const stateKey = methodStateKey(providerLastAuthResult.provider, providerLastAuthResult.methodId);
    const refreshedMask = providerStatusByName[providerLastAuthResult.provider]?.savedApiKeyMasks?.[providerLastAuthResult.methodId];
    const nextMask = typeof refreshedMask === "string" && refreshedMask.trim().length > 0 ? refreshedMask : "••••••••";
    setApiKeysByMethod((s) => ({ ...s, [stateKey]: "" }));
    setApiKeyEditingByMethod((s) => ({ ...s, [stateKey]: false }));
    setRevealApiKeyByMethod((s) => ({ ...s, [stateKey]: false }));
    setOptimisticApiKeyMaskByMethod((s) => ({ ...s, [stateKey]: nextMask }));
  }, [providerLastAuthResult, providerStatusByName]);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Providers</h1>
        <p className="text-sm text-muted-foreground">
          Connect your AI providers to start chatting.{" "}
          <Button
            variant="link"
            className="h-auto px-0"
            type="button"
            onClick={() => {
              void requestProviderCatalog();
              void requestProviderAuthMethods();
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

      <div className="space-y-3">
        {providerRows.map((provider) => {
          const status = providerStatusByName[provider];
          const label = providerStatusLabel(status);
          const isExpanded = expandedProvider === provider;
          const methods = authMethodsForProvider(provider);
          const connected = Boolean(status?.authorized || status?.verified);
          const providerDisplayName = catalogNameByProvider.get(provider) ?? displayProviderName(provider);
          const models = (MODEL_CHOICES[provider] ?? []).slice(0, 8);

          return (
            <Card key={provider} className={cn("border-border/80 bg-card/85", isExpanded && "border-primary/35")}> 
              <button
                className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
                type="button"
                aria-expanded={isExpanded}
                aria-controls={`provider-panel-${provider}`}
                onClick={() => setExpandedProvider(isExpanded ? null : provider)}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">{providerDisplayName}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {connected
                      ? (status?.account
                          ? formatAccount(status.account)
                          : `${models.length} model${models.length !== 1 ? "s" : ""} available`)
                      : "Click to set up"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={connected ? "default" : "secondary"}>{label}</Badge>
                  <span className="text-xs text-muted-foreground">{isExpanded ? "▾" : "▸"}</span>
                </div>
              </button>

              {isExpanded ? (
                <CardContent id={`provider-panel-${provider}`} className="space-y-4 border-t border-border/70 px-5 py-4">
                  {methods.map((method) => {
                    const stateKey = methodStateKey(provider, method.id);
                    const apiKeyValue = apiKeysByMethod[stateKey] ?? "";
                    const codeValue = oauthCodesByMethod[stateKey] ?? "";
                    const savedApiKeyMask = status?.savedApiKeyMasks?.[method.id] ?? optimisticApiKeyMaskByMethod[stateKey];
                    const hasSavedApiKey = typeof savedApiKeyMask === "string" && savedApiKeyMask.trim().length > 0;
                    const isEditingApiKey = apiKeyEditingByMethod[stateKey] ?? !hasSavedApiKey;
                    const revealApiKey = Boolean(revealApiKeyByMethod[stateKey]);
                    const challengeMatch =
                      providerLastAuthChallenge?.provider === provider && providerLastAuthChallenge?.methodId === method.id
                        ? providerLastAuthChallenge
                        : null;
                    const resultMatch =
                      providerLastAuthResult?.provider === provider && providerLastAuthResult?.methodId === method.id
                        ? providerLastAuthResult
                        : null;

                    return (
                      <div key={stateKey} className="space-y-2 border-t border-border/70 pt-4 first:border-t-0 first:pt-0">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{method.label}</div>

                        {method.type === "api" ? (
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
                                  ? method.id === "exa_api_key"
                                    ? "Paste your Exa API key"
                                    : "Paste your API key"
                                  : "Saved key (hidden)"
                              }
                              type={revealApiKey ? "text" : "password"}
                              readOnly={!isEditingApiKey}
                              aria-label={`${providerDisplayName} ${method.label} API key`}
                            />
                            <Button
                              variant="outline"
                              type="button"
                              disabled={!hasSavedApiKey}
                              onClick={() =>
                                setRevealApiKeyByMethod((s) => ({ ...s, [stateKey]: !revealApiKey }))
                              }
                            >
                              {revealApiKey ? "Hide" : "View"}
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
                                Edit
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
                                  void setProviderApiKey(provider, method.id, apiKeyValue.trim());
                                }}
                              >
                                Save
                              </Button>
                            ) : null}
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              disabled={!canConnectProvider}
                              title={!canConnectProvider ? "Add a workspace first." : undefined}
                              onClick={() => {
                                void authorizeProviderAuth(provider, method.id);
                              }}
                            >
                              Sign in
                            </Button>
                            {method.oauthMode === "code" ? (
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
                                  aria-label={`${providerDisplayName} ${method.label} authorization code`}
                                />
                                <Button
                                  variant="outline"
                                  type="button"
                                  disabled={!canConnectProvider}
                                  onClick={() => {
                                    void callbackProviderAuth(provider, method.id, codeValue);
                                  }}
                                >
                                  Submit
                                </Button>
                              </>
                            ) : (
                              <Button
                                variant="outline"
                                type="button"
                                disabled={!canConnectProvider}
                                onClick={() => {
                                  void callbackProviderAuth(provider, method.id);
                                }}
                              >
                                Continue
                              </Button>
                            )}
                          </div>
                        )}

                        {challengeMatch ? (
                          <div className="text-xs text-muted-foreground">
                            {challengeMatch.challenge.instructions}
                            {challengeMatch.challenge.url ? (
                              <>
                                {" "}
                                <a href={challengeMatch.challenge.url} target="_blank" rel="noreferrer" className="underline">
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
                          <div className={cn("text-xs", resultMatch.ok ? "text-emerald-600" : "text-destructive")}>
                            {resultMatch.message}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}

                  {models.length > 0 ? (
                    <div className="space-y-2 border-t border-border/70 pt-4">
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Available models</div>
                      <div className="flex flex-wrap gap-2">
                        {models.map((model) => (
                          <Badge key={model} variant="secondary">{model}</Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
