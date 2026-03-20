import { AgentSocket } from "../../lib/agentSocket";
import { VERSION } from "../../lib/version";
import type { ClientMessage, ProviderName, ServerEvent } from "../../lib/wsProtocol";
import type { StoreGet, StoreSet } from "../store.helpers";
import { normalizeWorkspaceProviderOptions } from "../openaiCompatibleProviderOptions";
import { normalizeWorkspaceUserProfile } from "../types";
import type { Notification, SessionSnapshot, ThreadRecord } from "../types";
import { RUNTIME } from "./runtimeState";

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
  const controlSessionWaiters = new Map<string, Set<(sessionId: string | null) => void>>();
  const workspaceSessionWaiters = new Map<string, Set<(sessions: Extract<ServerEvent, { type: "sessions" }>["sessions"] | null) => void>>();
  const sessionSnapshotWaiters = new Map<string, Set<(snapshot: SessionSnapshot | null) => void>>();
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  function resolveControlSessionWaiters(workspaceId: string, sessionId: string | null) {
    const waiters = controlSessionWaiters.get(workspaceId);
    if (!waiters || waiters.size === 0) return;
    controlSessionWaiters.delete(workspaceId);
    for (const resolve of waiters) {
      resolve(sessionId);
    }
  }

  function snapshotWaiterKey(workspaceId: string, sessionId: string): string {
    return `${workspaceId}:${sessionId}`;
  }

  function registerWaiter<T>(
    waitersByKey: Map<string, Set<(value: T | null) => void>>,
    key: string,
    resolve: (value: T | null) => void,
  ): () => void {
    const waiters = waitersByKey.get(key) ?? new Set();
    waiters.add(resolve);
    waitersByKey.set(key, waiters);
    return () => {
      const existing = waitersByKey.get(key);
      if (!existing) return;
      existing.delete(resolve);
      if (existing.size === 0) {
        waitersByKey.delete(key);
      }
    };
  }

  function resolveWorkspaceSessionWaiters(
    workspaceId: string,
    sessions: Extract<ServerEvent, { type: "sessions" }>["sessions"] | null,
  ) {
    const waiters = workspaceSessionWaiters.get(workspaceId);
    if (!waiters || waiters.size === 0) return;
    workspaceSessionWaiters.delete(workspaceId);
    for (const resolve of waiters) {
      resolve(sessions);
    }
  }

  function resolveSessionSnapshotWaiters(
    workspaceId: string,
    targetSessionId: string,
    snapshot: SessionSnapshot | null,
  ) {
    const key = snapshotWaiterKey(workspaceId, targetSessionId);
    const waiters = sessionSnapshotWaiters.get(key);
    if (!waiters || waiters.size === 0) return;
    sessionSnapshotWaiters.delete(key);
    for (const resolve of waiters) {
      resolve(snapshot);
    }
  }

  function resolvePendingControlRequestWaitersOnError(
    workspaceId: string,
    evt: Extract<ServerEvent, { type: "error" }>,
  ) {
    if (evt.source !== "session") {
      return;
    }

    const message = evt.message.toLowerCase();
    if (message.includes("list sessions")) {
      resolveWorkspaceSessionWaiters(workspaceId, null);
    }

    if (message.includes("snapshot") || message.includes("target session")) {
      const targetSessionId = /^unknown target session:\s*(.+)$/i.exec(evt.message.trim())?.[1]?.trim();
      if (targetSessionId) {
        resolveSessionSnapshotWaiters(workspaceId, targetSessionId, null);
      }
    }
  }

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
      const threadId = session.sessionId;
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
        legacyTranscriptId:
          existing?.legacyTranscriptId
          ?? (existing && existing.id !== session.sessionId ? existing.id : null),
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

  function withTimeout<T>(
    register: (resolve: (value: T | null) => void) => (() => void) | void,
  ): Promise<T | null> {
    return new Promise((resolve) => {
      let settled = false;
      let unregister: (() => void) | void;
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
        unregister?.();
      };
      const timer = setTimeout(() => finish(null), requestTimeoutMs);
      unregister = register((value) => {
        finish(value);
      });
    });
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

  function ensureControlSocket(get: StoreGet, set: StoreSet, workspaceId: string) {
    const rt = get().workspaceRuntimeById[workspaceId];
    const url = rt?.serverUrl;
    if (!url) return null;
    const resumeSessionId = rt?.controlSessionId ?? undefined;

    const existingSocket = RUNTIME.controlSockets.get(workspaceId);
    if (existingSocket) {
      const existingUrl = Reflect.get(existingSocket as object, "url");
      if (typeof existingUrl !== "string" || existingUrl === url) {
        return existingSocket;
      }

      RUNTIME.controlSockets.delete(workspaceId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            controlSessionId: null,
            controlConfig: null,
            controlSessionConfig: null,
          },
        },
      }));
      try {
        existingSocket.close();
      } catch {
        // ignore stale socket close failures
      }
    }

    const socket = new AgentSocket({
      url,
      resumeSessionId,
      client: "desktop-control",
      version: VERSION,
      autoReconnect: true,
      onEvent: (evt) => {
        if (evt.type === "server_hello") {
          const provider =
            deps.isProviderName((evt.config as { provider?: unknown })?.provider)
              ? (evt.config as { provider: ProviderName }).provider
              : null;
          const model =
            typeof (evt.config as { model?: unknown })?.model === "string"
              ? (evt.config as { model: string }).model.trim()
              : "";
          let workspaceMirrored = false;
          set((s) => ({
            workspaces: s.workspaces.map((workspace) => {
              if (workspace.id !== workspaceId) {
                return workspace;
              }
              const nextWorkspace = {
                ...workspace,
                ...(!workspace.defaultProvider && provider ? { defaultProvider: provider } : {}),
                ...(!workspace.defaultModel && model ? { defaultModel: model } : {}),
              };
              workspaceMirrored =
                workspaceMirrored
                || nextWorkspace.defaultProvider !== workspace.defaultProvider
                || nextWorkspace.defaultModel !== workspace.defaultModel;
              return nextWorkspace;
            }),
            workspaceRuntimeById: {
              ...s.workspaceRuntimeById,
              [workspaceId]: (() => {
                const workspaceRuntime = s.workspaceRuntimeById[workspaceId];
                const shouldShowSkillCatalogLoading =
                  s.view === "skills"
                  && workspaceRuntime?.skillsCatalog === null;
                return {
                  ...workspaceRuntime,
                  controlSessionId: evt.sessionId,
                  controlConfig: evt.config,
                  controlSessionConfig: null,
                  ...(shouldShowSkillCatalogLoading
                    ? {
                        skillCatalogLoading: true,
                        skillCatalogError: null,
                      }
                    : {}),
                };
              })(),
            },
            providerStatusRefreshing: true,
            providerLastAuthChallenge: null,
          }));
          if (workspaceMirrored) {
            void deps.persist(get);
          }
          resolveControlSessionWaiters(workspaceId, evt.sessionId);

          try {
            socket.send({ type: "skills_catalog_get", sessionId: evt.sessionId });
            socket.send({ type: "list_skills", sessionId: evt.sessionId });
            const selected = get().workspaceRuntimeById[workspaceId]?.selectedSkillName;
            if (selected) socket.send({ type: "read_skill", sessionId: evt.sessionId, skillName: selected });
            const selectedInstallationId = get().workspaceRuntimeById[workspaceId]?.selectedSkillInstallationId;
            if (selectedInstallationId) {
              socket.send({ type: "skill_installation_get", sessionId: evt.sessionId, installationId: selectedInstallationId });
            }
            socket.send({ type: "list_sessions", sessionId: evt.sessionId, scope: "workspace" });
            socket.send({ type: "provider_catalog_get", sessionId: evt.sessionId });
            socket.send({ type: "provider_auth_methods_get", sessionId: evt.sessionId });
            socket.send({ type: "refresh_provider_status", sessionId: evt.sessionId });
            socket.send({ type: "mcp_servers_get", sessionId: evt.sessionId });
            socket.send({ type: "memory_list", sessionId: evt.sessionId });
          } catch {
            // ignore
          }
          return;
        }

        const controlSessionId = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
        if (!controlSessionId || evt.sessionId !== controlSessionId) {
          return;
        }

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

        if (evt.type === "sessions") {
          let removedSessionSnapshotIds: string[] = [];
          set((s) => {
            removedSessionSnapshotIds = pruneRemovedWorkspaceSessionSnapshots(
              s.threads,
              s.threadRuntimeById,
              workspaceId,
              evt.sessions,
            );
            const nextThreads = upsertWorkspaceThreads(
              s.threads,
              s.threadRuntimeById,
              workspaceId,
              evt.sessions,
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
          if (removedSessionSnapshotIds.length > 0) {
            for (const sessionId of removedSessionSnapshotIds) {
              RUNTIME.sessionSnapshots.delete(sessionId);
            }
          }
          void deps.persist(get);
          resolveWorkspaceSessionWaiters(workspaceId, evt.sessions);
          return;
        }

        if (evt.type === "session_snapshot") {
          resolveSessionSnapshotWaiters(workspaceId, evt.targetSessionId, evt.snapshot);
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
            providerStatusRefreshing: false,
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

          if (!evt.ok) return;

          const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
          if (!sid) return;

          set(() => ({ providerStatusRefreshing: true }));
          try {
            socket.send({ type: "refresh_provider_status", sessionId: sid });
            socket.send({ type: "provider_catalog_get", sessionId: sid });
          } catch {
            set(() => ({ providerStatusRefreshing: false }));
          }
          return;
        }

        if (evt.type === "error") {
          resolvePendingControlRequestWaitersOnError(workspaceId, evt);
          const workspaceRuntimeBefore = get().workspaceRuntimeById[workspaceId];
          const installWaiter = RUNTIME.skillInstallWaiters.get(workspaceId);
          const hasPendingSkillStateBefore =
            workspaceRuntimeBefore &&
            (workspaceRuntimeBefore.skillCatalogLoading ||
              Object.keys(workspaceRuntimeBefore.skillMutationPendingKeys).length > 0);
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
              providerStatusRefreshing: false,
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
      },
      onClose: () => {
        if (RUNTIME.controlSockets.get(workspaceId) !== socket) {
          return;
        }
        RUNTIME.controlSockets.delete(workspaceId);
        const installWaiter = RUNTIME.skillInstallWaiters.get(workspaceId);
        if (installWaiter) {
          RUNTIME.skillInstallWaiters.delete(workspaceId);
          installWaiter.reject(new Error("Control connection closed"));
        }
        resolveControlSessionWaiters(workspaceId, null);
        resolveWorkspaceSessionWaiters(workspaceId, null);
        for (const key of [...sessionSnapshotWaiters.keys()]) {
          if (!key.startsWith(`${workspaceId}:`)) continue;
          resolveSessionSnapshotWaiters(workspaceId, key.slice(workspaceId.length + 1), null);
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
                  },
                }
              : s.workspaceRuntimeById,
          };
        });
      },
    });

    RUNTIME.controlSockets.set(workspaceId, socket);
    socket.connect();
    return socket;
  }

  async function waitForControlSession(get: StoreGet, workspaceId: string, timeoutMs = 3_000): Promise<boolean> {
    if (get().workspaceRuntimeById[workspaceId]?.controlSessionId) {
      return true;
    }

    const workspaceRuntime = get().workspaceRuntimeById[workspaceId];
    if (!workspaceRuntime?.serverUrl || workspaceRuntime.error || !RUNTIME.controlSockets.get(workspaceId)) {
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(get().workspaceRuntimeById[workspaceId]?.controlSessionId ?? null);
      }, timeoutMs);

      const finish = (sessionId: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const waiters = controlSessionWaiters.get(workspaceId);
        waiters?.delete(finish);
        if (waiters && waiters.size === 0) {
          controlSessionWaiters.delete(workspaceId);
        }
        resolve(Boolean(sessionId));
      };

      const waiters = controlSessionWaiters.get(workspaceId) ?? new Set<(sessionId: string | null) => void>();
      waiters.add(finish);
      controlSessionWaiters.set(workspaceId, waiters);
    });
  }

  function sendControl(get: StoreGet, workspaceId: string, build: (sessionId: string) => ClientMessage): boolean {
    const sock = RUNTIME.controlSockets.get(workspaceId);
    const sessionId = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
    if (!sock || !sessionId) return false;
    return sock.send(build(sessionId));
  }

  async function requestWorkspaceSessions(
    get: StoreGet,
    set: StoreSet,
    workspaceId: string,
  ): Promise<Extract<ServerEvent, { type: "sessions" }>["sessions"] | null> {
    ensureControlSocket(get, set, workspaceId);
    const ready = await waitForControlSession(get, workspaceId);
    const sessionId = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
    if (!ready || !sessionId) return null;
    return await withTimeout((resolve) => {
      const unregister = registerWaiter(workspaceSessionWaiters, workspaceId, resolve);
      const socket = RUNTIME.controlSockets.get(workspaceId);
      if (!socket?.send({ type: "list_sessions", sessionId, scope: "workspace" })) {
        resolveWorkspaceSessionWaiters(workspaceId, null);
      }
      return unregister;
    });
  }

  async function requestSessionSnapshot(
    get: StoreGet,
    set: StoreSet,
    workspaceId: string,
    targetSessionId: string,
  ): Promise<SessionSnapshot | null> {
    ensureControlSocket(get, set, workspaceId);
    const ready = await waitForControlSession(get, workspaceId);
    const sessionId = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
    if (!ready || !sessionId) return null;
    return await withTimeout((resolve) => {
      const key = snapshotWaiterKey(workspaceId, targetSessionId);
      const unregister = registerWaiter(sessionSnapshotWaiters, key, resolve);
      const socket = RUNTIME.controlSockets.get(workspaceId);
      if (!socket?.send({ type: "get_session_snapshot", sessionId, targetSessionId })) {
        resolveSessionSnapshotWaiters(workspaceId, targetSessionId, null);
      }
      return unregister;
    });
  }

  return {
    ensureControlSocket,
    waitForControlSession,
    sendControl,
    requestWorkspaceSessions,
    requestSessionSnapshot,
    __internal: {
      getPendingWaiterCounts: () => ({
        controlSessionWaiters: [...controlSessionWaiters.values()].reduce((total, waiters) => total + waiters.size, 0),
        workspaceSessionWaiters: [...workspaceSessionWaiters.values()].reduce((total, waiters) => total + waiters.size, 0),
        sessionSnapshotWaiters: [...sessionSnapshotWaiters.values()].reduce((total, waiters) => total + waiters.size, 0),
      }),
    },
  };
}
