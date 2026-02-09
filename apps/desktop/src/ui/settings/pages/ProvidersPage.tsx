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

  const ws = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces]
  );

  useEffect(() => {
    void refreshProviderStatus();
  }, [refreshProviderStatus]);

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
        <>
          <div className="settingsSectionHeader">
            <div className="settingsSectionHeaderLeft">
              <div className="settingsSectionTitle">Connections</div>
              <div className="settingsSectionSub">
                API keys are supported for hosted providers. CLI providers (<code>codex-cli</code>,{" "}
                <code>claude-code</code>) authenticate via OAuth and are verified by the server.
              </div>
            </div>
            <button
              className="iconButton"
              type="button"
              onClick={() => void refreshProviderStatus()}
              disabled={providerStatusRefreshing}
              title="Refresh provider authorization status"
            >
              {providerStatusRefreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          <div className="settingsProviderGrid">
            {PROVIDER_NAMES.filter((p) => !UI_DISABLED_PROVIDERS.has(p)).map((p) => {
              const models = MODEL_CHOICES[p] ?? [];
              const apiKey = apiKeysByProvider[p] ?? "";
              const reveal = revealKeyByProvider[p] ?? false;
              const modelsCount = models.length;
              const isKeyless = KEYLESS_PROVIDERS.has(p);
              const status = providerStatusByName[p];

              const pill = providerPill(p, providerStatusRefreshing, providerStatusByName);

              return (
                <div key={p} className="settingsProviderCard">
                  <div className="settingsProviderHeader">
                    <div className="settingsProviderName">{p}</div>
                    <span className={"settingsPill " + pill.className}>{pill.label}</span>
                  </div>

                  <div className="settingsProviderBody">
                    {isKeyless ? (
                      <>
                        <div className="settingsMeta">
                          {p === "codex-cli" ? (
                            <>
                              Sign in with your ChatGPT account. If not verified, click{" "}
                              <strong>Sign in</strong> to open the authorization flow.
                            </>
                          ) : (
                            <>
                              Sign in with your Claude account. If not verified, click{" "}
                              <strong>Sign in</strong>. If that fails, use a terminal and run{" "}
                              <code>claude setup-token</code> to authenticate.
                            </>
                          )}
                        </div>

                        <div className="settingsProviderBlock">
                          <div className="settingsMeta">Account</div>
                          <div className="settingsMono">{formatAccount(status?.account)}</div>
                        </div>

                        {p === "claude-code" ? (
                          <div className="settingsProviderActions">
                            <button
                              className="iconButton"
                              type="button"
                              onClick={() => setShowClaudeHelp((v) => !v)}
                              title="Show Claude Code sign-in help"
                            >
                              {showClaudeHelp ? "Hide help" : "How to sign in"}
                            </button>
                            <div className="settingsProviderActionsRight">
                              <button
                                className="iconButton"
                                type="button"
                                disabled={providerStatusRefreshing}
                                onClick={() => void refreshProviderStatus()}
                                title="Re-check authorization"
                              >
                                Refresh
                              </button>
                              <button
                                className="modalButton modalButtonPrimary"
                                type="button"
                                onClick={() => {
                                  void connectProvider(p);
                                  setTimeout(() => void refreshProviderStatus(), 1200);
                                }}
                                title="Start Claude sign-in"
                              >
                                Sign in
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="settingsProviderActions settingsProviderActionsEnd">
                            <button
                              className="iconButton"
                              type="button"
                              disabled={providerStatusRefreshing}
                              onClick={() => void refreshProviderStatus()}
                              title="Re-check authorization"
                            >
                              Refresh
                            </button>
                            <button
                              className="modalButton modalButtonPrimary"
                              type="button"
                              onClick={() => {
                                void connectProvider(p);
                                setTimeout(() => void refreshProviderStatus(), 1200);
                              }}
                              title="Start Codex sign-in"
                            >
                              {status?.authorized ? "Re-auth" : "Sign in"}
                            </button>
                          </div>
                        )}

                        {p === "claude-code" && showClaudeHelp ? (
                          <div className="settingsProviderHelp">
                            <div className="settingsMeta">
                              Install: <code>npm install -g @anthropic-ai/claude-code</code>
                            </div>
                            <div className="settingsMeta">
                              Authenticate: run <code>claude setup-token</code> in a terminal and complete the browser
                              sign-in flow (older versions may use <code>/login</code> inside the app).
                            </div>
                            <div className="settingsMeta">Return here and click Refresh.</div>
                          </div>
                        ) : null}

                        {status?.message ? <div className="settingsMeta">{status.message}</div> : null}
                      </>
                    ) : (
                      <>
                        <div className="settingsProviderBlock">
                          <div className="settingsMeta">API key (optional)</div>

                          <div className="settingsKeyRow">
                            <input
                              className="settingsTextInput"
                              value={apiKey}
                              onChange={(e) => {
                                const next = e.currentTarget.value;
                                setApiKeysByProvider((s) => ({ ...s, [p]: next }));
                              }}
                              placeholder="Enter API key"
                              type={reveal ? "text" : "password"}
                              autoCapitalize="none"
                              autoCorrect="off"
                              spellCheck={false}
                            />
                            <button
                              className="iconButton"
                              type="button"
                              onClick={() => setRevealKeyByProvider((s) => ({ ...s, [p]: !(s[p] ?? false) }))}
                              title={reveal ? "Hide API key" : "Show API key"}
                            >
                              {reveal ? "Hide" : "Show"}
                            </button>
                          </div>

                          {status?.message ? (
                            <div className="settingsMeta">{status.message}</div>
                          ) : (
                            <div className="settingsMeta">Status: unknown (click Refresh)</div>
                          )}
                        </div>

                        <div className="settingsProviderActions settingsProviderActionsEnd">
                          <button
                            className="modalButton modalButtonPrimary"
                            type="button"
                            onClick={() => {
                              void connectProvider(p, apiKey);
                              setApiKeysByProvider((s) => ({ ...s, [p]: "" }));
                              setRevealKeyByProvider((s) => ({ ...s, [p]: false }));
                              setTimeout(() => void refreshProviderStatus(), 1200);
                            }}
                            title="Connect provider"
                          >
                            Connect
                          </button>
                        </div>
                      </>
                    )}

                    <div className="settingsProviderModels">
                      <div className="settingsMeta">Models ({modelsCount})</div>
                      {modelsCount === 0 ? (
                        <div className="settingsMeta">No curated model list for this provider in the UI.</div>
                      ) : (
                        <div className="settingsModelChips">
                          {models.map((m) => (
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
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
