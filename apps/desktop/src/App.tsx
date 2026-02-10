import { useEffect, useMemo } from "react";

import { useAppStore } from "./app/store";
import type { ProviderName } from "./lib/wsProtocol";
import { PROVIDER_NAMES } from "./lib/wsProtocol";
import { MODEL_CHOICES, UI_DISABLED_PROVIDERS } from "./lib/modelChoices";
import { defaultModelForProvider } from "@cowork/providers/catalog";

import { Sidebar } from "./ui/Sidebar";
import { ChatView } from "./ui/ChatView";
import { SkillsView } from "./ui/SkillsView";
import { SettingsShell } from "./ui/settings/SettingsShell";
import { PromptModal } from "./ui/PromptModal";

function ProviderSelect(props: { value: ProviderName; onChange: (v: ProviderName) => void }) {
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

export default function App() {
  const ready = useAppStore((s) => s.ready);
  const init = useAppStore((s) => s.init);

  const view = useAppStore((s) => s.view);
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);

  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const applyWorkspaceDefaultsToThread = useAppStore((s) => s.applyWorkspaceDefaultsToThread);
  const newThread = useAppStore((s) => s.newThread);

  useEffect(() => {
    if (ready) return;
    void init().catch((err) => {
      console.error(err);
    });
  }, [init, ready]);

  // Global keyboard shortcuts (Finding 11.1).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd/Ctrl+N → new thread
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        void newThread();
        return;
      }

      // Escape → close modal / cancel busy agent / close settings
      if (e.key === "Escape") {
        const state = useAppStore.getState();
        if (state.promptModal) {
          state.dismissPrompt();
          return;
        }
        if (state.view === "settings") {
          state.closeSettings();
          return;
        }
        if (state.selectedThreadId) {
          const rt = state.threadRuntimeById[state.selectedThreadId];
          if (rt?.busy) {
            state.cancelThread(state.selectedThreadId);
            return;
          }
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [newThread]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === selectedThreadId) ?? null,
    [selectedThreadId, threads]
  );
  const activeWorkspaceId = activeThread?.workspaceId ?? selectedWorkspaceId;
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces]
  );

  const rt = activeThread ? threadRuntimeById[activeThread.id] : null;
  const busy = rt?.busy === true;

  const provider = (activeWorkspace?.defaultProvider ?? "google") as ProviderName;
  const model = activeWorkspace?.defaultModel ?? "";
  const enableMcp = activeWorkspace?.defaultEnableMcp ?? true;

  const modelOptions = MODEL_CHOICES[provider] ?? [];
  const modelListId = `models-top-${provider}`;

  const showChatTopbarControls = view === "chat";

  if (view === "settings") {
    return (
      <div className="settingsRoot">
        {!ready ? (
          <div className="hero">
            <div className="heroTitle">Starting…</div>
            <div className="heroSub">Loading state and warming up.</div>
          </div>
        ) : (
          <SettingsShell />
        )}
        <PromptModal />
      </div>
    );
  }

  const title =
    view === "skills"
      ? "Skills"
      : view === "automations"
        ? "Automations"
        : activeThread?.title || "New thread";

  return (
    <div className="app">
      <Sidebar />

      <main className="main" role="main" aria-label="Chat area">
        <div className="topbar" role="toolbar" aria-label="Thread controls">
          <div className="topbarLeft">
            <div className="topbarTitle">{title}</div>
            {busy ? <span className="pill pillBusy">busy</span> : null}
          </div>

          <div className="topbarRight">
            {showChatTopbarControls ? (
              <>
                {activeWorkspace ? (
                  <>
                    <div className="chip" title="Provider and model (workspace default)">
                      <ProviderSelect
                        value={provider}
                        onChange={(v) => {
                          if (!activeWorkspace) return;
                          if (UI_DISABLED_PROVIDERS.has(v)) return;
                          void updateWorkspaceDefaults(activeWorkspace.id, {
                            defaultProvider: v,
                            defaultModel: defaultModelForProvider(v),
                          }).then(async () => {
                            if (activeThread) await applyWorkspaceDefaultsToThread(activeThread.id);
                          });
                        }}
                      />
                      <span style={{ color: "rgba(0,0,0,0.3)" }}>/</span>
                      <input
                        list={modelListId}
                        value={model}
                        onChange={(e) => {
                          if (!activeWorkspace) return;
                          const next = e.currentTarget.value;
                          void updateWorkspaceDefaults(activeWorkspace.id, { defaultModel: next }).then(async () => {
                            if (activeThread) await applyWorkspaceDefaultsToThread(activeThread.id);
                          });
                        }}
                        placeholder="model"
                      />
                      <datalist id={modelListId}>
                        {modelOptions.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </div>

                    <label className="chip" title="MCP (workspace default + session toggle)">
                      <input
                        type="checkbox"
                        checked={enableMcp}
                        onChange={(e) => {
                          if (!activeWorkspace) return;
                          const next = e.currentTarget.checked;
                          void updateWorkspaceDefaults(activeWorkspace.id, { defaultEnableMcp: next }).then(async () => {
                            if (activeThread) await applyWorkspaceDefaultsToThread(activeThread.id);
                          });
                        }}
                      />
                      <span>MCP</span>
                    </label>
                  </>
                ) : null}

                <button className="iconButton" type="button" onClick={() => void newThread()} title="New thread (Cmd+N)" aria-label="New thread">
                  New
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="content">
          {!ready ? (
            <div className="hero">
              <div className="heroTitle">Starting…</div>
              <div className="heroSub">Loading state and warming up.</div>
            </div>
          ) : view === "skills" ? (
            <SkillsView />
          ) : view === "automations" ? (
            <div className="hero">
              <div className="heroTitle">Automations</div>
              <div className="heroSub">Not implemented in v1.</div>
            </div>
          ) : (
            <ChatView />
          )}
        </div>
      </main>

      <PromptModal />
    </div>
  );
}
