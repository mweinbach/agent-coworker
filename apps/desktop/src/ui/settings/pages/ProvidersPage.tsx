import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import type { ProviderName } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { MODEL_CHOICES, UI_DISABLED_PROVIDERS } from "../../../lib/modelChoices";

import { SettingsCard, SettingsPageHeader } from "../components";

const KEYLESS_PROVIDERS = new Set<ProviderName>(["codex-cli", "claude-code"]);

type ProviderPill = { label: string; className: string };

function providerPill(
  provider: ProviderName,
  providerStatusRefreshing: boolean,
  providerStatusByName: Partial<Record<ProviderName, any>>
): ProviderPill {
  const s = providerStatusByName[provider];
  if (!s) {
    return {
      label: providerStatusRefreshing ? "Checking…" : "Unknown",
      className: "settingsPillNeutral",
    };
  }
  if (s.verified) return { label: "Verified", className: "settingsPillVerified" };
  if (s.authorized) return { label: "Authorized", className: "settingsPillWarn" };
  if (s.mode === "oauth_pending") return { label: "Pending", className: "settingsPillWarn" };
  return { label: "Not authorized", className: "settingsPillDanger" };
}

function formatAccount(account: any): string {
  const name = typeof account?.name === "string" ? account.name.trim() : "";
  const email = typeof account?.email === "string" ? account.email.trim() : "";
  if (name && email) return `${name} <${email}>`;
  return name || email || "Unavailable";
}

