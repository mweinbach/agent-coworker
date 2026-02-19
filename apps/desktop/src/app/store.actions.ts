import { defaultModelForProvider } from "@cowork/providers/catalog";

import {
  deleteTranscript,
  listDirectory,
  loadState,
  pickWorkspaceDirectory,
  readTranscript,
  stopWorkspaceServer,
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
  clearBusyTimers,
  clearProviderRefreshTimer,
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
  queueBusyRecoveryAfterCancel,
  queuePendingThreadMessage,
  sendControl,
  sendThread,
  sendUserMessageToThread,
  startProviderRefreshTimeout,
  truncateTitle,
} from "./store.helpers";
import type { ThreadRecord, ThreadStatus, WorkspaceRecord } from "./types";

export function createAppActions(set: StoreSet, get: StoreGet): AppStoreActions {
  return {
    init: async () => {
      set({ startupError: null });
      try {
        const state = await loadState();
        const normalizedWorkspaces: WorkspaceRecord[] = (state.workspaces || []).map((w) => {
          const provider = w.defaultProvider && isProviderName(w.defaultProvider) ? w.defaultProvider : "google";
          const model =
            typeof w.defaultModel === "string" && w.defaultModel.trim() ? w.defaultModel : defaultModelForProvider(provider);
        return {
            ...w,
            defaultProvider: provider,
            defaultModel: model,
            defaultEnableMcp: typeof w.defaultEnableMcp === "boolean" ? w.defaultEnableMcp : true,
            yolo: typeof w.yolo === "boolean" ? w.yolo : false,
          };
        });
  
        const normalizedThreads: ThreadRecord[] = (state.threads || []).map((t) => ({
          ...t,
          status: (["active", "disconnected"] as const).includes(t.status as any)
            ? (t.status as ThreadStatus)
            : "disconnected",
        }));
  
        const selectedWorkspaceId = normalizedWorkspaces[0]?.id ?? null;
        const selectedThreadId =
          selectedWorkspaceId
            ? normalizedThreads.find((t) => t.workspaceId === selectedWorkspaceId && t.status === "active")?.id ?? null
            : null;
  
        set({
          workspaces: normalizedWorkspaces,
          threads: normalizedThreads,
          selectedWorkspaceId,
          selectedThreadId,
          developerMode: typeof state.developerMode === "boolean" ? state.developerMode : false,
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
      RUNTIME.controlSockets.delete(workspaceId);
      clearProviderRefreshTimer(workspaceId);
      try {
        control?.close();
      } catch {
        // ignore
      }
  
      for (const thread of get().threads) {
        if (thread.workspaceId !== workspaceId) continue;
        const sock = RUNTIME.threadSockets.get(thread.id);
        RUNTIME.threadSockets.delete(thread.id);
        RUNTIME.optimisticUserMessageIds.delete(thread.id);
        RUNTIME.pendingThreadMessages.delete(thread.id);
        RUNTIME.modelStreamByThread.delete(thread.id);
        clearBusyTimers(thread.id);
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
      RUNTIME.threadSockets.delete(threadId);
      RUNTIME.optimisticUserMessageIds.delete(threadId);
      RUNTIME.pendingThreadMessages.delete(threadId);
      RUNTIME.modelStreamByThread.delete(threadId);
      clearBusyTimers(threadId);
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
        createdAt,
        lastMessageAt: createdAt,
        status: "active",
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
        set((s) => {
          const rt = s.threadRuntimeById[threadId];
          const isBusy = rt?.busy === true;
        return {
            notifications: pushNotification(s.notifications, {
              id: makeId(),
              ts: nowIso(),
              kind: "error",
              title: "Not connected",
              detail: isBusy ? "Run connection lost. Resetting session state." : "Unable to cancel this run.",
            }),
            threadRuntimeById:
              isBusy && rt
                ? {
                    ...s.threadRuntimeById,
                    [threadId]: { ...rt, busy: false, busySince: null, connected: false, sessionId: null },
                  }
                : s.threadRuntimeById,
            threads: isBusy
              ? s.threads.map((t) => (t.id === threadId ? { ...t, status: "disconnected" } : t))
              : s.threads,
          };
        });
        return;
      }
      queueBusyRecoveryAfterCancel(get, set, threadId, "manual");
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
  
      const inferredProvider =
        ws.defaultProvider && isProviderName(ws.defaultProvider)
          ? ws.defaultProvider
          : isProviderName((rt.config as any)?.provider)
            ? ((rt.config as any).provider as ProviderName)
            : "google";
  
      const provider = normalizeProviderChoice(inferredProvider);
      const model = (ws.defaultModel?.trim() || rt.config?.model?.trim() || "") || undefined;
  
      if (provider && model) {
        const ok = sendThread(get, threadId, (sessionId) => ({
          type: "set_model",
          sessionId,
          provider,
          model,
        }));
        if (ok) appendThreadTranscript(threadId, "client", { type: "set_model", sessionId: rt.sessionId, provider, model });
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
    },
  
    restartWorkspaceServer: async (workspaceId) => {
      const control = RUNTIME.controlSockets.get(workspaceId);
      control?.close();
      RUNTIME.controlSockets.delete(workspaceId);
      clearProviderRefreshTimer(workspaceId);
  
      for (const thread of get().threads) {
        if (thread.workspaceId !== workspaceId) continue;
        const sock = RUNTIME.threadSockets.get(thread.id);
        sock?.close();
        RUNTIME.threadSockets.delete(thread.id);
        clearBusyTimers(thread.id);
      }
  
      try {
        await stopWorkspaceServer({ workspaceId });
      } catch {
        // ignore
      }
  
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], serverUrl: null, controlSessionId: null, controlConfig: null },
        },
      }));
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
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
      startProviderRefreshTimeout(get, set, workspaceId);
      const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
      const sock = RUNTIME.controlSockets.get(workspaceId);
      if (!sid || !sock) {
        clearProviderRefreshTimer(workspaceId);
        set({ providerStatusRefreshing: false });
        return;
      }
  
      try {
        sock.send({ type: "refresh_provider_status", sessionId: sid });
        sock.send({ type: "provider_catalog_get", sessionId: sid });
        sock.send({ type: "provider_auth_methods_get", sessionId: sid });
      } catch {
        clearProviderRefreshTimer(workspaceId);
        set((s) => ({
          providerStatusRefreshing: false,
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to refresh provider status." }),
        }));
      }
    },
  
    answerAsk: (threadId, requestId, answer) => {
      sendThread(get, threadId, (sessionId) => ({ type: "ask_response", sessionId, requestId, answer }));
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
  
    setSidebarWidth: (width: number) => set({ sidebarWidth: Math.max(180, Math.min(500, width)) }),
  
    refreshWorkspaceFiles: async (workspaceId: string) => {
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
      try {
        const files = await listDirectory(ws.path);
        set((s) => ({
          workspaceFilesById: { ...s.workspaceFilesById, [workspaceId]: files },
        }));
      } catch (err) {
        console.error("Failed to list directory:", err);
      }
    },
  };
}
