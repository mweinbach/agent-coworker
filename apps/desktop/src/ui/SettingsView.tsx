import { useMemo, useState } from "react";

import { useAppStore } from "../app/store";
import type { ProviderName } from "../lib/wsProtocol";
import { PROVIDER_NAMES } from "../lib/wsProtocol";
import { MODEL_CHOICES, UI_DISABLED_PROVIDERS } from "../lib/modelChoices";

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

  const [apiKeysByProvider, setApiKeysByProvider] = useState<Partial<Record<ProviderName, string>>>({});
  const [revealKeyByProvider, setRevealKeyByProvider] = useState<Partial<Record<ProviderName, boolean>>>({});

  const ws = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces]
  );

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

  return (
    <div style={{ padding: 18, overflow: "auto", flex: 1, minHeight: 0, boxSizing: "border-box" }}>
      <div style={{ maxWidth: 860 }}>
        <div style={{ fontSize: 18, fontWeight: 750, letterSpacing: "-0.02em" }}>Settings</div>
        <div style={{ marginTop: 6, color: "rgba(0,0,0,0.55)", maxWidth: 760 }}>
          Configure workspace defaults and connect providers. Provider credentials are stored globally (not per workspace).
        </div>

        <div style={{ marginTop: 18 }} className="inlineCard">
          <div style={{ fontWeight: 650 }}>Providers</div>
          <div style={{ marginTop: 6, color: "rgba(0,0,0,0.55)", maxWidth: 760 }}>
            One API key per provider. Connecting saves credentials under <code>~/.cowork/auth</code> via the server’s <code>connect_provider</code> flow.
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
                    {disabled ? <span className="pill">UI disabled</span> : null}
                  </div>

                  <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                    <label style={{ display: "grid", gap: 6 }}>
                      <div className="metaLine">API key (optional)</div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                          value={apiKey}
                          onChange={(e) => {
                            const next = e.currentTarget.value;
                            setApiKeysByProvider((s) => ({ ...s, [p]: next }));
                          }}
                          placeholder="Leave blank for OAuth-capable providers"
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

                    <div className="metaLine">
                      Leave blank for OAuth-capable providers (e.g. <code>codex-cli</code>, <code>claude-code</code>). <code>gemini-cli</code> OAuth requires a terminal TTY.
                    </div>

                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <button
                        className="modalButton modalButtonPrimary"
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          void connectProvider(p, apiKey);
                          setApiKeysByProvider((s) => ({ ...s, [p]: "" }));
                          setRevealKeyByProvider((s) => ({ ...s, [p]: false }));
                        }}
                        title={disabled ? "This provider is temporarily disabled in the UI" : "Connect provider"}
                      >
                        Connect
                      </button>
                    </div>
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
                      defaultModel: MODEL_CHOICES[v]?.[0] ?? "",
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
