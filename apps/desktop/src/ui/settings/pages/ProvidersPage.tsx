import { useState } from "react";

import { useAppStore } from "../../../app/store";
import type { ProviderName } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { MODEL_CHOICES, UI_DISABLED_PROVIDERS } from "../../../lib/modelChoices";

const KEYLESS_PROVIDERS = new Set<ProviderName>(["codex-cli", "claude-code"]);

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

export function ProvidersPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const hasWorkspace = workspaces.length > 0;
  const canConnectProvider = hasWorkspace || selectedWorkspaceId !== null;

  const connectProvider = useAppStore((s) => s.connectProvider);
  const refreshProviderStatus = useAppStore((s) => s.refreshProviderStatus);
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const providerStatusRefreshing = useAppStore((s) => s.providerStatusRefreshing);

  const [apiKeysByProvider, setApiKeysByProvider] = useState<Partial<Record<ProviderName, string>>>({});
  const [expandedProvider, setExpandedProvider] = useState<ProviderName | null>(null);

  const providerRows = PROVIDER_NAMES.filter((p) => !UI_DISABLED_PROVIDERS.has(p));

  const requestProviderConnect = (provider: ProviderName, apiKey?: string) => {
    if (!canConnectProvider) return;
    void connectProvider(provider, apiKey);
    setTimeout(() => void refreshProviderStatus(), 1500);
  };

  return (
    <div className="settingsStack">
      <div className="settingsPageHeader">
        <div className="settingsPageTitle">Providers</div>
        <div className="settingsPageSub">Configure API keys for AI providers.</div>
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
            onClick={() => void refreshProviderStatus()}
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
            const isKeyless = KEYLESS_PROVIDERS.has(p);
            const apiKey = apiKeysByProvider[p] ?? "";

            return (
              <div key={p}>
                <div
                  className="settingsProviderRow"
                  onClick={() => setExpandedProvider(isExpanded ? null : p)}
                >
                  <div>
                    <div className="settingsProviderName">{p}</div>
                    <div className="settingsProviderMeta">{status?.message || "Click to configure"}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className={"settingsPill" + (status?.verified ? " settingsPillVerified" : status?.authorized ? " settingsPillWarn" : "")}>
                      {label}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>{isExpanded ? "−" : "+"}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
                    {isKeyless ? (
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span className="settingsMeta">Sign in via browser:</span>
                        <button
                          className="modalButton modalButtonPrimary"
                          type="button"
                          disabled={!canConnectProvider}
                          title={!canConnectProvider ? "Add or select a workspace first." : undefined}
                          onClick={() => {
                            requestProviderConnect(p);
                          }}
                        >
                          {status?.authorized ? "Re-auth" : "Sign in"}
                        </button>
                        {status?.account && (
                          <span className="settingsMeta" style={{ marginLeft: 12 }}>{formatAccount(status.account)}</span>
                        )}
                      </div>
                    ) : (
                      <div className="settingsKeyRow">
                        <input
                          className="settingsTextInput"
                          value={apiKey}
                          onChange={(e) => setApiKeysByProvider((s) => ({ ...s, [p]: e.currentTarget.value }))}
                          placeholder="API key"
                          type="password"
                        />
                        <button
                          className="modalButton modalButtonPrimary"
                          type="button"
                          disabled={!canConnectProvider}
                          title={!canConnectProvider ? "Add or select a workspace first." : undefined}
                          onClick={() => {
                            requestProviderConnect(p, apiKey);
                          }}
                        >
                          Save
                        </button>
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
