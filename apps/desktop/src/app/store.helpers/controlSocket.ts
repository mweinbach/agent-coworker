import type { ProviderName, ServerEvent } from "../../lib/wsProtocol";
import type { StoreGet, StoreSet } from "../store.helpers";
import { normalizeWorkspaceProviderOptions } from "../openaiCompatibleProviderOptions";
import { normalizeWorkspaceUserProfile } from "../types";
import type { Notification, SessionSnapshot, ThreadRecord } from "../types";
import { RUNTIME } from "./runtimeState";
import {
  ensureWorkspaceJsonRpcSocket,
  registerWorkspaceJsonRpcLifecycle,
  requestJsonRpc,
  requestJsonRpcThreadList,
  requestJsonRpcThreadRead,
} from "./jsonRpcSocket";

type ProviderStatusEvent = Extract<ServerEvent, { type: "provider_status" }>;
type ProviderStatus = ProviderStatusEvent["providers"][number];
type ProviderAuthChallengeEvent = Extract<ServerEvent, { type: "provider_auth_challenge" }>;

function sanitizeProviderAuthChallenge(evt: ProviderAuthChallengeEvent): ProviderAuthChallengeEvent {
  if (evt.provider !== "codex-cli" || evt.methodId !== "oauth_cli" || !evt.challenge.url) {
    return evt;
  }

  return {
    ...evt,
    challenge: {
      ...evt.challenge,
      url: undefined,
    },
  };
}

type ControlSocketDeps = {
  nowIso: () => string;
  makeId: () => string;
  persist: (get: StoreGet) => void;
  pushNotification: (notifications: Notification[], entry: Notification) => Notification[];
  isProviderName: (value: unknown) => value is ProviderName;
};

type ControlSocketHelperOptions = {
  requestTimeoutMs?: number;
};

const REQUEST_TIMEOUT_MS = 5_000;

