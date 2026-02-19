import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import type { ProviderName, ServerEvent } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { MODEL_CHOICES, UI_DISABLED_PROVIDERS } from "../../../lib/modelChoices";

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
    "claude-code": "Claude Code",
  };
  return names[provider] ?? provider;
}

function fallbackAuthMethods(provider: ProviderName): ProviderAuthMethod[] {
  if (provider === "codex-cli") {
    return [
      { id: "oauth_cli", type: "oauth", label: "Sign in with ChatGPT (browser)", oauthMode: "auto" },
      { id: "oauth_device", type: "oauth", label: "Sign in with ChatGPT (device code)", oauthMode: "auto" },
      { id: "api_key", type: "api", label: "API key" },
    ];
  }
  if (provider === "claude-code") {
    return [
      { id: "oauth_cli", type: "oauth", label: "Sign in with Claude Code", oauthMode: "auto" },
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

  return (
    <div className="settingsStack">
      <div className="settingsPageHeader">
        <div className="settingsPageTitle">Providers</div>
        <div className="settingsPageSub">
          Connect your AI providers to start chatting.{" "}
          <button
            className="settingsInlineAction"
            type="button"
            onClick={() => {
              void requestProviderCatalog();
              void requestProviderAuthMethods();
              void refreshProviderStatus();
            }}
            disabled={providerStatusRefreshing}
          >
            {providerStatusRefreshing ? "Refreshing…" : "Refresh status"}
          </button>
        </div>
      </div>

      {!canConnectProvider && (
        <div className="settingsCard">
          <div className="settingsCardBody settingsCardBody--centered">
            <span className="settingsMeta">Add a workspace first to connect providers.</span>
          </div>
        </div>
      )}

      <div className="settingsProviderGrid">
        {providerRows.map((p) => {
          const status = providerStatusByName[p];
          const label = providerStatusLabel(status);
          const isExpanded = expandedProvider === p;
          const methods = authMethodsForProvider(p);
          const connected = Boolean(status?.authorized || status?.verified);
          const providerDisplayName = catalogNameByProvider.get(p) ?? displayProviderName(p);
          const models = (MODEL_CHOICES[p] ?? []).slice(0, 8);

          return (
            <div key={p} className={"settingsCard settingsProviderCard" + (isExpanded ? " settingsProviderCardExpanded" : "")}>
              <button
                className="settingsProviderRow"
                type="button"
                aria-expanded={isExpanded}
                aria-controls={`provider-panel-${p}`}
                onClick={() => setExpandedProvider(isExpanded ? null : p)}
              >
                <div className="settingsProviderInfo">
                  <div className="settingsProviderName">{providerDisplayName}</div>
                  <div className="settingsProviderMeta">
                    {connected
                      ? (status?.account ? formatAccount(status.account) : `${models.length} model${models.length !== 1 ? "s" : ""} available`)
                      : "Click to set up"}
                  </div>
                </div>
                <div className="settingsProviderActions">
                  <span
                    className={
                      "settingsPill" +
                      (connected ? " settingsPillVerified" : "")
                    }
                  >
                    {label}
                  </span>
                  <span className="settingsExpandIcon">{isExpanded ? "▾" : "▸"}</span>
                </div>
              </button>

              {isExpanded && (
                <div className="settingsProviderExpanded" id={`provider-panel-${p}`}>
                  {methods.map((method) => {
                    const stateKey = methodStateKey(p, method.id);
                    const apiKeyValue = apiKeysByMethod[stateKey] ?? "";
                    const codeValue = oauthCodesByMethod[stateKey] ?? "";
                    const challengeMatch =
                      providerLastAuthChallenge?.provider === p && providerLastAuthChallenge?.methodId === method.id
                        ? providerLastAuthChallenge
                        : null;
                    const resultMatch =
                      providerLastAuthResult?.provider === p && providerLastAuthResult?.methodId === method.id
                        ? providerLastAuthResult
                        : null;

                    return (
                      <div className="settingsProviderBlock" key={stateKey}>
                        <div className="settingsProviderBlockLabel">{method.label}</div>

                        {method.type === "api" ? (
                          <div className="settingsKeyRow">
                            <input
                              className="settingsTextInput"
                              value={apiKeyValue}
                              onChange={(e) =>
                                setApiKeysByMethod((s) => ({ ...s, [stateKey]: e.currentTarget.value }))
                              }
                              placeholder="Paste your API key"
                              type="password"
                              aria-label={`${providerDisplayName} ${method.label} API key`}
                            />
                            <button
                              className="modalButton modalButtonPrimary"
                              type="button"
                              disabled={!canConnectProvider}
                              title={!canConnectProvider ? "Add a workspace first." : undefined}
                              onClick={() => {
                                void setProviderApiKey(p, method.id, apiKeyValue);
                              }}
                            >
                              Save
                            </button>
                          </div>
                        ) : (
                          <div className="settingsOAuthRow">
                            <button
                              className="modalButton modalButtonPrimary"
                              type="button"
                              disabled={!canConnectProvider}
                              title={!canConnectProvider ? "Add a workspace first." : undefined}
                              onClick={() => {
                                void authorizeProviderAuth(p, method.id);
                              }}
                            >
                              Sign in
                            </button>
                            {method.oauthMode === "code" ? (
                              <>
                                <input
                                  className="settingsTextInput settingsTextInput--code"
                                  value={codeValue}
                                  onChange={(e) =>
                                    setOauthCodesByMethod((s) => ({ ...s, [stateKey]: e.currentTarget.value }))
                                  }
                                  placeholder="Paste authorization code"
                                  type="text"
                                  aria-label={`${providerDisplayName} ${method.label} authorization code`}
                                />
                                <button
                                  className="modalButton"
                                  type="button"
                                  disabled={!canConnectProvider}
                                  onClick={() => {
                                    void callbackProviderAuth(p, method.id, codeValue);
                                  }}
                                >
                                  Submit
                                </button>
                              </>
                            ) : (
                              <button
                                className="modalButton"
                                type="button"
                                disabled={!canConnectProvider}
                                onClick={() => {
                                  void callbackProviderAuth(p, method.id);
                                }}
                              >
                                Continue
                              </button>
                            )}
                          </div>
                        )}

                        {challengeMatch && (
                          <div className="settingsMeta settingsChallengeInfo">
                            {challengeMatch.challenge.instructions}
                            {challengeMatch.challenge.url ? (
                              <>
                                {" "}
                                <a href={challengeMatch.challenge.url} target="_blank" rel="noreferrer">
                                  Open link
                                </a>
                              </>
                            ) : null}
                            {challengeMatch.challenge.command ? (
                              <> Run: <code>{challengeMatch.challenge.command}</code></>
                            ) : ""}
                          </div>
                        )}

                        {resultMatch && (
                          <div
                            className={"settingsMeta" + (resultMatch.ok ? " settingsMetaSuccess" : " settingsMetaError")}
                          >
                            {resultMatch.message}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {models.length > 0 && (
                    <div className="settingsModelChips">
                      <div className="settingsModelChipsLabel">Available models</div>
                      <div className="settingsModelChipsList">
                        {models.map((m) => (
                          <span key={m} className="pill">{m}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
