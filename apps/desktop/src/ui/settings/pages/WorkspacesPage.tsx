import { useMemo } from "react";

import { defaultModelForProvider } from "@cowork/providers/catalog";

import { useAppStore } from "../../../app/store";
import type { ProviderName } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { MODEL_CHOICES, modelOptionsForProvider, UI_DISABLED_PROVIDERS } from "../../../lib/modelChoices";

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

export function WorkspacesPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const restartWorkspaceServer = useAppStore((s) => s.restartWorkspaceServer);
  const developerMode = useAppStore((s) => s.developerMode);
  const setDeveloperMode = useAppStore((s) => s.setDeveloperMode);

  const ws = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces]
  );

  const provider = (ws?.defaultProvider ?? "google") as ProviderName;
  const model = (ws?.defaultModel ?? "").trim();
  const enableMcp = ws?.defaultEnableMcp ?? true;
  const yolo = ws?.yolo ?? false;

  const curatedModels = MODEL_CHOICES[provider] ?? [];
  const modelOptions = modelOptionsForProvider(provider, model);
  const hasCustomModel = Boolean(model && !curatedModels.includes(model));

  return (
    <div className="settingsStack">
      <div className="settingsPageHeader">
        <div className="settingsPageTitle">Workspaces</div>
        <div className="settingsPageSub">Choose a project folder and configure how the agent behaves in it.</div>
      </div>

      {workspaces.length === 0 || !ws ? (
        <div className="settingsCard">
          <div className="settingsCardBody settingsCardBody--centered">
            <button className="modalButton modalButtonPrimary" type="button" onClick={() => void addWorkspace()}>
              Add workspace
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* ── Workspace selector ── */}
          <div className="settingsCard">
            <div className="settingsCardHeader">
              <div className="settingsCardTitle">Active workspace</div>
              <button className="iconButton" type="button" onClick={() => void addWorkspace()}>
                Add
              </button>
            </div>
            <div className="settingsCardBody">
              <div className="settingsRow">
                <div className="settingsRowLeft">
                  <div className="settingsRowLabel">{ws.name}</div>
                  <div className="settingsRowHint">{ws.path}</div>
                </div>
                {workspaces.length > 1 && (
                  <select
                    className="settingsSelect"
                    value={ws.id}
                    onChange={(e) => void selectWorkspace(e.currentTarget.value)}
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          </div>

          {/* ── Model selection ── */}
          <div className="settingsCard">
            <div className="settingsCardHeader">
              <div className="settingsCardTitle">Model</div>
            </div>
            <div className="settingsCardSub">The default provider and model for new sessions in this workspace.</div>
            <div className="settingsCardBody">
              <div className="settingsRow">
                <div className="settingsRowLabel">Provider</div>
                <select
                  className="settingsSelect"
                  value={provider}
                  onChange={(e) => {
                    if (!ws) return;
                    const v = e.currentTarget.value as ProviderName;
                    if (UI_DISABLED_PROVIDERS.has(v)) return;
                    void updateWorkspaceDefaults(ws.id, { defaultProvider: v, defaultModel: defaultModelForProvider(v) });
                  }}
                >
                  {PROVIDER_NAMES.filter((p) => !UI_DISABLED_PROVIDERS.has(p)).map((p) => (
                    <option key={p} value={p}>{displayProviderName(p)}</option>
                  ))}
                </select>
              </div>

              <div className="settingsRow">
                <div className="settingsRowLabel">Model</div>
                <select
                  className="settingsSelect"
                  value={model}
                  onChange={(e) => ws && void updateWorkspaceDefaults(ws.id, { defaultModel: e.currentTarget.value })}
                >
                  {modelOptions.map((m) => (
                    <option key={m} value={m}>{hasCustomModel && m === model ? `${m} (custom)` : m}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* ── Behavior ── */}
          <div className="settingsCard">
            <div className="settingsCardHeader">
              <div className="settingsCardTitle">Behavior</div>
            </div>
            <div className="settingsCardBody">
              <div className="settingsRow">
                <div className="settingsRowLeft">
                  <div className="settingsRowLabel">MCP tools</div>
                  <div className="settingsRowHint">Allow the agent to use Model Context Protocol servers configured for this workspace.</div>
                </div>
                <input
                  type="checkbox"
                  checked={enableMcp}
                  onChange={(e) => ws && void updateWorkspaceDefaults(ws.id, { defaultEnableMcp: e.currentTarget.checked })}
                />
              </div>

              <div className="settingsRow">
                <div className="settingsRowLeft">
                  <div className="settingsRowLabel">Auto-approve commands</div>
                  <div className="settingsRowHint">Skip confirmation prompts for shell commands. The agent will run tools without asking first.</div>
                </div>
                <input
                  type="checkbox"
                  checked={yolo}
                  onChange={(e) => {
                    if (!ws) return;
                    const next = e.currentTarget.checked;
                    if (window.confirm(next ? "Enable auto-approve? The agent will run commands without asking." : "Disable auto-approve?")) {
                      void updateWorkspaceDefaults(ws.id, { yolo: next }).then(() => restartWorkspaceServer(ws.id));
                    }
                  }}
                />
              </div>

              <div className="settingsRow">
                <div className="settingsRowLeft">
                  <div className="settingsRowLabel">Developer mode</div>
                  <div className="settingsRowHint">Show internal system notices in the chat feed.</div>
                </div>
                <input
                  type="checkbox"
                  checked={developerMode}
                  onChange={(e) => setDeveloperMode(e.currentTarget.checked)}
                />
              </div>
            </div>
          </div>

          {/* ── Advanced ── */}
          <div className="settingsCard">
            <div className="settingsCardHeader">
              <div className="settingsCardTitle">Advanced</div>
            </div>
            <div className="settingsCardBody">
              <div className="settingsRow">
                <div className="settingsRowLeft">
                  <div className="settingsRowLabel">Restart server</div>
                  <div className="settingsRowHint">Restart the workspace agent server. Use this if the agent is unresponsive.</div>
                </div>
                <button className="iconButton" type="button" onClick={() => void restartWorkspaceServer(ws.id)}>
                  Restart
                </button>
              </div>

              <div className="settingsRow">
                <div className="settingsRowLeft">
                  <div className="settingsRowLabel">Remove workspace</div>
                  <div className="settingsRowHint">Remove this workspace from the app. Your files on disk are not affected.</div>
                </div>
                <button
                  className="modalButton modalButtonDanger"
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Remove workspace "${ws.name}"? Your files on disk won't be affected.`)) {
                      void removeWorkspace(ws.id);
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
