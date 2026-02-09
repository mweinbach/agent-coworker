import { useMemo } from "react";

import { defaultModelForProvider } from "@cowork/providers/catalog";

import { useAppStore } from "../../../app/store";
import type { ProviderName } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { MODEL_CHOICES, UI_DISABLED_PROVIDERS } from "../../../lib/modelChoices";

import { SettingsCard, SettingsPageHeader, SettingsRow } from "../components";

function ProviderSelect(props: { value: ProviderName; onChange: (v: ProviderName) => void }) {
  return (
    <select className="settingsSelect" value={props.value} onChange={(e) => props.onChange(e.currentTarget.value as ProviderName)}>
      {PROVIDER_NAMES.map((p) => (
        <option key={p} value={p} disabled={UI_DISABLED_PROVIDERS.has(p)}>
          {p}
        </option>
      ))}
    </select>
  );
}

export function WorkspacesPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const restartWorkspaceServer = useAppStore((s) => s.restartWorkspaceServer);

  const ws = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces]
  );

  const provider = (ws?.defaultProvider ?? "google") as ProviderName;
  const model = ws?.defaultModel ?? "";
  const enableMcp = ws?.defaultEnableMcp ?? true;
  const yolo = ws?.yolo ?? false;

  const modelOptions = MODEL_CHOICES[provider] ?? [];
  const modelInCatalog = modelOptions.includes(model);

  return (
    <div className="settingsStack">
      <SettingsPageHeader
        title="Workspaces"
        subtitle="Workspaces run their own server process. Defaults apply to new sessions and can be overridden per-thread."
      />

      {workspaces.length === 0 || !ws ? (
        <SettingsCard title="Workspaces" subtitle="Add a workspace to begin.">
          <div className="settingsEmpty">
            <button className="modalButton modalButtonPrimary" type="button" onClick={() => void addWorkspace()}>
              Add workspace
            </button>
          </div>
        </SettingsCard>
      ) : (
        <>
          <SettingsCard
            title="Workspace"
            right={
              <button className="iconButton" type="button" onClick={() => void addWorkspace()} title="Add workspace">
                Add
              </button>
            }
          >
            <div className="settingsRows">
              <SettingsRow
                label="Selected workspace"
                hint={<span className="settingsPathHint">{ws.path}</span>}
                control={
                  <select
                    className="settingsSelect"
                    value={ws.id}
                    onChange={(e) => void selectWorkspace(e.currentTarget.value)}
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                }
              />

              <SettingsRow
                label="Remove workspace"
                hint="This removes it from the app, but does not delete files on disk."
                control={
                  <button
                    className="modalButton modalButtonDanger"
                    type="button"
                    onClick={() => {
                      const ok = window.confirm(
                        `Remove workspace \"${ws.name}\"? This will remove its threads from the app, but will not delete files on disk.`
                      );
                      if (!ok) return;
                      void removeWorkspace(ws.id);
                    }}
                  >
                    Remove
                  </button>
                }
              />
            </div>
          </SettingsCard>

          <SettingsCard title="Workspace defaults" subtitle="These apply to new sessions in this workspace.">
            <div className="settingsRows">
              <SettingsRow
                label="Provider"
                hint={UI_DISABLED_PROVIDERS.has(provider) ? `Note: ${provider} is temporarily disabled in the UI.` : undefined}
                control={
                  <ProviderSelect
                    value={provider}
                    onChange={(v) => {
                      if (!ws) return;
                      if (UI_DISABLED_PROVIDERS.has(v)) return;
                      void updateWorkspaceDefaults(ws.id, { defaultProvider: v, defaultModel: defaultModelForProvider(v) });
                    }}
                  />
                }
              />

              <SettingsRow
                label="Model"
                control={
                  <select
                    className="settingsSelect"
                    value={model}
                    onChange={(e) => ws && void updateWorkspaceDefaults(ws.id, { defaultModel: e.currentTarget.value })}
                    disabled={modelOptions.length === 0}
                  >
                    {!modelInCatalog && model.trim() ? (
                      <option value={model} disabled>
                        {model} (not in catalog)
                      </option>
                    ) : null}
                    {modelOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                }
              />

              <SettingsRow
                label="Enable MCP tools"
                hint="Default for new threads (can be toggled per session)."
                control={
                  <input
                    type="checkbox"
                    checked={enableMcp}
                    onChange={(e) => ws && void updateWorkspaceDefaults(ws.id, { defaultEnableMcp: e.currentTarget.checked })}
                  />
                }
              />

              <SettingsRow
                label="YOLO mode"
                hint="Bypass approvals. Requires a server restart."
                control={
                  <input
                    type="checkbox"
                    checked={yolo}
                    onChange={(e) => {
                      if (!ws) return;
                      const next = e.currentTarget.checked;
                      const ok = window.confirm(
                        next
                          ? "Enable YOLO mode for this workspace server? This bypasses command approvals and requires a server restart."
                          : "Disable YOLO mode for this workspace server? This requires a server restart."
                      );
                      if (!ok) return;
                      void updateWorkspaceDefaults(ws.id, { yolo: next }).then(async () => {
                        await restartWorkspaceServer(ws.id);
                      });
                    }}
                  />
                }
              />

              <SettingsRow
                label="Restart workspace server"
                hint="Useful after changing environment variables or tooling."
                control={
                  <button className="iconButton" type="button" onClick={() => void restartWorkspaceServer(ws.id)}>
                    Restart
                  </button>
                }
              />
            </div>
          </SettingsCard>
        </>
      )}
    </div>
  );
}
