import { useEffect, useMemo } from "react";

import { useAppStore } from "./app/store";
import type { ProviderName } from "./lib/wsProtocol";
import { MODEL_CHOICES, UI_DISABLED_PROVIDERS } from "./lib/modelChoices";
import { defaultModelForProvider } from "@cowork/providers/catalog";

import { Sidebar } from "./ui/Sidebar";
import { ChatView } from "./ui/ChatView";
import { SkillsView } from "./ui/SkillsView";
import { SettingsShell } from "./ui/settings/SettingsShell";
import { PromptModal } from "./ui/PromptModal";
import { CheckpointsModal } from "./ui/CheckpointsModal";

export default function App() {
  const ready = useAppStore((s) => s.ready);
  const startupError = useAppStore((s) => s.startupError);
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
  const openCheckpointsModal = useAppStore((s) => s.openCheckpointsModal);
  const checkpointThread = useAppStore((s) => s.checkpointThread);

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
        if (state.checkpointsModalThreadId) {
          state.closeCheckpointsModal();
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

  const showChatTopbarControls = view === "chat";
  const canShowBackups = showChatTopbarControls && activeThread?.status === "active";
  const backup = canShowBackups ? rt?.backup ?? null : null;
  const backupStatus = backup?.status ?? (canShowBackups && rt?.connected ? "initializing" : "offline");
  const lastCheckpoint = backup?.checkpoints?.[backup.checkpoints.length - 1] ?? null;
  const backupLabel =
    backupStatus === "ready"
      ? `Backups: ready${lastCheckpoint ? ` · ${lastCheckpoint.id}` : ""}`
      : backupStatus === "failed"
        ? "Backups: failed"
        : backupStatus === "initializing"
          ? "Backups: starting…"
          : "Backups: offline";
  const backupTitle =
    backup?.status === "failed" ? backup.failureReason ?? "Backups are unavailable for this session." : undefined;
  const backupActionsDisabled = !canShowBackups || !rt?.connected || !rt?.sessionId || busy;

  if (view === "settings") {
    return (
      <div className="settingsRoot">
        {!ready ? (
          <div className="hero">
            <div className="heroTitle">Starting…</div>
            <div className="heroSub">Loading state and warming up.</div>
          </div>
        ) : (
          <>
            {startupError ? (
              <div className="startupBanner" role="alert">
                <div className="startupBannerText">
                  Running with fresh local state due to an initialization error.
                </div>
                <button className="iconButton" type="button" onClick={() => void init()}>
                  Retry load
                </button>
              </div>
            ) : null}
            <SettingsShell />
          </>
        )}
        <PromptModal />
        <CheckpointsModal />
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
                {canShowBackups && activeThread ? (
                  <>
                    <button
                      className="chip chipQuiet chipButton"
                      type="button"
                      onClick={() => openCheckpointsModal(activeThread.id)}
                      title={backupTitle}
                    >
                      {backupLabel}
                    </button>

                    <button
                      className="iconButton"
                      type="button"
                      onClick={() => checkpointThread(activeThread.id)}
                      disabled={backupActionsDisabled || rt?.backupUi?.checkpointing === true || rt?.backup?.status !== "ready"}
                      title={rt?.backup?.status !== "ready" ? "Backups must be ready first" : "Create a checkpoint now"}
                    >
                      {rt?.backupUi?.checkpointing ? "Checkpointing…" : "Checkpoint"}
                    </button>
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
          ) : startupError ? (
            <div className="hero">
              <div className="heroTitle">Recovered with defaults</div>
              <div className="heroSub">{startupError}</div>
              <button className="iconButton" type="button" onClick={() => void init()}>
                Retry state load
              </button>
            </div>
          ) : view === "skills" ? (
            <SkillsView />
          ) : view === "automations" ? (
            <div className="hero">
              <div className="heroTitle">Automations</div>
              <div className="heroSub">Not implemented in v1.</div>
            </div>
          ) : (
            <ChatView
              hasWorkspace={Boolean(activeWorkspace)}
              provider={provider}
              model={model}
              modelOptions={modelOptions}
              enableMcp={enableMcp}
              onProviderChange={(v) => {
                if (!activeWorkspace) return;
                if (UI_DISABLED_PROVIDERS.has(v)) return;
                void updateWorkspaceDefaults(activeWorkspace.id, {
                  defaultProvider: v,
                  defaultModel: defaultModelForProvider(v),
                }).then(async () => {
                  if (activeThread) await applyWorkspaceDefaultsToThread(activeThread.id);
                });
              }}
              onModelChange={(next) => {
                if (!activeWorkspace) return;
                void updateWorkspaceDefaults(activeWorkspace.id, { defaultModel: next }).then(async () => {
                  if (activeThread) await applyWorkspaceDefaultsToThread(activeThread.id);
                });
              }}
              onEnableMcpChange={(next) => {
                if (!activeWorkspace) return;
                void updateWorkspaceDefaults(activeWorkspace.id, { defaultEnableMcp: next }).then(async () => {
                  if (activeThread) await applyWorkspaceDefaultsToThread(activeThread.id);
                });
              }}
            />
          )}
        </div>
      </main>

      <PromptModal />
      <CheckpointsModal />
    </div>
  );
}