export function createControlSocketHelpers(
  deps: ControlSocketDeps,
  options: ControlSocketHelperOptions = {},
) {
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const jsonRpcLifecycleCleanupByWorkspace = new Map<string, () => void>();
  const jsonRpcBootstrapPromises = new Map<string, Promise<void>>();
  const controlStoreGettersByWorkspace = new Map<string, StoreGet>();
  const controlStoreSettersByWorkspace = new Map<string, StoreSet>();

  function upsertWorkspaceThreads(
    allThreads: ThreadRecord[],
    threadRuntimeById: ReturnType<StoreGet>["threadRuntimeById"],
    workspaceId: string,
    sessions: Extract<ServerEvent, { type: "sessions" }>["sessions"],
  ): ThreadRecord[] {
    const workspaceThreads = allThreads.filter((thread) => thread.workspaceId === workspaceId);
    const serverBackedBySessionId = new Map<string, ThreadRecord>();
    for (const thread of workspaceThreads) {
      const runtimeSessionId = threadRuntimeById[thread.id]?.sessionId;
      const candidateSessionIds = [thread.sessionId, runtimeSessionId, thread.id].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      for (const candidateSessionId of candidateSessionIds) {
        if (!serverBackedBySessionId.has(candidateSessionId)) {
          serverBackedBySessionId.set(candidateSessionId, thread);
        }
      }
    }
    const localOnlyThreads = workspaceThreads.filter((thread) => !thread.sessionId);
    const nextServerThreads = sessions.map((session) => {
      const existing = serverBackedBySessionId.get(session.sessionId);
      const threadId = existing?.id ?? session.sessionId;
      const runtime = threadRuntimeById[threadId] ?? (existing ? threadRuntimeById[existing.id] : undefined);
      return {
        id: threadId,
        workspaceId,
        title: session.title,
        titleSource: session.titleSource,
        createdAt: session.createdAt,
        lastMessageAt: session.updatedAt,
        status: runtime?.connected ? "active" as const : "disconnected" as const,
        sessionId: session.sessionId,
        messageCount: session.messageCount,
        lastEventSeq: session.lastEventSeq,
        draft: false,
        legacyTranscriptId: existing?.legacyTranscriptId ?? null,
      } satisfies ThreadRecord;
    });
    const claimedLegacyThreadIds = new Set(
      nextServerThreads
        .map((thread) => thread.legacyTranscriptId)
        .filter((threadId): threadId is string => typeof threadId === "string" && threadId.trim().length > 0),
    );
    return [
      ...allThreads.filter((thread) => thread.workspaceId !== workspaceId),
      ...nextServerThreads.sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt)),
      ...localOnlyThreads
        .filter((thread) => thread.draft === true || !claimedLegacyThreadIds.has(thread.id))
        .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt)),
    ];
  }

  function collectWorkspaceSessionCandidateIds(
    allThreads: ThreadRecord[],
    threadRuntimeById: ReturnType<StoreGet>["threadRuntimeById"],
    workspaceId: string,
  ): Set<string> {
    const sessionIds = new Set<string>();
    for (const thread of allThreads) {
      if (thread.workspaceId !== workspaceId) continue;
      const runtimeSessionId = threadRuntimeById[thread.id]?.sessionId;
      for (const candidateSessionId of [thread.sessionId, runtimeSessionId, thread.id]) {
        if (typeof candidateSessionId !== "string" || candidateSessionId.trim().length === 0) {
          continue;
        }
        sessionIds.add(candidateSessionId);
      }
    }
    return sessionIds;
  }

  function pruneRemovedWorkspaceSessionSnapshots(
    allThreads: ThreadRecord[],
    threadRuntimeById: ReturnType<StoreGet>["threadRuntimeById"],
    workspaceId: string,
    sessions: Extract<ServerEvent, { type: "sessions" }>["sessions"],
  ): string[] {
    const liveSessionIds = new Set(sessions.map((session) => session.sessionId));
    const removedSessionIds: string[] = [];
    for (const sessionId of collectWorkspaceSessionCandidateIds(allThreads, threadRuntimeById, workspaceId)) {
      if (!liveSessionIds.has(sessionId) && RUNTIME.sessionSnapshots.has(sessionId)) {
        removedSessionIds.push(sessionId);
      }
    }
    return removedSessionIds;
  }

  function reconcileSelectedThreadId(
    allThreads: ThreadRecord[],
    nextThreads: ThreadRecord[],
    workspaceId: string,
    selectedWorkspaceId: string | null,
    selectedThreadId: string | null,
  ): string | null {
    if (!selectedThreadId) {
      return null;
    }
    if (nextThreads.some((thread) => thread.id === selectedThreadId)) {
      return selectedThreadId;
    }

    const migratedThreadId = nextThreads.find((thread) => thread.legacyTranscriptId === selectedThreadId)?.id ?? null;
    if (migratedThreadId) {
      return migratedThreadId;
    }

    const fallbackWorkspaceId =
      allThreads.find((thread) => thread.id === selectedThreadId)?.workspaceId
      ?? selectedWorkspaceId
      ?? workspaceId;
    return nextThreads.find((thread) => thread.workspaceId === fallbackWorkspaceId)?.id ?? null;
  }

  function omitSkillMutationPendingKeys(
    pendingKeys: Record<string, true>,
    clearedPendingKeys?: readonly string[],
  ): Record<string, true> {
    if (!clearedPendingKeys || clearedPendingKeys.length === 0) {
      return pendingKeys;
    }

    const nextPendingKeys = { ...pendingKeys };
    for (const key of clearedPendingKeys) {
      delete nextPendingKeys[key];
    }
    return nextPendingKeys;
  }

  function waitForReady(socket: any, timeoutMs = requestTimeoutMs): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);

      void socket.readyPromise.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }

  function clearWorkspaceControlRuntime(get: StoreGet, set: StoreSet, workspaceId: string) {
    const installWaiter = RUNTIME.skillInstallWaiters.get(workspaceId);
    if (installWaiter) {
      RUNTIME.skillInstallWaiters.delete(workspaceId);
      installWaiter.reject(new Error("Control connection closed"));
    }

    set((s) => {
      const workspaceRuntime = s.workspaceRuntimeById[workspaceId];
      const hadPendingMemories = workspaceRuntime?.memoriesLoading ?? false;
      return {
        providerStatusRefreshing: false,
        providerLastAuthChallenge: null,
        notifications: hadPendingMemories
          ? deps.pushNotification(s.notifications, {
              id: deps.makeId(),
              ts: deps.nowIso(),
              kind: "error",
              title: "Not connected",
              detail: "Unable to request memories.",
            })
          : s.notifications,
        workspaceRuntimeById: workspaceRuntime
          ? {
              ...s.workspaceRuntimeById,
              [workspaceId]: {
                ...workspaceRuntime,
                controlSessionId: null,
                controlConfig: null,
                controlSessionConfig: null,
                memoriesLoading: false,
                skillCatalogLoading: false,
                skillsMutationBlocked: false,
                skillsMutationBlockedReason: null,
                skillMutationPendingKeys: {},
                workspaceBackupsLoading: false,
                workspaceBackupsError: workspaceRuntime.workspaceBackupsError,
                workspaceBackupPendingActionKeys: {},
                workspaceBackupDeltaLoading: false,
              },
            }
          : s.workspaceRuntimeById,
      };
    });

    jsonRpcBootstrapPromises.delete(workspaceId);
    void deps.persist(get);
  }

  function rememberControlStoreSet(workspaceId: string, set: StoreSet) {
    controlStoreSettersByWorkspace.set(workspaceId, set);
  }

  function rememberControlStoreGet(workspaceId: string, get: StoreGet) {
    controlStoreGettersByWorkspace.set(workspaceId, get);
  }

  function getControlStoreGet(workspaceId: string): StoreGet | null {
    return controlStoreGettersByWorkspace.get(workspaceId) ?? null;
  }

  function getControlStoreSet(workspaceId: string): StoreSet | null {
    return controlStoreSettersByWorkspace.get(workspaceId) ?? null;
  }

  function ensureJsonRpcControlLifecycle(get: StoreGet, set: StoreSet, workspaceId: string) {
    rememberControlStoreGet(workspaceId, get);
    rememberControlStoreSet(workspaceId, set);
    if (jsonRpcLifecycleCleanupByWorkspace.has(workspaceId)) {
      return;
    }
    const cleanup = registerWorkspaceJsonRpcLifecycle(workspaceId, {
      onOpen: () => {
        const currentGet = getControlStoreGet(workspaceId);
        const currentSet = getControlStoreSet(workspaceId);
        if (!currentGet || !currentSet) return;
        void bootstrapJsonRpcControlStateOnce(currentGet, currentSet, workspaceId);
      },
      onClose: () => {
        const currentGet = getControlStoreGet(workspaceId);
        const currentSet = getControlStoreSet(workspaceId);
        if (!currentGet || !currentSet) return;
        clearWorkspaceControlRuntime(currentGet, currentSet, workspaceId);
      },
    });
    jsonRpcLifecycleCleanupByWorkspace.set(workspaceId, cleanup);
  }

  function ensureControlSocket(get: StoreGet, set: StoreSet, workspaceId: string) {
    rememberControlStoreGet(workspaceId, get);
    rememberControlStoreSet(workspaceId, set);
    ensureJsonRpcControlLifecycle(get, set, workspaceId);
    return ensureWorkspaceJsonRpcSocket(get, set, workspaceId);
  }

  async function waitForControlSession(get: StoreGet, set: StoreSet, workspaceId: string, timeoutMs = 3_000): Promise<boolean> {
    const socket = RUNTIME.jsonRpcSockets.get(workspaceId) ?? ensureControlSocket(get, set, workspaceId);
    if (!socket) {
      return false;
    }
    return await waitForReady(socket, timeoutMs);
  }

  async function requestWorkspaceSessions(
    get: StoreGet,
    set: StoreSet,
    workspaceId: string,
  ): Promise<Extract<ServerEvent, { type: "sessions" }>["sessions"] | null> {
    let threads: any[] = [];
    try {
      threads = await requestJsonRpcThreadList(get, set, workspaceId);
    } catch {
      return null;
    }
    const sessions = threads.map((thread) => {
      const existingThread = get().threads.find((entry) =>
        entry.workspaceId === workspaceId
        && (entry.id === thread.id || entry.sessionId === thread.id),
      );
      return {
        sessionId: thread.id,
        title: thread.title ?? "New session",
        titleSource: existingThread?.titleSource ?? "manual" as const,
        titleModel: null,
        provider: thread.modelProvider,
        model: thread.model,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messageCount: thread.messageCount ?? existingThread?.messageCount ?? 0,
        lastEventSeq: thread.lastEventSeq ?? existingThread?.lastEventSeq ?? 0,
        hasPendingAsk: false,
        hasPendingApproval: false,
      };
    });
    let removedSessionSnapshotIds: string[] = [];
    set((s) => {
      removedSessionSnapshotIds = pruneRemovedWorkspaceSessionSnapshots(
        s.threads,
        s.threadRuntimeById,
        workspaceId,
        sessions,
      );
      const nextThreads = upsertWorkspaceThreads(
        s.threads,
        s.threadRuntimeById,
        workspaceId,
        sessions,
      );
      const selectedThreadId = reconcileSelectedThreadId(
        s.threads,
        nextThreads,
        workspaceId,
        s.selectedWorkspaceId,
        s.selectedThreadId,
      );
      return {
        threads: nextThreads,
        selectedThreadId,
      };
    });
    for (const sessionId of removedSessionSnapshotIds) {
      RUNTIME.sessionSnapshots.delete(sessionId);
    }
    void deps.persist(get);
    return sessions;
  }

  async function requestSessionSnapshot(
    get: StoreGet,
    set: StoreSet,
    workspaceId: string,
    targetSessionId: string,
  ): Promise<SessionSnapshot | null> {
    try {
      return await requestJsonRpcThreadRead(get, set, workspaceId, targetSessionId);
    } catch {
      return null;
    }
  }

  async function bootstrapJsonRpcControlState(get: StoreGet, set: StoreSet, workspaceId: string): Promise<void> {
    const cwd = get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
    const refreshGeneration = ++RUNTIME.providerStatusRefreshGeneration;
    set((s) => ({
      providerStatusRefreshing: true,
      providerLastAuthChallenge: null,
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...s.workspaceRuntimeById[workspaceId],
          ...(s.view === "skills" && s.workspaceRuntimeById[workspaceId]?.skillsCatalog === null
            ? {
                skillCatalogLoading: true,
                skillCatalogError: null,
              }
            : {}),
        },
      },
    }));

    await Promise.allSettled([
      requestWorkspaceSessions(get, set, workspaceId),
      requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/catalog/read", { cwd }),
      requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/authMethods/read", { cwd }),
      requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/status/refresh", { cwd }),
      requestJsonRpcControlEvent(get, set, workspaceId, "cowork/mcp/servers/read", { cwd }),
      requestJsonRpcControlEvent(get, set, workspaceId, "cowork/memory/list", { cwd }),
      requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/catalog/read", { cwd }),
      requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/list", { cwd }),
    ]);
    if (refreshGeneration === RUNTIME.providerStatusRefreshGeneration) {
      set(() => ({ providerStatusRefreshing: false }));
    }

    const selectedSkillName = get().workspaceRuntimeById[workspaceId]?.selectedSkillName;
    if (selectedSkillName) {
      await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/read", {
        cwd,
        skillName: selectedSkillName,
      });
    }

    const selectedInstallationId = get().workspaceRuntimeById[workspaceId]?.selectedSkillInstallationId;
    if (selectedInstallationId) {
      await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/installation/read", {
        cwd,
        installationId: selectedInstallationId,
      });
    }
  }

  function bootstrapJsonRpcControlStateOnce(get: StoreGet, set: StoreSet, workspaceId: string): Promise<void> {
    const existing = jsonRpcBootstrapPromises.get(workspaceId);
    if (existing) {
      return existing;
    }

    const promise = bootstrapJsonRpcControlState(get, set, workspaceId).finally(() => {
      if (jsonRpcBootstrapPromises.get(workspaceId) === promise) {
        jsonRpcBootstrapPromises.delete(workspaceId);
      }
    });
    jsonRpcBootstrapPromises.set(workspaceId, promise);
    return promise;
  }

  function applyJsonRpcControlEvent(get: StoreGet, set: StoreSet, workspaceId: string, evt: ServerEvent) {
    if (evt.type === "session_settings") {
      set((s) => ({
        workspaces: s.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? { ...workspace, defaultEnableMcp: evt.enableMcp }
            : workspace,
        ),
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            controlEnableMcp: evt.enableMcp,
          },
        },
      }));
      void deps.persist(get);
      return;
    }

    if (evt.type === "session_config") {
      const providerOptions = normalizeWorkspaceProviderOptions((evt.config as any).providerOptions);
      const userProfile = evt.config.userProfile ? normalizeWorkspaceUserProfile(evt.config.userProfile) : undefined;
      set((s) => ({
        workspaces: s.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? {
                ...workspace,
                defaultBackupsEnabled: evt.config.defaultBackupsEnabled,
                defaultPreferredChildModel: evt.config.preferredChildModel,
                defaultChildModelRoutingMode: evt.config.childModelRoutingMode,
                defaultPreferredChildModelRef: evt.config.preferredChildModelRef,
                defaultAllowedChildModelRefs: evt.config.allowedChildModelRefs,
                defaultToolOutputOverflowChars: evt.config.defaultToolOutputOverflowChars,
                providerOptions,
                ...(typeof evt.config.userName === "string" ? { userName: evt.config.userName } : {}),
                ...(userProfile ? { userProfile } : {}),
              }
            : workspace,
        ),
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            controlSessionConfig: evt.config,
          },
        },
      }));
      void deps.persist(get);
      return;
    }

    if (evt.type === "mcp_servers") {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            mcpServers: evt.servers,
            mcpLegacy: evt.legacy,
            mcpFiles: evt.files,
            mcpWarnings: evt.warnings ?? [],
          },
        },
      }));
      return;
    }

    if (evt.type === "mcp_server_validation") {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            mcpValidationByName: {
              ...s.workspaceRuntimeById[workspaceId].mcpValidationByName,
              [evt.name]: evt,
            },
          },
        },
        notifications: deps.pushNotification(s.notifications, {
          id: deps.makeId(),
          ts: deps.nowIso(),
          kind: evt.ok ? "info" : "error",
          title: evt.ok ? `MCP validation passed: ${evt.name}` : `MCP validation failed: ${evt.name}`,
          detail: evt.message,
        }),
      }));
      return;
    }

    if (evt.type === "mcp_server_auth_challenge") {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            mcpLastAuthChallenge: evt,
          },
        },
        notifications: deps.pushNotification(s.notifications, {
          id: deps.makeId(),
          ts: deps.nowIso(),
          kind: "info",
          title: `MCP auth challenge: ${evt.name}`,
          detail: `${evt.challenge.instructions}${evt.challenge.url ? ` URL: ${evt.challenge.url}` : ""}`,
        }),
      }));
      return;
    }

    if (evt.type === "mcp_server_auth_result") {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            mcpLastAuthResult: evt,
          },
        },
        notifications: deps.pushNotification(s.notifications, {
          id: deps.makeId(),
          ts: deps.nowIso(),
          kind: evt.ok ? "info" : "error",
          title: evt.ok ? `MCP auth updated: ${evt.name}` : `MCP auth failed: ${evt.name}`,
          detail: evt.message,
        }),
      }));
      return;
    }

    if (evt.type === "skills_list") {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: (() => {
            const prev = s.workspaceRuntimeById[workspaceId];
            const selected = prev?.selectedSkillName ?? null;
            const exists = selected ? evt.skills.some((sk) => sk.name === selected) : true;
            return {
              ...prev,
              skills: evt.skills,
              selectedSkillName: exists ? prev?.selectedSkillName ?? null : null,
              selectedSkillContent: exists ? prev?.selectedSkillContent ?? null : null,
            };
          })(),
        },
      }));
      return;
    }

    if (evt.type === "skills_catalog") {
      const installWaiter = RUNTIME.skillInstallWaiters.get(workspaceId);
      const workspaceRuntimeBefore = get().workspaceRuntimeById[workspaceId];
      const clearedMutationPendingKeys = evt.clearedMutationPendingKeys ?? [];
      const shouldResolveInstall =
        installWaiter != null &&
        workspaceRuntimeBefore != null &&
        clearedMutationPendingKeys.includes(installWaiter.pendingKey) &&
        workspaceRuntimeBefore.skillMutationPendingKeys[installWaiter.pendingKey] === true;

      set((s) => {
        const workspaceRuntime = s.workspaceRuntimeById[workspaceId];
        const selectedInstallationId = workspaceRuntime.selectedSkillInstallationId;
        const selectedInstallation =
          selectedInstallationId
            ? evt.catalog.installations.find((installation) => installation.installationId === selectedInstallationId) ?? null
            : null;
        return {
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...workspaceRuntime,
              skillsCatalog: evt.catalog,
              skillCatalogLoading: false,
              skillCatalogError: null,
              skillsMutationBlocked: evt.mutationBlocked,
              skillsMutationBlockedReason: evt.mutationBlockedReason ?? null,
              skillMutationPendingKeys: omitSkillMutationPendingKeys(
                workspaceRuntime.skillMutationPendingKeys,
                clearedMutationPendingKeys,
              ),
              skillMutationError: null,
              selectedSkillInstallationId: selectedInstallation ? selectedInstallationId : null,
              selectedSkillInstallation: selectedInstallation,
            },
          },
        };
      });

      if (shouldResolveInstall && installWaiter) {
        RUNTIME.skillInstallWaiters.delete(workspaceId);
        installWaiter.resolve();
      }
      return;
    }

    if (evt.type === "skill_content") {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            selectedSkillName: evt.skill.name,
            selectedSkillContent: evt.content,
          },
        },
      }));
      return;
    }

    if (evt.type === "skill_installation") {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            selectedSkillInstallationId: evt.installation?.installationId ?? s.workspaceRuntimeById[workspaceId].selectedSkillInstallationId,
            selectedSkillInstallation: evt.installation,
            selectedSkillContent:
              typeof evt.content === "string"
                ? evt.content
                : evt.content === null
                  ? null
                  : s.workspaceRuntimeById[workspaceId].selectedSkillContent,
            skillMutationError: null,
          },
        },
      }));
      return;
    }

    if (evt.type === "skill_install_preview") {
      set((s) => {
        const rt = s.workspaceRuntimeById[workspaceId];
        const previewPending = rt.skillMutationPendingKeys.preview === true;
        const fromUserPreviewRequest = evt.fromUserPreviewRequest !== false;
        const nextPreview =
          fromUserPreviewRequest || !previewPending ? evt.preview : rt.selectedSkillPreview;
        const pendingKeys = { ...rt.skillMutationPendingKeys };
        if (fromUserPreviewRequest) {
          delete pendingKeys.preview;
        }
        return {
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...rt,
              selectedSkillPreview: nextPreview,
              skillMutationPendingKeys: pendingKeys,
              skillMutationError: null,
            },
          },
        };
      });
      return;
    }

    if (evt.type === "skill_installation_update_check") {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillUpdateChecksByInstallationId: {
              ...s.workspaceRuntimeById[workspaceId].skillUpdateChecksByInstallationId,
              [evt.result.installationId]: evt.result,
            },
            skillMutationError: null,
          },
        },
      }));
      return;
    }

    if (evt.type === "workspace_backups") {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            workspaceBackupsPath: evt.workspacePath,
            workspaceBackups: evt.backups,
            workspaceBackupsLoading: false,
            workspaceBackupsError: null,
            workspaceBackupPendingActionKeys: {},
          },
        },
      }));
      return;
    }

    if (evt.type === "workspace_backup_delta") {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            workspaceBackupDelta: evt,
            workspaceBackupDeltaLoading: false,
            workspaceBackupDeltaError: null,
          },
        },
      }));
      return;
    }

    if (evt.type === "memory_list") {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            memories: evt.memories,
            memoriesLoading: false,
          },
        },
      }));
      return;
    }

    if (evt.type === "provider_status") {
      const byName: Partial<Record<ProviderName, ProviderStatus>> = {};
      for (const p of evt.providers) byName[p.provider] = p;
      const connected = evt.providers
        .filter((p) => p.authorized || p.verified)
        .map((p) => p.provider)
        .filter((provider): provider is ProviderName => deps.isProviderName(provider));
      set((s) => ({
        providerStatusByName: { ...s.providerStatusByName, ...byName },
        providerStatusLastUpdatedAt: deps.nowIso(),
        providerConnected: connected,
      }));
      void deps.persist(get);
      return;
    }

    if (evt.type === "provider_catalog") {
      const connected = evt.connected.filter((provider): provider is ProviderName =>
        deps.isProviderName(provider),
      );
      set((s) => ({
        providerCatalog: evt.all,
        providerDefaultModelByProvider: evt.default,
        providerConnected: connected,
      }));
      return;
    }

    if (evt.type === "provider_auth_methods") {
      set(() => ({ providerAuthMethodsByProvider: evt.methods }));
      return;
    }

    if (evt.type === "provider_auth_challenge") {
      const sanitized = sanitizeProviderAuthChallenge(evt);
      const command = sanitized.challenge.command ? ` Command: ${sanitized.challenge.command}` : "";
      const url = sanitized.challenge.url ? ` URL: ${sanitized.challenge.url}` : "";
      set((s) => ({
        providerLastAuthChallenge: sanitized,
        notifications: deps.pushNotification(s.notifications, {
          id: deps.makeId(),
          ts: deps.nowIso(),
          kind: "info",
          title: `Auth challenge: ${sanitized.provider}`,
          detail: `${sanitized.challenge.instructions}${url}${command}`,
        }),
      }));
      return;
    }

    if (evt.type === "provider_auth_result") {
      const title = evt.ok
        ? evt.methodId === "logout"
          ? `Provider disconnected: ${evt.provider}`
          : evt.mode === "oauth_pending"
            ? `Provider auth pending: ${evt.provider}`
            : `Provider connected: ${evt.provider}`
        : `Provider auth failed: ${evt.provider}`;
      set((s) => ({
        providerLastAuthResult: evt,
        notifications: deps.pushNotification(s.notifications, {
          id: deps.makeId(),
          ts: deps.nowIso(),
          kind: evt.ok ? "info" : "error",
          title,
          detail: evt.message,
        }),
      }));

      if (!evt.ok) {
        return;
      }

      const cwd = get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
      const refreshGeneration = ++RUNTIME.providerStatusRefreshGeneration;
      set(() => ({ providerStatusRefreshing: true }));
      void Promise.allSettled([
        requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/status/refresh", { cwd }),
        requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/catalog/read", { cwd }),
      ]).then(() => {
        if (refreshGeneration === RUNTIME.providerStatusRefreshGeneration) {
          set(() => ({ providerStatusRefreshing: false }));
        }
      });
      return;
    }

    if (evt.type === "error") {
      const workspaceRuntimeBefore = get().workspaceRuntimeById[workspaceId];
      const installWaiter = RUNTIME.skillInstallWaiters.get(workspaceId);
      const hasPendingSkillStateBefore =
        workspaceRuntimeBefore &&
        (workspaceRuntimeBefore.skillCatalogLoading
          || Object.keys(workspaceRuntimeBefore.skillMutationPendingKeys).length > 0);
      const shouldRejectInstall =
        installWaiter &&
        workspaceRuntimeBefore &&
        hasPendingSkillStateBefore &&
        workspaceRuntimeBefore.skillMutationPendingKeys[installWaiter.pendingKey] === true;

      set((s) => {
        const workspaceRuntime = s.workspaceRuntimeById[workspaceId];
        const hasPendingMemories = workspaceRuntime.memoriesLoading;
        const hasPendingSkillState =
          workspaceRuntime.skillCatalogLoading
          || Object.keys(workspaceRuntime.skillMutationPendingKeys).length > 0;
        const hasPendingBackupState =
          workspaceRuntime.workspaceBackupsLoading
          || Object.keys(workspaceRuntime.workspaceBackupPendingActionKeys).length > 0;
        const hasPendingBackupDelta = workspaceRuntime.workspaceBackupDeltaLoading;
        return {
          notifications: deps.pushNotification(s.notifications, {
            id: deps.makeId(),
            ts: deps.nowIso(),
            kind: "error",
            title: "Control session error",
            detail: `${evt.source}/${evt.code}: ${evt.message}`,
          }),
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...workspaceRuntime,
              memoriesLoading: hasPendingMemories ? false : workspaceRuntime.memoriesLoading,
              ...(hasPendingSkillState
                ? {
                    skillCatalogLoading: false,
                    skillCatalogError: evt.message,
                    skillMutationPendingKeys: {},
                    skillMutationError: evt.message,
                  }
                : {}),
              ...(hasPendingBackupState
                ? {
                    workspaceBackupsLoading: false,
                    workspaceBackupsError: evt.message,
                    workspaceBackupPendingActionKeys: {},
                    workspaceBackupDeltaLoading: hasPendingBackupDelta ? false : workspaceRuntime.workspaceBackupDeltaLoading,
                    workspaceBackupDeltaError: hasPendingBackupDelta ? evt.message : workspaceRuntime.workspaceBackupDeltaError,
                  }
                : hasPendingBackupDelta
                  ? {
                      workspaceBackupDeltaLoading: false,
                      workspaceBackupDeltaError: evt.message,
                    }
                  : {}),
            },
          },
        };
      });

      if (shouldRejectInstall && installWaiter) {
        RUNTIME.skillInstallWaiters.delete(workspaceId);
        installWaiter.reject(new Error(evt.message));
      }
      return;
    }

    if (evt.type === "assistant_message") {
      const text = String(evt.text ?? "").trim();
      if (!text) return;
      set((s) => ({
        notifications: deps.pushNotification(s.notifications, {
          id: deps.makeId(),
          ts: deps.nowIso(),
          kind: "info",
          title: "Server message",
          detail: text,
        }),
      }));
    }
  }

  async function requestJsonRpcControlEvent(
    get: StoreGet,
    set: StoreSet,
    workspaceId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const result = await requestJsonRpc(get, set, workspaceId, method, params);
      const event = (result as { event?: ServerEvent }).event;
      if (!event) {
        return true;
      }
      applyJsonRpcControlEvent(get, set, workspaceId, event);
      return event.type !== "error";
    } catch {
      return false;
    }
  }

  return {
    ensureControlSocket,
    waitForControlSession,
    requestWorkspaceSessions,
    requestSessionSnapshot,
    requestJsonRpcControlEvent,
    __internal: {
      getPendingWaiterCounts: () => ({
        controlSessionWaiters: 0,
        workspaceSessionWaiters: 0,
        sessionSnapshotWaiters: 0,
      }),
    },
  };
}