export function ProvidersPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);

  const connectProvider = useAppStore((s) => s.connectProvider);
  const refreshProviderStatus = useAppStore((s) => s.refreshProviderStatus);
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const providerStatusRefreshing = useAppStore((s) => s.providerStatusRefreshing);

  const [apiKeysByProvider, setApiKeysByProvider] = useState<Partial<Record<ProviderName, string>>>({});
  const [revealKeyByProvider, setRevealKeyByProvider] = useState<Partial<Record<ProviderName, boolean>>>({});
  const [showClaudeHelp, setShowClaudeHelp] = useState(false);
  const [activeProvider, setActiveProvider] = useState<ProviderName | null>(null);

  const ws = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces]
  );

  useEffect(() => {
    void refreshProviderStatus();
  }, [refreshProviderStatus]);

  useEffect(() => {
    if (!activeProvider) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveProvider(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeProvider]);

  useEffect(() => {
    if (activeProvider !== "claude-code") setShowClaudeHelp(false);
  }, [activeProvider]);

  const providerRows = PROVIDER_NAMES.filter((p) => !UI_DISABLED_PROVIDERS.has(p));
  const activeStatus = activeProvider ? providerStatusByName[activeProvider] : null;
  const activeModels = activeProvider ? MODEL_CHOICES[activeProvider] ?? [] : [];
  const activeApiKey = activeProvider ? apiKeysByProvider[activeProvider] ?? "" : "";
  const activeReveal = activeProvider ? revealKeyByProvider[activeProvider] ?? false : false;
  const activePill = activeProvider ? providerPill(activeProvider, providerStatusRefreshing, providerStatusByName) : null;

  return (
    <div className="settingsStack">
      <SettingsPageHeader
        title="Providers"
        subtitle={
          <>
            Configure global provider credentials. Workspace defaults live under{" "}
            <strong>Workspaces</strong>.
          </>
        }
      />

      {!ws ? (
        <SettingsCard title="Providers" subtitle="Add a workspace to begin.">
          <div className="settingsEmpty">No workspaces configured.</div>
        </SettingsCard>
      ) : (
        <SettingsCard
          title="Providers"
          right={
            <button
              className="iconButton"
              type="button"
              onClick={() => void refreshProviderStatus()}
              disabled={providerStatusRefreshing}
              title="Refresh provider authorization status"
            >
              {providerStatusRefreshing ? "Refreshing…" : "Refresh"}
            </button>
          }
          subtitle={
            <>
              Click a provider to manage credentials. API keys are supported for hosted providers. CLI providers (
              <code>codex-cli</code>, <code>claude-code</code>) authenticate via OAuth.
            </>
          }
        >
          <div className="settingsList">
            {providerRows.map((p) => {
              const status = providerStatusByName[p];
              const pill = providerPill(p, providerStatusRefreshing, providerStatusByName);
              const message = status?.message || (providerStatusRefreshing ? "Checking…" : "Unknown status");
              const hasAccount = status?.account && (status.account.email || status.account.name);

              return (
                <button key={p} className="settingsProviderListRow" type="button" onClick={() => setActiveProvider(p)}>
                  <div className="settingsProviderListMain">
                    <div className="settingsProviderListTitle">{p}</div>
                    <div className="settingsProviderListMeta">{message}</div>
                    {hasAccount ? (
                      <div className="settingsProviderListMeta settingsProviderListMetaMono">{formatAccount(status?.account)}</div>
                    ) : null}
                  </div>
                  <div className="settingsProviderListRight">
                    <span className={"settingsPill " + pill.className}>{pill.label}</span>
                    <span className="settingsChevron" aria-hidden="true" />
                  </div>
                </button>
              );
            })}
          </div>
        </SettingsCard>
      )}

      {activeProvider ? (
        <div className="modalOverlay" onMouseDown={() => setActiveProvider(null)}>
          <div
            className="modal settingsProviderModal"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="settingsProviderModalHeader">
              <div className="settingsProviderModalHeaderLeft">
                <div className="settingsProviderModalTitle">{activeProvider}</div>
                <div className="settingsMeta">{activeStatus?.message || (providerStatusRefreshing ? "Checking…" : "Unknown status")}</div>
              </div>
              <span className={"settingsPill " + (activePill?.className ?? "settingsPillNeutral")}>
                {activePill?.label ?? "Unknown"}
              </span>
            </div>

            <div className="settingsProviderModalBody">
              {KEYLESS_PROVIDERS.has(activeProvider) ? (
                <div className="settingsMeta">
                  {activeProvider === "codex-cli" ? (
                    <>
                      Sign in with your ChatGPT account. If not verified, click <strong>Sign in</strong> to open the authorization flow.
                    </>
                  ) : (
                    <>
                      Sign in with your Claude account. If not verified, click <strong>Sign in</strong>. If that fails, use a terminal and run{" "}
                      <code>claude setup-token</code> to authenticate.
                    </>
                  )}
                </div>
              ) : (
                <div className="settingsMeta">API keys are supported for hosted providers and are stored globally (not per workspace).</div>
              )}

              <div className="settingsProviderBlock">
                <div className="settingsMeta">Authorization</div>
                <div className="settingsProviderModalActionRow">
                  <button
                    className="iconButton"
                    type="button"
                    onClick={() => void refreshProviderStatus()}
                    disabled={providerStatusRefreshing}
                    title="Refresh provider authorization status"
                  >
                    {providerStatusRefreshing ? "Refreshing…" : "Refresh"}
                  </button>

                  {KEYLESS_PROVIDERS.has(activeProvider) ? (
                    <button
                      className="modalButton modalButtonPrimary"
                      type="button"
                      onClick={() => {
                        void connectProvider(activeProvider);
                        setTimeout(() => void refreshProviderStatus(), 1200);
                      }}
                    >
                      {activeStatus?.authorized ? "Re-auth" : "Sign in"}
                    </button>
                  ) : (
                    <button
                      className="modalButton modalButtonPrimary"
                      type="button"
                      onClick={() => {
                        void connectProvider(activeProvider, activeApiKey);
                        setTimeout(() => void refreshProviderStatus(), 1200);
                      }}
                      title="Connect provider"
                    >
                      Connect
                    </button>
                  )}
                </div>
              </div>

              {KEYLESS_PROVIDERS.has(activeProvider) ? (
                <>
                  <div className="settingsProviderBlock">
                    <div className="settingsMeta">Account</div>
                    <div className="settingsMono">{formatAccount(activeStatus?.account)}</div>
                  </div>

                  {activeProvider === "claude-code" ? (
                    <div className="settingsProviderBlock">
                      <button
                        className="iconButton"
                        type="button"
                        onClick={() => setShowClaudeHelp((v) => !v)}
                        title="Show Claude Code sign-in help"
                      >
                        {showClaudeHelp ? "Hide help" : "How to sign in"}
                      </button>

                      {showClaudeHelp ? (
                        <div className="settingsProviderHelp">
                          <div className="settingsMeta">
                            Install: <code>npm install -g @anthropic-ai/claude-code</code>
                          </div>
                          <div className="settingsMeta">
                            Authenticate: run <code>claude setup-token</code> in a terminal and complete the browser sign-in flow (older versions may use <code>/login</code> inside the app).
                          </div>
                          <div className="settingsMeta">Return here and click Refresh.</div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="settingsProviderBlock">
                  <div className="settingsMeta">API key</div>
                  <div className="settingsKeyRow">
                    <input
                      className="settingsTextInput"
                      value={activeApiKey}
                      onChange={(e) => {
                        const next = e.currentTarget.value;
                        setApiKeysByProvider((s) => ({ ...s, [activeProvider]: next }));
                      }}
                      placeholder="Enter API key"
                      type={activeReveal ? "text" : "password"}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <button
                      className="iconButton"
                      type="button"
                      onClick={() => setRevealKeyByProvider((s) => ({ ...s, [activeProvider]: !(s[activeProvider] ?? false) }))}
                      title={activeReveal ? "Hide API key" : "Show API key"}
                    >
                      {activeReveal ? "Hide" : "Show"}
                    </button>
                  </div>
                  <div className="settingsMeta">
                    {activeStatus?.message || "Enter a key and click Save key. Keys are stored by the server (not per workspace)."}
                  </div>
                </div>
              )}

              <div className="settingsProviderBlock">
                <div className="settingsMeta">Models ({activeModels.length})</div>
                {activeModels.length === 0 ? (
                  <div className="settingsMeta">No curated model list for this provider in the UI.</div>
                ) : (
                  <div className="settingsModelChips">
                    {activeModels.map((m) => (
                      <span key={m} className="chip chipQuiet" title={m}>
                        {m}
                      </span>
                    ))}
                  </div>
                )}
                <div className="settingsMeta">
                  You can always enter a custom model id under <strong>Workspace defaults</strong>.
                </div>
              </div>
            </div>

            <div className="modalActions">
              <button className="modalButton" type="button" onClick={() => setActiveProvider(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
