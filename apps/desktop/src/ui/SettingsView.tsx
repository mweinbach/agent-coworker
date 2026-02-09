import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../app/store";
import type { ProviderName } from "../lib/wsProtocol";
import { PROVIDER_NAMES } from "../lib/wsProtocol";
import { MODEL_CHOICES, UI_DISABLED_PROVIDERS } from "../lib/modelChoices";
import { defaultModelForProvider } from "@cowork/providers";

const KEYLESS_PROVIDERS = new Set<ProviderName>(["codex-cli", "claude-code"]);

function ProviderSelect(props: {
  value: ProviderName;
  onChange: (v: ProviderName) => void;
}) {
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.currentTarget.value as ProviderName)}>
      {PROVIDER_NAMES.map((p) => (
        <option key={p} value={p} disabled={UI_DISABLED_PROVIDERS.has(p)}>
          {p}
        </option>
      ))}
    </select>
  );
}

export function SettingsView() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const restartWorkspaceServer = useAppStore((s) => s.restartWorkspaceServer);
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

  if (!ws) {
    return (
      <div className="hero">
        <div className="heroTitle">Settings</div>
        <div className="heroSub">Add a workspace to begin.</div>
      </div>
    );
  }

  const provider = ws.defaultProvider ?? "google";
  const model = ws.defaultModel ?? "";
  const enableMcp = ws.defaultEnableMcp;
  const yolo = ws.yolo;

  const modelOptions = MODEL_CHOICES[provider] ?? [];
  const modelListId = `models-${provider}`;

  const formatAccount = (account: any): string => {
    const name = typeof account?.name === "string" ? account.name.trim() : "";
    const email = typeof account?.email === "string" ? account.email.trim() : "";
    if (name && email) return `${name} <${email}>`;
    return name || email || "Unavailable";
  };

  const statusPill = (p: ProviderName) => {
    const s = providerStatusByName[p];
    if (!s) return { label: providerStatusRefreshing ? "Checking…" : "Unknown", style: undefined as any };
    if (s.verified) {
      return {
        label: "Verified",
        style: { background: "rgba(0, 128, 64, 0.10)", borderColor: "rgba(0, 128, 64, 0.22)", color: "rgba(0,0,0,0.70)" },
      };
    }
    if (s.authorized) {
      return { label: "Authorized", style: { background: "var(--warn-bg)", borderColor: "rgba(162, 104, 0, 0.22)", color: "var(--warn)" } };
    }
    if (s.mode === "oauth_pending") {
      return { label: "Pending", style: { background: "var(--warn-bg)", borderColor: "rgba(162, 104, 0, 0.22)", color: "var(--warn)" } };
    }
    return { label: "Not authorized", style: { background: "var(--danger-bg)", borderColor: "rgba(194, 59, 59, 0.22)", color: "var(--danger)" } };
  };

  return (
    <div style={{ padding: 18, overflow: "auto", flex: 1, minHeight: 0, boxSizing: "border-box" }}>
      <div style={{ maxWidth: 860 }}>
        <div style={{ fontSize: 18, fontWeight: 750, letterSpacing: "-0.02em" }}>Settings</div>
        <div style={{ marginTop: 6, color: "rgba(0,0,0,0.55)", maxWidth: 760 }}>
          Configure workspace defaults and connect providers. Provider credentials are stored globally (not per workspace).
        </div>

        <div style={{ marginTop: 18 }} className="inlineCard">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontWeight: 650 }}>Providers</div>
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
          <div style={{ marginTop: 6, color: "rgba(0,0,0,0.55)", maxWidth: 760 }}>
            API keys are supported for hosted providers. CLI providers (<code>codex-cli</code>, <code>claude-code</code>) authenticate via OAuth and are verified by the server.
          </div>

          <div
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 12,
            }}
          >
            {PROVIDER_NAMES.map((p) => {
              const disabled = UI_DISABLED_PROVIDERS.has(p);
              const models = MODEL_CHOICES[p] ?? [];
              const apiKey = apiKeysByProvider[p] ?? "";
              const reveal = revealKeyByProvider[p] ?? false;
              const modelsCount = models.length;
              const isKeyless = KEYLESS_PROVIDERS.has(p);
              const status = providerStatusByName[p];
              const pill = statusPill(p);

              return (
                <div
                  key={p}
                  style={{
                    border: "1px solid rgba(0,0,0,0.10)",
                    background: "rgba(255,255,255,0.55)",
                    borderRadius: 14,
                    padding: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontWeight: 700, letterSpacing: "-0.01em" }}>{p}</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {disabled ? <span className="pill">UI disabled</span> : null}
                      {!disabled ? (
                        <span className="pill" style={pill.style}>
                          {pill.label}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                    {isKeyless ? (
                      <>
                        <div className="metaLine">
                          {p === "codex-cli" ? (
                            <>
                              Sign in with your ChatGPT account. If not verified, click <strong>Sign in</strong> to open the authorization flow.
                            </>
                          ) : (
                            <>
                              Sign in with your Claude account. If not verified, click <strong>Sign in</strong>. If that fails, use a terminal and run <code>claude</code> to authenticate.
                            </>
                          )}
                        </div>

                        <div style={{ display: "grid", gap: 6 }}>
                          <div className="metaLine">Account</div>
                          <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "rgba(0,0,0,0.72)" }}>
                            {formatAccount(status?.account)}
                          </div>
                        </div>

                        {p === "claude-code" ? (
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                            <button
                              className="iconButton"
                              type="button"
                              onClick={() => setShowClaudeHelp((v) => !v)}
                              title="Show Claude Code sign-in help"
                            >
                              {showClaudeHelp ? "Hide help" : "How to sign in"}
                            </button>
                            <div style={{ display: "flex", gap: 8 }}>
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
                                disabled={disabled}
                                onClick={() => {
                                  void connectProvider(p);
                                  setTimeout(() => void refreshProviderStatus(), 1200);
                                }}
                                title={disabled ? "This provider is temporarily disabled in the UI" : "Start Claude sign-in"}
                              >
                                Sign in
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
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
                              disabled={disabled}
                              onClick={() => {
                                void connectProvider(p);
                                setTimeout(() => void refreshProviderStatus(), 1200);
                              }}
                              title={disabled ? "This provider is temporarily disabled in the UI" : "Start Codex sign-in"}
                            >
                              {status?.authorized ? "Re-auth" : "Sign in"}
                            </button>
                          </div>
                        )}

                        {p === "claude-code" && showClaudeHelp ? (
                          <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
                            <div className="metaLine">
                              Install: <code>npm install -g @anthropic-ai/claude-code</code>
                            </div>
                            <div className="metaLine">
                              Authenticate: run <code>claude</code> in a terminal and complete the login flow (some versions use <code>/login</code> inside the app).
                            </div>
                            <div className="metaLine">Return here and click Refresh.</div>
                          </div>
                        ) : null}

                        {status?.message ? <div className="metaLine">{status.message}</div> : null}
                      </>
                    ) : (
                      <>
                        <label style={{ display: "grid", gap: 6 }}>
                          <div className="metaLine">API key (optional)</div>
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <input
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
                              style={{
                                flex: 1,
                                padding: "10px 12px",
                                borderRadius: 12,
                                border: "1px solid rgba(0,0,0,0.12)",
                                outline: "none",
                                background: "rgba(255,255,255,0.75)",
                              }}
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
                        </label>

                        {status?.message ? <div className="metaLine">{status.message}</div> : <div className="metaLine">Status: unknown (click Refresh)</div>}

                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <button
                        className="modalButton modalButtonPrimary"
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          void connectProvider(p, apiKey);
                          setApiKeysByProvider((s) => ({ ...s, [p]: "" }));
                          setRevealKeyByProvider((s) => ({ ...s, [p]: false }));
                          setTimeout(() => void refreshProviderStatus(), 1200);
                        }}
                        title={disabled ? "This provider is temporarily disabled in the UI" : "Connect provider"}
                      >
                        Connect
                      </button>
                    </div>
                      </>
                    )}
                  </div>

                  <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                    <div className="metaLine">Models ({modelsCount})</div>
                    {modelsCount === 0 ? (
                      <div className="metaLine">No curated model list for this provider in the UI.</div>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 120, overflow: "auto" }}>
                        {models.map((m) => (
                          <span key={m} className="chip chipQuiet" title={m}>
                            {m}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="metaLine">You can always enter a custom model id under Workspace defaults.</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: 18 }} className="inlineCard">
          <div style={{ fontWeight: 650 }}>Workspace defaults</div>
          <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div className="metaLine">Workspace</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <div style={{ fontWeight: 650 }}>{ws.name}</div>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,0.45)" }}>{ws.path}</div>
              </div>
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div className="metaLine">Provider</div>
              <div className="chip" style={{ width: "fit-content" }}>
                <ProviderSelect
                  value={provider}
                  onChange={(v) => {
                    if (UI_DISABLED_PROVIDERS.has(v)) return;
                    void updateWorkspaceDefaults(ws.id, {
                      defaultProvider: v,
                      defaultModel: defaultModelForProvider(v),
                    });
                  }}
                />
              </div>
              {UI_DISABLED_PROVIDERS.has(provider) ? (
                <div className="metaLine">Note: {provider} is temporarily disabled in the UI.</div>
              ) : null}
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div className="metaLine">Model</div>
              <div className="chip" style={{ width: "fit-content" }}>
                <input
                  list={modelListId}
                  placeholder="Model id"
                  value={model}
                  onChange={(e) => void updateWorkspaceDefaults(ws.id, { defaultModel: e.currentTarget.value })}
                />
              </div>
              <datalist id={modelListId}>
                {modelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>

            <label className="toggleRow">
              <input
                type="checkbox"
                checked={enableMcp}
                onChange={(e) => void updateWorkspaceDefaults(ws.id, { defaultEnableMcp: e.currentTarget.checked })}
              />
              Enable MCP tools by default
            </label>

            <label className="toggleRow">
              <input
                type="checkbox"
                checked={yolo}
                onChange={async (e) => {
                  const next = e.currentTarget.checked;
                  const ok = window.confirm(
                    next
                      ? "Enable YOLO mode for this workspace server? This bypasses command approvals and requires a server restart."
                      : "Disable YOLO mode for this workspace server? This requires a server restart."
                  );
                  if (!ok) return;
                  await updateWorkspaceDefaults(ws.id, { yolo: next });
                  await restartWorkspaceServer(ws.id);
                }}
              />
              YOLO mode (bypass approvals; restarts server)
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
