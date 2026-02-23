import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";

import {
  deleteTranscript,
  listDirectory,
  loadState,
  pickWorkspaceDirectory,
  readTranscript,
  stopWorkspaceServer,
  openPath,
  revealPath,
  copyPath,
  createDirectory,
  renamePath,
  trashPath,
} from "../lib/desktopCommands";
import type { ProviderName } from "../lib/wsProtocol";

import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  RUNTIME,
  appendThreadTranscript,
  basename,
  buildContextPreamble,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  isProviderName,
  makeId,
  mapTranscriptToFeed,
  normalizeProviderChoice,
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  sendControl,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  truncateTitle,
} from "./store.helpers";
import type { ThreadRecord, WorkspaceRecord } from "./types";

const optionalStringWithContentSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : undefined),
  z.string().optional()
);

const normalizedProviderSchema = z.preprocess(
  (value) => (isProviderName(value) ? value : "google"),
  z.custom<ProviderName>((value): value is ProviderName => isProviderName(value))
);

const normalizedThreadStatusSchema = z.preprocess(
  (value) => (value === "active" || value === "disconnected" ? value : "disconnected"),
  z.enum(["active", "disconnected"])
);

const normalizedSessionIdSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : null),
  z.string().nullable()
);

const normalizedLastEventSeqSchema = z.preprocess(
  (value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0),
  z.number().int().nonnegative()
);

const persistedWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  createdAt: z.string(),
  lastOpenedAt: z.string(),
  defaultProvider: normalizedProviderSchema,
  defaultModel: optionalStringWithContentSchema,
  defaultSubAgentModel: optionalStringWithContentSchema,
  defaultEnableMcp: z.preprocess((value) => (typeof value === "boolean" ? value : true), z.boolean()),
  yolo: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
}).passthrough().transform((workspace): WorkspaceRecord => {
  const model = workspace.defaultModel ?? defaultModelForProvider(workspace.defaultProvider);
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    createdAt: workspace.createdAt,
    lastOpenedAt: workspace.lastOpenedAt,
    defaultProvider: workspace.defaultProvider,
    defaultModel: model,
    defaultSubAgentModel: workspace.defaultSubAgentModel ?? model,
    defaultEnableMcp: workspace.defaultEnableMcp,
    yolo: workspace.yolo,
  };
});

const persistedThreadSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  titleSource: z.unknown().optional(),
  createdAt: z.string(),
  lastMessageAt: z.string(),
  status: normalizedThreadStatusSchema,
  sessionId: normalizedSessionIdSchema,
  lastEventSeq: normalizedLastEventSeqSchema,
}).passthrough().transform((thread): ThreadRecord => ({
  id: thread.id,
  workspaceId: thread.workspaceId,
  title: thread.title,
  titleSource: normalizeThreadTitleSource(thread.titleSource, thread.title),
  createdAt: thread.createdAt,
  lastMessageAt: thread.lastMessageAt,
  status: thread.status,
  sessionId: thread.sessionId,
  lastEventSeq: thread.lastEventSeq,
}));

const persistedStateSchema = z.object({
  workspaces: z.preprocess((value) => value ?? [], z.array(persistedWorkspaceSchema)),
  threads: z.preprocess((value) => value ?? [], z.array(persistedThreadSchema)),
  developerMode: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
  showHiddenFiles: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
}).passthrough().transform((state) => {
  const selectedWorkspaceId = state.workspaces[0]?.id ?? null;
  const selectedThreadId =
    selectedWorkspaceId
      ? state.threads.find((thread) => thread.workspaceId === selectedWorkspaceId && thread.status === "active")?.id ?? null
      : null;
  return {
    workspaces: state.workspaces,
    threads: state.threads,
    selectedWorkspaceId,
    selectedThreadId,
    developerMode: state.developerMode,
    showHiddenFiles: state.showHiddenFiles,
  };
});

