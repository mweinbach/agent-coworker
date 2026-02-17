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
  if (!status) return "Unknown";
  if (status.verified) return "Verified";
  if (status.authorized) return "Authorized";
  if (status.mode === "oauth_pending") return "Pending";
  return "Not set";
}

function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

function displayProviderName(provider: ProviderName): string {
  if (provider === "codex-cli") return "Codex CLI";
  if (provider === "claude-code") return "Claude Code";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
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
        <div className="settingsPageSub">Configure provider auth methods and API keys.</div>
      </div>

      <div className="settingsCard">
        {!canConnectProvider && (
          <div className="settingsMeta" style={{ marginBottom: 10 }}>
            No workspace configured. Add or select a workspace first.
          </div>
        )}
        <div className="settingsCardHeader">
          <div className="settingsCardTitle">Providers</div>
          <button
            className="iconButton"
            type="button"
            onClick={() => {
              void requestProviderCatalog();
              void requestProviderAuthMethods();
              void refreshProviderStatus();
            }}
            disabled={providerStatusRefreshing}
          >
            {providerStatusRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div className="settingsProviderList">
          {providerRows.map((p) => {
            const status = providerStatusByName[p];
            const label = providerStatusLabel(status);
            const isExpanded = expandedProvider === p;
            const methods = authMethodsForProvider(p);
            const connected = Boolean(status?.authorized);
            const providerDisplayName = catalogNameByProvider.get(p) ?? displayProviderName(p);

            return (
              <div key={p}>
                <div
                  className="settingsProviderRow"
                  onClick={() => setExpandedProvider(isExpanded ? null : p)}
                >
                  <div>
                    <div className="settingsProviderName">{providerDisplayName}</div>
                    <div className="settingsProviderMeta">{status?.message || "Click to configure"}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span
                      className={
                        "settingsPill" +
                        (status?.verified || connected ? " settingsPillVerified" : status?.authorized ? " settingsPillWarn" : "")
                      }
                    >
                      {label}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>{isExpanded ? "−" : "+"}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
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
                                placeholder="API key"
                                type="password"
                              />
                              <button
                                className="modalButton modalButtonPrimary"
                                type="button"
                                disabled={!canConnectProvider}
                                title={!canConnectProvider ? "Add or select a workspace first." : undefined}
                                onClick={() => {
                                  void setProviderApiKey(p, method.id, apiKeyValue);
                                }}
                              >
                                Save key
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <button
                                className="modalButton modalButtonPrimary"
                                type="button"
                                disabled={!canConnectProvider}
                                title={!canConnectProvider ? "Add or select a workspace first." : undefined}
                                onClick={() => {
                                  void authorizeProviderAuth(p, method.id);
                                }}
                              >
                                Start OAuth
                              </button>
                              {method.oauthMode === "code" ? (
                                <>
                                  <input
                                    className="settingsTextInput"
                                    style={{ flex: "0 1 240px" }}
                                    value={codeValue}
                                    onChange={(e) =>
                                      setOauthCodesByMethod((s) => ({ ...s, [stateKey]: e.currentTarget.value }))
                                    }
                                    placeholder="Authorization code"
                                    type="text"
                                  />
                                  <button
                                    className="modalButton"
                                    type="button"
                                    disabled={!canConnectProvider}
                                    onClick={() => {
                                      void callbackProviderAuth(p, method.id, codeValue);
                                    }}
                                  >
                                    Submit code
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
                            <div className="settingsMeta" style={{ marginTop: 6 }}>
                              {challengeMatch.challenge.instructions}
                              {challengeMatch.challenge.url ? (
                                <>
                                  {" "}
                                  URL:{" "}
                                  <a href={challengeMatch.challenge.url} target="_blank" rel="noreferrer">
                                    {challengeMatch.challenge.url}
                                  </a>
                                </>
                              ) : null}
                              {challengeMatch.challenge.command ? ` Command: ${challengeMatch.challenge.command}` : ""}
                            </div>
                          )}

                          {resultMatch && (
                            <div
                              className="settingsMeta"
                              style={{ marginTop: 6, color: resultMatch.ok ? "var(--muted)" : "var(--danger)" }}
                            >
                              {resultMatch.message}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {status?.account && (
                      <div className="settingsMeta" style={{ marginTop: 10 }}>
                        {formatAccount(status.account)}
                      </div>
                    )}

                    <div className="settingsModelChips">
                      {(MODEL_CHOICES[p] ?? []).slice(0, 8).map((m) => (
                        <span key={m} className="pill" style={{ fontSize: 10 }}>{m}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