export function createAppActions(set: StoreSet, get: StoreGet): AppStoreActions {
  const closeControlSession = (workspaceId: string) => {
    sendControl(get, workspaceId, (sessionId) => ({ type: "session_close", sessionId }));
  };

  const closeThreadSession = (threadId: string) => {
    sendThread(get, threadId, (sessionId) => ({ type: "session_close", sessionId }));
  };

  return {
    init: async () => {
      set({ startupError: null });
      try {
        const state = persistedStateSchema.parse(await loadState());
        set({
          workspaces: state.workspaces,
          threads: state.threads,
          selectedWorkspaceId: state.selectedWorkspaceId,
          selectedThreadId: state.selectedThreadId,
          developerMode: state.developerMode,
          showHiddenFiles: state.showHiddenFiles,
          ready: true,
          startupError: null,
        });
        return;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("Desktop init failed:", error);
        set((s) => ({
          workspaces: [],
          threads: [],
          selectedWorkspaceId: null,
          selectedThreadId: null,
          workspaceRuntimeById: {},
          threadRuntimeById: {},
          providerCatalog: [],
          providerDefaultModelByProvider: {},
          providerConnected: [],
          providerAuthMethodsByProvider: {},
          providerLastAuthChallenge: null,
          providerLastAuthResult: null,
          ready: true,
          startupError: detail,
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Startup recovery mode",
            detail,
          }),
        }));
        return;
      }
    },
  
    openSettings: (page) => {
      set((s) => ({
        view: "settings",
        settingsPage: page ?? s.settingsPage,
        lastNonSettingsView: s.view === "settings" ? s.lastNonSettingsView : s.view,
      }));
    },
  
    closeSettings: () => {
      set((s) => ({
        view: s.lastNonSettingsView === "settings" ? "chat" : s.lastNonSettingsView,
      }));
    },
  
    setSettingsPage: (page) => set({ settingsPage: page }),
  
    addWorkspace: async () => {
      if (RUNTIME.workspacePickerOpen) return;
      RUNTIME.workspacePickerOpen = true;
  
      let dir: string | null = null;
      try {
        dir = await pickWorkspaceDirectory();
      } finally {
        RUNTIME.workspacePickerOpen = false;
      }
      if (!dir) return;
  
      const existing = get().workspaces.find((w) => w.path === dir);
      if (existing) {
        await get().selectWorkspace(existing.id);
        return;
      }
  
      const stayInSettings = get().view === "settings";
      const ws: WorkspaceRecord = {
        id: makeId(),
        name: basename(dir),
        path: dir,
        createdAt: nowIso(),
        lastOpenedAt: nowIso(),
        defaultProvider: "google",
        defaultModel: defaultModelForProvider("google"),
        defaultSubAgentModel: defaultModelForProvider("google"),
        defaultEnableMcp: true,
        yolo: false,
      };
  
      set((s) => ({
        workspaces: [ws, ...s.workspaces],
        selectedWorkspaceId: ws.id,
        view: stayInSettings ? "settings" : "chat",
      }));
      ensureWorkspaceRuntime(get, set, ws.id);
      await persistNow(get);
      await get().selectWorkspace(ws.id);
    },
  
    removeWorkspace: async (workspaceId: string) => {
      const control = RUNTIME.controlSockets.get(workspaceId);
      closeControlSession(workspaceId);
      RUNTIME.controlSockets.delete(workspaceId);
      try {
        control?.close();
      } catch {
        // ignore
      }
  
      for (const thread of get().threads) {
        if (thread.workspaceId !== workspaceId) continue;
        const sock = RUNTIME.threadSockets.get(thread.id);
        closeThreadSession(thread.id);
        RUNTIME.threadSockets.delete(thread.id);
        RUNTIME.optimisticUserMessageIds.delete(thread.id);
        RUNTIME.pendingThreadMessages.delete(thread.id);
        RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(thread.id);
        RUNTIME.modelStreamByThread.delete(thread.id);
        try {
          sock?.close();
        } catch {
          // ignore
        }
      }
  
      try {
        await stopWorkspaceServer({ workspaceId });
      } catch {
        // ignore
      }
  
      set((s) => {
        const remainingWorkspaces = s.workspaces.filter((w) => w.id !== workspaceId);
        const remainingThreads = s.threads.filter((t) => t.workspaceId !== workspaceId);
        const selectedWorkspaceId = s.selectedWorkspaceId === workspaceId ? (remainingWorkspaces[0]?.id ?? null) : s.selectedWorkspaceId;
        const selectedThreadId =
          s.selectedThreadId && remainingThreads.some((t) => t.id === s.selectedThreadId) ? s.selectedThreadId : null;
      return {
          workspaces: remainingWorkspaces,
          threads: remainingThreads,
          selectedWorkspaceId,
          selectedThreadId,
        };
      });
      await persistNow(get);
    },
  
    removeThread: async (threadId: string) => {
      const sock = RUNTIME.threadSockets.get(threadId);
      closeThreadSession(threadId);
      RUNTIME.threadSockets.delete(threadId);
      RUNTIME.optimisticUserMessageIds.delete(threadId);
      RUNTIME.pendingThreadMessages.delete(threadId);
      RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(threadId);
      RUNTIME.modelStreamByThread.delete(threadId);
      try {
        sock?.close();
      } catch {
        // ignore
      }
  
      set((s) => {
        const remainingThreads = s.threads.filter((t) => t.id !== threadId);
        const selectedThreadId = s.selectedThreadId === threadId ? null : s.selectedThreadId;
        const nextPromptModal = s.promptModal?.threadId === threadId ? null : s.promptModal;
  
        const nextThreadRuntimeById = { ...s.threadRuntimeById };
        delete nextThreadRuntimeById[threadId];
  
      return {
          threads: remainingThreads,
          selectedThreadId,
          promptModal: nextPromptModal,
          threadRuntimeById: nextThreadRuntimeById,
        };
      });
  
      try {
        await deleteTranscript({ threadId });
      } catch {
        // ignore
      }

      await persistNow(get);
    },

    deleteThreadHistory: async (threadId: string) => {
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
      const targetSessionId = get().threadRuntimeById[threadId]?.sessionId ?? thread.sessionId;

      await get().removeThread(threadId);

      if (!targetSessionId) return;

      await ensureServerRunning(get, set, thread.workspaceId);
      ensureControlSocket(get, set, thread.workspaceId);
      const ok = sendControl(get, thread.workspaceId, (sessionId) => ({
        type: "delete_session",
        sessionId,
        targetSessionId,
      }));

      if (ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Session history deleted",
            detail: targetSessionId,
          }),
        }));
        return;
      }

      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Delete session history failed",
          detail: "Control session is unavailable.",
        }),
      }));
    },
  
    renameThread: (threadId: string, newTitle: string) => {
      const trimmed = newTitle.trim();
      if (!trimmed) return;

      set((s) => ({
        threads: s.threads.map((t) => (t.id === threadId ? { ...t, title: trimmed, titleSource: "manual" } : t)),
      }));
      void persistNow(get);

      sendThread(get, threadId, (sessionId) => ({
        type: "set_session_title",
        sessionId,
        title: trimmed,
      }));
    },

    selectWorkspace: async (workspaceId: string) => {
      set((s) => ({
        selectedWorkspaceId: workspaceId,
        view: s.view === "settings" ? "settings" : "chat",
      }));
      ensureWorkspaceRuntime(get, set, workspaceId);
  
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
  
      set((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, lastOpenedAt: nowIso() } : w)),
      }));
      await persistNow(get);
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
    },
  
    newThread: async (opts) => {
      let workspaceId = opts?.workspaceId ?? get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        await get().addWorkspace();
        workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
        if (!workspaceId) return;
      }
  
      if (get().selectedWorkspaceId !== workspaceId) {
        set({ selectedWorkspaceId: workspaceId });
      }
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const wsRt = get().workspaceRuntimeById[workspaceId];
      const url = wsRt?.serverUrl;
      if (!url) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Unable to create session",
            detail: wsRt?.error ?? "Workspace server is not ready.",
          }),
        }));
        return;
      }
  
      const threadId = makeId();
      const createdAt = nowIso();
      const title = opts?.titleHint ? truncateTitle(opts.titleHint) : "New thread";
  
      const thread: ThreadRecord = {
        id: threadId,
        workspaceId,
        title,
        titleSource: "default",
        createdAt,
        lastMessageAt: createdAt,
        status: "active",
        sessionId: null,
        lastEventSeq: 0,
      };
  
      set((s) => ({
        threads: [thread, ...s.threads],
        selectedThreadId: threadId,
        view: "chat",
      }));
      ensureThreadRuntime(get, set, threadId);
      set((s) => ({
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...s.threadRuntimeById[threadId], transcriptOnly: false },
        },
      }));
      await persistNow(get);
  
      ensureThreadSocket(get, set, threadId, url, opts?.firstMessage);
    },
  
    selectThread: async (threadId: string) => {
      set({ selectedThreadId: threadId, view: "chat" });
      ensureThreadRuntime(get, set, threadId);
  
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
  
      const rt = get().threadRuntimeById[threadId];
      const alreadyLoaded = rt?.feed && rt.feed.length > 0;
      if (!alreadyLoaded) {
        const transcript = await readTranscript({ threadId });
        const feed = mapTranscriptToFeed(transcript);
        set((s) => ({
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...s.threadRuntimeById[threadId], feed, transcriptOnly: false },
          },
        }));
      }
  
      set((s) => ({
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...s.threadRuntimeById[threadId], transcriptOnly: false },
        },
      }));
  
      await get().reconnectThread(threadId);
    },
  
    reconnectThread: async (threadId: string, firstMessage?: string) => {
      ensureThreadRuntime(get, set, threadId);
  
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
  
      await get().selectWorkspace(thread.workspaceId);
      await ensureServerRunning(get, set, thread.workspaceId);
      ensureControlSocket(get, set, thread.workspaceId);
  
      const url = get().workspaceRuntimeById[thread.workspaceId]?.serverUrl;
      if (!url) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Workspace server unavailable",
            detail: "Workspace server is not ready.",
          }),
        }));
        return;
      }
  
      if (firstMessage && firstMessage.trim()) {
        queuePendingThreadMessage(threadId, firstMessage);
      }
      ensureThreadSocket(get, set, threadId, url);
    },
  
    sendMessage: async (text: string) => {
      const activeThreadId = get().selectedThreadId;
      if (!activeThreadId) return;
  
      const thread = get().threads.find((t) => t.id === activeThreadId);
      if (!thread) return;
  
      const rt = get().threadRuntimeById[activeThreadId];
      const trimmed = text.trim();
      if (!trimmed) return;
  
      if (rt?.transcriptOnly) {
        const preamble = get().injectContext ? buildContextPreamble(rt?.feed ?? []) : "";
        const firstMessage = preamble ? `${preamble}${trimmed}` : trimmed;
        await get().newThread({ workspaceId: thread.workspaceId, titleHint: thread.title, firstMessage });
        set({ composerText: "" });
        return;
      }
  
      if (thread.status !== "active" || !rt?.sessionId) {
        const preamble = get().injectContext ? buildContextPreamble(rt?.feed ?? []) : "";
        const firstMessage = preamble ? `${preamble}${trimmed}` : trimmed;
        await get().reconnectThread(activeThreadId, firstMessage);
        set({ composerText: "" });
        return;
      }
  
      if (rt.busy) return;
  
      const ok = sendUserMessageToThread(get, set, activeThreadId, trimmed);
      if (!ok) return;
  
      set({ composerText: "" });
    },
  
    cancelThread: (threadId: string) => {
      const ok = sendThread(get, threadId, (sid) => ({ type: "cancel", sessionId: sid }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to cancel this run.",
          }),
        }));
      }
    },
  
    setThreadModel: (threadId, provider, model) => {
      const rt = get().threadRuntimeById[threadId];
      if (!rt?.sessionId) return;
      const ok = sendThread(get, threadId, (sessionId) => ({
        type: "set_model",
        sessionId,
        provider,
        model,
      }));
      if (ok) {
        appendThreadTranscript(threadId, "client", { type: "set_model", sessionId: rt.sessionId, provider, model });
      }
    },
    setComposerText: (text) => set({ composerText: text }),
    setInjectContext: (v) => set({ injectContext: v }),
    setDeveloperMode: (v) => {
      set({ developerMode: v });
      void persistNow(get);
    },
    setShowHiddenFiles: (v) => {
      set({ showHiddenFiles: v });
      void persistNow(get);
      const wsId = get().selectedWorkspaceId;
      if (wsId) {
        void get().refreshWorkspaceFiles(wsId);
      }
    },
  
    openSkills: async () => {
      let workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        await get().addWorkspace();
        workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
        if (!workspaceId) {
          set((s) => ({
            notifications: pushNotification(s.notifications, {
              id: makeId(),
              ts: nowIso(),
              kind: "info",
              title: "Skills need a workspace",
              detail: "Add or select a workspace first.",
            }),
          }));
          return;
        }
      }
  
      set({ view: "skills", selectedWorkspaceId: workspaceId });
      ensureWorkspaceRuntime(get, set, workspaceId);
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
      if (sid) {
        const sock = RUNTIME.controlSockets.get(workspaceId);
        try {
          sock?.send({ type: "list_skills", sessionId: sid });
        } catch {
          // ignore
        }
      }
    },
  
    selectSkill: async (skillName: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "read_skill", sessionId, skillName }));
      if (!ok) return;
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], selectedSkillName: skillName, selectedSkillContent: null },
        },
      }));
    },
  
    disableSkill: async (skillName: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "disable_skill", sessionId, skillName }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to disable skill." }),
        }));
      }
    },
  
    enableSkill: async (skillName: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "enable_skill", sessionId, skillName }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to enable skill." }),
        }));
      }
    },
  
    deleteSkill: async (skillName: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "delete_skill", sessionId, skillName }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to delete skill." }),
        }));
      }
    },
  
    applyWorkspaceDefaultsToThread: async (threadId: string) => {
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
      const ws = get().workspaces.find((w) => w.id === thread.workspaceId);
      if (!ws) return;
      const rt = get().threadRuntimeById[threadId];
      if (!rt?.sessionId) return;
      if (rt.busy) {
        RUNTIME.pendingWorkspaceDefaultApplyThreadIds.add(threadId);
        return;
      }
      RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(threadId);
  
      const inferredProvider =
        ws.defaultProvider && isProviderName(ws.defaultProvider)
          ? ws.defaultProvider
          : isProviderName((rt.config as any)?.provider)
            ? ((rt.config as any).provider as ProviderName)
            : "google";
  
      const provider = normalizeProviderChoice(inferredProvider);
      const model = (ws.defaultModel?.trim() || rt.config?.model?.trim() || "") || undefined;
      const subAgentModel =
        (ws.defaultSubAgentModel?.trim() || ws.defaultModel?.trim() || rt.sessionConfig?.subAgentModel?.trim() || "") || undefined;
  
      if (provider && model) {
        const ok = sendThread(get, threadId, (sessionId) => ({
          type: "set_model",
          sessionId,
          provider,
          model,
        }));
        if (ok) appendThreadTranscript(threadId, "client", { type: "set_model", sessionId: rt.sessionId, provider, model });
      }

      if (subAgentModel) {
        const okConfig = sendThread(get, threadId, (sessionId) => ({
          type: "set_config",
          sessionId,
          config: {
            subAgentModel,
          },
        }));
        if (okConfig) {
          appendThreadTranscript(threadId, "client", {
            type: "set_config",
            sessionId: rt.sessionId,
            config: { subAgentModel },
          });
        }
      }
  
      const okMcp = sendThread(get, threadId, (sessionId) => ({
        type: "set_enable_mcp",
        sessionId,
        enableMcp: ws.defaultEnableMcp,
      }));
      if (okMcp) {
        appendThreadTranscript(threadId, "client", { type: "set_enable_mcp", sessionId: rt.sessionId, enableMcp: ws.defaultEnableMcp });
      }
    },
  
    updateWorkspaceDefaults: async (workspaceId, patch) => {
      set((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, ...patch } : w)),
      }));
      await persistNow(get);

      const shouldSyncCoreSettings =
        patch.defaultProvider !== undefined ||
        patch.defaultModel !== undefined ||
        patch.defaultSubAgentModel !== undefined ||
        patch.defaultEnableMcp !== undefined;
      if (!shouldSyncCoreSettings) {
        return;
      }

      const workspace = get().workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return;

      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const provider = normalizeProviderChoice(
        workspace.defaultProvider && isProviderName(workspace.defaultProvider)
          ? workspace.defaultProvider
          : "google"
      );
      const model = workspace.defaultModel?.trim() || defaultModelForProvider(provider);
      const subAgentModel = workspace.defaultSubAgentModel?.trim() || model;

      const modelPersisted = sendControl(get, workspaceId, (sessionId) => ({
        type: "set_model",
        sessionId,
        provider,
        model,
      }));
      const subAgentPersisted = sendControl(get, workspaceId, (sessionId) => ({
        type: "set_config",
        sessionId,
        config: {
          subAgentModel,
        },
      }));
      const mcpPersisted = sendControl(get, workspaceId, (sessionId) => ({
        type: "set_enable_mcp",
        sessionId,
        enableMcp: workspace.defaultEnableMcp,
      }));

      if (!modelPersisted || !subAgentPersisted || !mcpPersisted) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Workspace settings partially applied",
            detail: "Control session is not fully connected yet. Reopen the workspace settings to retry.",
          }),
        }));
      }

      const threadIds = get()
        .threads.filter((thread) => thread.workspaceId === workspaceId)
        .map((thread) => thread.id);
      for (const threadId of threadIds) {
        void get().applyWorkspaceDefaultsToThread(threadId);
      }
    },
  
    restartWorkspaceServer: async (workspaceId) => {
      const control = RUNTIME.controlSockets.get(workspaceId);
      closeControlSession(workspaceId);
      control?.close();
      RUNTIME.controlSockets.delete(workspaceId);

      for (const thread of get().threads) {
        if (thread.workspaceId !== workspaceId) continue;
        const sock = RUNTIME.threadSockets.get(thread.id);
        closeThreadSession(thread.id);
        sock?.close();
        RUNTIME.threadSockets.delete(thread.id);
        RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(thread.id);
      }
  
      try {
        await stopWorkspaceServer({ workspaceId });
      } catch {
        // ignore
      }
  
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            serverUrl: null,
            controlSessionId: null,
            controlConfig: null,
            controlSessionConfig: null,
          },
        },
      }));
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
    },

    requestWorkspaceMcpServers: async (workspaceId: string) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "mcp_servers_get", sessionId }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request MCP servers.",
          }),
        }));
      }
    },

    upsertWorkspaceMcpServer: async (workspaceId, server, previousName) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_server_upsert",
        sessionId,
        server,
        previousName,
      }));
      if (ok) return;

      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to save MCP server.",
        }),
      }));
    },

    deleteWorkspaceMcpServer: async (workspaceId, name) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_server_delete",
        sessionId,
        name,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to delete MCP server.",
        }),
      }));
    },

    validateWorkspaceMcpServer: async (workspaceId, name) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_server_validate",
        sessionId,
        name,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to validate MCP server.",
        }),
      }));
    },

    authorizeWorkspaceMcpServerAuth: async (workspaceId, name) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_server_auth_authorize",
        sessionId,
        name,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to start MCP auth flow.",
        }),
      }));
    },

    callbackWorkspaceMcpServerAuth: async (workspaceId, name, code) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_server_auth_callback",
        sessionId,
        name,
        code: code?.trim() ? code.trim() : undefined,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to complete MCP auth callback.",
        }),
      }));
    },

    setWorkspaceMcpServerApiKey: async (workspaceId, name, apiKey) => {
      const trimmedKey = apiKey.trim();
      if (!trimmedKey) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Missing API key",
            detail: "Enter an API key before saving.",
          }),
        }));
        return;
      }
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_server_auth_set_api_key",
        sessionId,
        name,
        apiKey: trimmedKey,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to save MCP API key.",
        }),
      }));
    },

    migrateWorkspaceMcpLegacy: async (workspaceId, scope) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_servers_migrate_legacy",
        sessionId,
        scope,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to migrate legacy MCP servers.",
        }),
      }));
    },
  
    connectProvider: async (provider, apiKey) => {
      const methods = providerAuthMethodsFor(get(), provider);
      const normalizedKey = (apiKey ?? "").trim();
  
      if (normalizedKey) {
        const apiMethod = methods.find((method) => method.type === "api") ?? { id: "api_key", type: "api", label: "API key" };
        await get().setProviderApiKey(provider, apiMethod.id, normalizedKey);
        return;
      }
  
      const oauthMethod = methods.find((method) => method.type === "oauth");
      if (oauthMethod) {
        await get().authorizeProviderAuth(provider, oauthMethod.id);
        if (oauthMethod.oauthMode !== "code") {
          await get().callbackProviderAuth(provider, oauthMethod.id);
        }
        return;
      }
  
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "info",
          title: "API key required",
          detail: `Enter an API key to connect ${provider}.`,
        }),
      }));
    },
  
    setProviderApiKey: async (provider, methodId, apiKey) => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
  
      const trimmedKey = apiKey.trim();
      if (!trimmedKey) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Missing API key",
            detail: "Enter an API key before saving.",
          }),
        }));
        return;
      }
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "provider_auth_set_api_key",
        sessionId,
        provider,
        methodId: methodId.trim() || "api_key",
        apiKey: trimmedKey,
      }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to send provider_auth_set_api_key." }),
        }));
      }
    },
  
    authorizeProviderAuth: async (provider, methodId) => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const normalizedMethodId = methodId.trim();
      if (!normalizedMethodId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Missing auth method",
            detail: "Choose an auth method before continuing.",
          }),
        }));
        return;
      }
  
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "provider_auth_authorize",
        sessionId,
        provider,
        methodId: normalizedMethodId,
      }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to send provider_auth_authorize.",
          }),
        }));
      }
    },
  
    callbackProviderAuth: async (provider, methodId, code) => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const normalizedMethodId = methodId.trim();
      if (!normalizedMethodId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Missing auth method",
            detail: "Choose an auth method before continuing.",
          }),
        }));
        return;
      }
  
      const normalizedCode = code?.trim();
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "provider_auth_callback",
        sessionId,
        provider,
        methodId: normalizedMethodId,
        code: normalizedCode || undefined,
      }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to send provider_auth_callback.",
          }),
        }));
      }
    },
  
    requestProviderCatalog: async () => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) return;
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "provider_catalog_get", sessionId }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request provider catalog.",
          }),
        }));
      }
    },
  
    requestProviderAuthMethods: async () => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) return;
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "provider_auth_methods_get", sessionId }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request provider auth methods.",
          }),
        }));
      }
    },
  
    refreshProviderStatus: async () => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) return;
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      set({ providerStatusRefreshing: true });
      const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
      const sock = RUNTIME.controlSockets.get(workspaceId);
      if (!sid || !sock) {
        set({ providerStatusRefreshing: false });
        return;
      }
  
      try {
        sock.send({ type: "refresh_provider_status", sessionId: sid });
        sock.send({ type: "provider_catalog_get", sessionId: sid });
        sock.send({ type: "provider_auth_methods_get", sessionId: sid });
      } catch {
        set((s) => ({
          providerStatusRefreshing: false,
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to refresh provider status." }),
        }));
      }
    },
  
    answerAsk: (threadId, requestId, answer) => {
      const sent = sendThread(get, threadId, (sessionId) => ({ type: "ask_response", sessionId, requestId, answer }));
      if (!sent) {
        // Socket disconnected — keep the modal open so the user can retry
        // once reconnected rather than silently swallowing the answer.
        return;
      }
      appendThreadTranscript(threadId, "client", { type: "ask_response", sessionId: get().threadRuntimeById[threadId]?.sessionId, requestId, answer });
      set({ promptModal: null });
    },
  
    answerApproval: (threadId, requestId, approved) => {
      sendThread(get, threadId, (sessionId) => ({ type: "approval_response", sessionId, requestId, approved }));
      appendThreadTranscript(threadId, "client", { type: "approval_response", sessionId: get().threadRuntimeById[threadId]?.sessionId, requestId, approved });
      set({ promptModal: null });
    },
  
    dismissPrompt: () => set({ promptModal: null }),
  
    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    toggleContextSidebar: () => set((s) => ({ contextSidebarCollapsed: !s.contextSidebarCollapsed })),
  
    setSidebarWidth: (width: number) => set({ sidebarWidth: Math.max(180, Math.min(600, width)) }),
    setContextSidebarWidth: (width: number) => set({ contextSidebarWidth: Math.max(200, Math.min(600, width)) }),
    setMessageBarHeight: (height: number) => set({ messageBarHeight: Math.max(80, Math.min(500, height)) }),
  
    refreshWorkspaceFiles: async (workspaceId: string) => {
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
      const state = get();
      const currentExp = state.workspaceExplorerById[workspaceId];
      const targetPath = currentExp?.currentPath ?? ws.path;
      await get().navigateWorkspaceFiles(workspaceId, targetPath);
    },

    navigateWorkspaceFiles: async (workspaceId: string, targetPath: string) => {
      const state = get();
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;

      const requestId = Date.now();
      const prev = state.workspaceExplorerById[workspaceId] ?? {
        rootPath: ws.path,
        currentPath: ws.path,
        entries: [],
        selectedPath: null,
        loading: false,
        error: null,
        requestId: 0,
      };

      set((s) => ({
        workspaceExplorerById: {
          ...s.workspaceExplorerById,
          [workspaceId]: { ...prev, currentPath: targetPath, loading: true, error: null, requestId },
        },
      }));

      try {
        const entries = await listDirectory({ path: targetPath, includeHidden: get().showHiddenFiles });
        const current = get().workspaceExplorerById[workspaceId];
        if (current?.requestId !== requestId) return; // Stale

        set((s) => ({
          workspaceExplorerById: {
            ...s.workspaceExplorerById,
            [workspaceId]: {
              ...current,
              entries,
              loading: false,
              selectedPath: null,
            },
          },
        }));
      } catch (err) {
        const current = get().workspaceExplorerById[workspaceId];
        if (current?.requestId !== requestId) return; // Stale

        set((s) => ({
          workspaceExplorerById: {
            ...s.workspaceExplorerById,
            [workspaceId]: {
              ...current,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            },
          },
        }));
      }
    },

    navigateWorkspaceFilesUp: async (workspaceId: string) => {
      const state = get();
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      const currentPath = state.workspaceExplorerById[workspaceId]?.currentPath;
      if (!ws || !currentPath) return;

      // don't navigate above workspace root
      const normalizedRoot = ws.path.replace(/\\/g, "/").replace(/\/$/, "");
      const normalizedCurrent = currentPath.replace(/\\/g, "/").replace(/\/$/, "");
      
      if (normalizedCurrent === normalizedRoot || normalizedCurrent.length < normalizedRoot.length) {
        return;
      }

      const parts = normalizedCurrent.split("/");
      parts.pop();
      const parent = parts.join("/") || "/";
      await get().navigateWorkspaceFiles(workspaceId, parent);
    },

    selectWorkspaceFile: (workspaceId: string, path: string | null) => {
      set((s) => {
        const current = s.workspaceExplorerById[workspaceId];
        if (!current) return {};
        return {
          workspaceExplorerById: {
            ...s.workspaceExplorerById,
            [workspaceId]: { ...current, selectedPath: path },
          },
        };
      });
    },

    openWorkspaceFile: async (workspaceId: string, targetPath: string, isDirectory: boolean) => {
      if (isDirectory) {
        await get().navigateWorkspaceFiles(workspaceId, targetPath);
      } else {
        await openPath({ path: targetPath });
      }
    },

    revealWorkspaceFile: async (path: string) => {
      await revealPath({ path });
    },

    copyWorkspaceFilePath: async (path: string) => {
      await copyPath({ path });
    },

    createWorkspaceDirectory: async (workspaceId: string, parentPath: string, name: string) => {
      await createDirectory({ parentPath, name });
      await get().refreshWorkspaceFiles(workspaceId);
    },

    renameWorkspacePath: async (workspaceId: string, targetPath: string, newName: string) => {
      await renamePath({ path: targetPath, newName });
      await get().refreshWorkspaceFiles(workspaceId);
    },

    trashWorkspacePath: async (workspaceId: string, targetPath: string) => {
      await trashPath({ path: targetPath });
      await get().refreshWorkspaceFiles(workspaceId);
    },
  };
}
