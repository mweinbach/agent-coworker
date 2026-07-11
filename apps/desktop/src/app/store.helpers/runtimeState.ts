import type { JsonRpcSocket } from "../../lib/agentSocket";
import type { ProviderName, TurnReference } from "../../lib/wsProtocol";
import type { ComposerDraftRevision } from "../composerDrafts";
import type { ReasoningEffortValue } from "../openaiCompatibleProviderOptions";
import {
  clearThreadModelStreamRuntime,
  createThreadModelStreamRuntime,
  type ThreadModelStreamRuntime,
} from "../store.feedMapping";
import type { AppStoreState } from "../store.helpers";
import type { CachedSessionSnapshot, ThreadRuntime, WorkspaceRuntime } from "../types";

export type PendingThreadSteer = {
  clientMessageId: string;
  text: string;
  attachmentSignature?: string;
  expectedTurnId: string;
  accepted: boolean;
};

type WorkspaceDefaultApplyMode = "auto" | "auto-resume" | "explicit";

export type DraftModelSelection = {
  provider: ProviderName;
  model: string;
  reasoningEffort?: ReasoningEffortValue;
};

type PendingWorkspaceDefaultApply = {
  mode: WorkspaceDefaultApplyMode;
  draftModelSelection: DraftModelSelection | null;
  allowBeforeHydration?: boolean;
  inFlight?: boolean;
};

type SkillInstallWaiter = {
  pendingKey: string;
  resolve: () => void;
  reject: (err: Error) => void;
};

export type PendingThreadMessage = {
  text: string;
  /**
   * Present when the message was already rendered as an optimistic user bubble
   * at queue time; the eventual send reuses it so the bubble is not duplicated
   * and the server echo dedups against it.
   */
  clientMessageId?: string;
  draftSubmission?: ComposerDraftRevision;
};

export type RuntimeMaps = {
  jsonRpcSockets: Map<string, JsonRpcSocket>;
  workspaceJsonRpcSocketGenerations: Map<string, number>;
  /** Latest in-flight skill install per workspace; resolved when `skills_catalog` completes the matching pending key. */
  skillInstallWaiters: Map<string, SkillInstallWaiter>;
  /** Latest in-flight plugin install per workspace; resolved when `plugins_catalog` completes the matching pending key. */
  pluginInstallWaiters: Map<string, SkillInstallWaiter>;
  optimisticUserMessageIds: Map<string, Set<string>>;
  pendingThreadMessages: Map<string, PendingThreadMessage[]>;
  pendingThreadAttachments: Map<
    string,
    Array<import("./jsonRpcSocket").FileAttachmentInput[] | undefined>
  >;
  pendingThreadReferences: Map<string, Array<TurnReference[] | undefined>>;
  pendingThreadSteers: Map<string, Map<string, PendingThreadSteer>>;
  threadSelectionRequests: Map<string, number>;
  nextThreadSelectionRequestId: number;
  pendingWorkspaceDefaultApplyByThread: Map<string, PendingWorkspaceDefaultApply>;
  workspaceStartPromises: Map<string, { generation: number; promise: Promise<void> }>;
  workspaceStartGenerations: Map<string, number>;
  workspaceServerRestartAttempts: Map<string, number>;
  workspaceServerRestartStabilityTimers: Map<string, ReturnType<typeof setTimeout>>;
  modelStreamByThread: Map<string, ThreadModelStreamRuntime>;
  sessionSnapshots: Map<string, CachedSessionSnapshot>;
  workspacePickerOpen: boolean;
  /** Monotonic counter so overlapping provider status refreshes do not clear `providerStatusRefreshing` early. */
  providerStatusRefreshGeneration: number;
  /** Per-workspace/server counter so stale MCP OAuth refresh polls stop after auth completes. */
  mcpOAuthRefreshPollGenerations: Map<string, number>;
  /** Per-workspace counter used to ignore stale subagent profile catalog reads after mutations. */
  agentProfilesCatalogGenerations: Map<string, number>;
  /** Serializes persisted attachment conversion so cross-draft byte reservations cannot race. */
  composerAttachmentIngestionTail: Promise<void> | null;
};

export const RUNTIME: RuntimeMaps = {
  jsonRpcSockets: new Map(),
  workspaceJsonRpcSocketGenerations: new Map(),
  skillInstallWaiters: new Map(),
  pluginInstallWaiters: new Map(),
  optimisticUserMessageIds: new Map(),
  pendingThreadMessages: new Map(),
  pendingThreadAttachments: new Map(),
  pendingThreadReferences: new Map(),
  pendingThreadSteers: new Map(),
  threadSelectionRequests: new Map(),
  nextThreadSelectionRequestId: 0,
  pendingWorkspaceDefaultApplyByThread: new Map(),
  workspaceStartPromises: new Map(),
  workspaceStartGenerations: new Map(),
  workspaceServerRestartAttempts: new Map(),
  workspaceServerRestartStabilityTimers: new Map(),
  modelStreamByThread: new Map(),
  sessionSnapshots: new Map(),
  workspacePickerOpen: false,
  providerStatusRefreshGeneration: 0,
  mcpOAuthRefreshPollGenerations: new Map(),
  agentProfilesCatalogGenerations: new Map(),
  composerAttachmentIngestionTail: null,
};

export function getAgentProfilesCatalogGeneration(workspaceId: string): number {
  return RUNTIME.agentProfilesCatalogGenerations.get(workspaceId) ?? 0;
}

export function bumpAgentProfilesCatalogGeneration(workspaceId: string): number {
  const next = getAgentProfilesCatalogGeneration(workspaceId) + 1;
  RUNTIME.agentProfilesCatalogGenerations.set(workspaceId, next);
  return next;
}

export function getModelStreamRuntime(threadId: string): ThreadModelStreamRuntime {
  const existing = RUNTIME.modelStreamByThread.get(threadId);
  if (existing) return existing;
  const next = createThreadModelStreamRuntime();
  RUNTIME.modelStreamByThread.set(threadId, next);
  return next;
}

export function resetModelStreamRuntime(threadId: string) {
  const existing = RUNTIME.modelStreamByThread.get(threadId);
  if (existing) {
    clearThreadModelStreamRuntime(existing);
    return;
  }
  RUNTIME.modelStreamByThread.set(threadId, createThreadModelStreamRuntime());
}

export function queuePendingThreadMessage(
  threadId: string,
  text: string,
  attachments?: import("./jsonRpcSocket").FileAttachmentInput[],
  references?: TurnReference[],
  clientMessageId?: string,
  draftSubmission?: ComposerDraftRevision,
) {
  const trimmed = text.trim();
  if (!trimmed && (!attachments || attachments.length === 0)) return;
  const existing = RUNTIME.pendingThreadMessages.get(threadId) ?? [];
  existing.push({
    text: trimmed,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(draftSubmission ? { draftSubmission } : {}),
  });
  RUNTIME.pendingThreadMessages.set(threadId, existing);
  const existingAttachments = RUNTIME.pendingThreadAttachments.get(threadId) ?? [];
  existingAttachments.push(attachments && attachments.length > 0 ? attachments : undefined);
  RUNTIME.pendingThreadAttachments.set(threadId, existingAttachments);
  const existingReferences = RUNTIME.pendingThreadReferences.get(threadId) ?? [];
  existingReferences.push(references && references.length > 0 ? [...references] : undefined);
  RUNTIME.pendingThreadReferences.set(threadId, existingReferences);
}

export function shiftPendingThreadAttachments(
  threadId: string,
): import("./jsonRpcSocket").FileAttachmentInput[] | undefined {
  const existing = RUNTIME.pendingThreadAttachments.get(threadId);
  if (!existing || existing.length === 0) return undefined;
  const next = existing.shift();
  if (existing.length === 0) {
    RUNTIME.pendingThreadAttachments.delete(threadId);
  } else {
    RUNTIME.pendingThreadAttachments.set(threadId, existing);
  }
  return next;
}

export function shiftPendingThreadReferences(threadId: string): TurnReference[] | undefined {
  const existing = RUNTIME.pendingThreadReferences.get(threadId);
  if (!existing || existing.length === 0) return undefined;
  const next = existing.shift();
  if (existing.length === 0) {
    RUNTIME.pendingThreadReferences.delete(threadId);
  } else {
    RUNTIME.pendingThreadReferences.set(threadId, existing);
  }
  return next;
}

export function shiftPendingThreadMessage(threadId: string): PendingThreadMessage | undefined {
  const existing = RUNTIME.pendingThreadMessages.get(threadId);
  if (!existing || existing.length === 0) return undefined;
  const next = existing.shift();
  if (existing.length === 0) {
    RUNTIME.pendingThreadMessages.delete(threadId);
  } else {
    RUNTIME.pendingThreadMessages.set(threadId, existing);
  }
  return next;
}

export function prependPendingThreadMessageWithAttachments(
  threadId: string,
  text: string,
  attachments?: import("./jsonRpcSocket").FileAttachmentInput[],
  references?: TurnReference[],
  clientMessageId?: string,
  draftSubmission?: ComposerDraftRevision,
) {
  const trimmed = text.trim();
  if (!trimmed && (!attachments || attachments.length === 0)) return;
  const existingMessages = RUNTIME.pendingThreadMessages.get(threadId) ?? [];
  existingMessages.unshift({
    text: trimmed,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(draftSubmission ? { draftSubmission } : {}),
  });
  RUNTIME.pendingThreadMessages.set(threadId, existingMessages);
  const existingAttachments = RUNTIME.pendingThreadAttachments.get(threadId) ?? [];
  existingAttachments.unshift(attachments && attachments.length > 0 ? attachments : undefined);
  RUNTIME.pendingThreadAttachments.set(threadId, existingAttachments);
  const existingReferences = RUNTIME.pendingThreadReferences.get(threadId) ?? [];
  existingReferences.unshift(references && references.length > 0 ? [...references] : undefined);
  RUNTIME.pendingThreadReferences.set(threadId, existingReferences);
}

export function rememberPendingThreadSteer(threadId: string, steer: PendingThreadSteer) {
  const existing =
    RUNTIME.pendingThreadSteers.get(threadId) ?? new Map<string, PendingThreadSteer>();
  existing.set(steer.clientMessageId, steer);
  RUNTIME.pendingThreadSteers.set(threadId, existing);
}

export function hasPendingThreadSteer(threadId: string, clientMessageId: string): boolean {
  return RUNTIME.pendingThreadSteers.get(threadId)?.has(clientMessageId) ?? false;
}

export function markPendingThreadSteerAccepted(threadId: string, clientMessageId: string) {
  const existing = RUNTIME.pendingThreadSteers.get(threadId);
  const steer = existing?.get(clientMessageId);
  if (!existing || !steer) return;
  existing.set(clientMessageId, { ...steer, accepted: true });
}

export function clearPendingThreadSteer(threadId: string, clientMessageId: string) {
  const existing = RUNTIME.pendingThreadSteers.get(threadId);
  if (!existing) return;
  existing.delete(clientMessageId);
  if (existing.size === 0) {
    RUNTIME.pendingThreadSteers.delete(threadId);
  }
}

export function clearPendingThreadSteers(threadId: string) {
  RUNTIME.pendingThreadSteers.delete(threadId);
}

function moveMapEntry<T>(map: Map<string, T>, from: string, to: string): void {
  if (from === to) return;
  if (!map.has(from) || map.has(to)) {
    map.delete(from);
    return;
  }
  const value = map.get(from);
  map.delete(from);
  if (value !== undefined) {
    map.set(to, value);
  }
}

export function rekeyThreadRuntimeMaps(fromThreadId: string, toThreadId: string): void {
  if (!fromThreadId || !toThreadId || fromThreadId === toThreadId) {
    return;
  }

  moveMapEntry(RUNTIME.optimisticUserMessageIds, fromThreadId, toThreadId);
  moveMapEntry(RUNTIME.pendingThreadMessages, fromThreadId, toThreadId);
  moveMapEntry(RUNTIME.pendingThreadAttachments, fromThreadId, toThreadId);
  moveMapEntry(RUNTIME.pendingThreadReferences, fromThreadId, toThreadId);
  moveMapEntry(RUNTIME.pendingThreadSteers, fromThreadId, toThreadId);
  moveMapEntry(RUNTIME.pendingWorkspaceDefaultApplyByThread, fromThreadId, toThreadId);
  moveMapEntry(RUNTIME.modelStreamByThread, fromThreadId, toThreadId);
}

export function beginThreadSelectionRequest(threadId: string): number {
  const next = RUNTIME.nextThreadSelectionRequestId + 1;
  RUNTIME.nextThreadSelectionRequestId = next;
  RUNTIME.threadSelectionRequests.set(threadId, next);
  return next;
}

export function isCurrentThreadSelectionRequest(threadId: string, requestId: number): boolean {
  return RUNTIME.threadSelectionRequests.get(threadId) === requestId;
}

export function clearThreadSelectionRequest(threadId: string, requestId?: number): void {
  if (requestId !== undefined && !isCurrentThreadSelectionRequest(threadId, requestId)) {
    return;
  }
  RUNTIME.threadSelectionRequests.delete(threadId);
}

export function defaultWorkspaceRuntime(): WorkspaceRuntime {
  return {
    serverUrl: null,
    starting: false,
    startupProgress: null,
    error: null,
    controlSessionId: null,
    controlConfig: null,
    controlSessionConfig: null,
    controlEnableMcp: null,
    mcpServers: [],
    mcpFiles: [],
    mcpWarnings: [],
    mcpValidationByName: {},
    mcpLastAuthChallenge: null,
    mcpLastAuthResult: null,
    providerCatalog: [],
    agentProfilesCatalog: null,
    agentProfilesLoading: false,
    agentProfilesError: null,
    openAiNativeConnectors: [],
    openAiNativeConnectorsLoading: false,
    openAiNativeConnectorsError: null,
    openAiNativeConnectorsAuthenticated: false,
    openAiNativeConnectorsMessage: null,
    openAiNativeConnectorsEnabledIds: [],
    pluginsCatalog: null,
    selectedPluginId: null,
    selectedPluginScope: null,
    selectedPlugin: null,
    selectedPluginPreview: null,
    pluginsLoading: false,
    pluginsError: null,
    skills: [],
    skillsCatalog: null,
    selectedSkillName: null,
    selectedSkillContent: null,
    selectedSkillInstallationId: null,
    selectedSkillInstallation: null,
    selectedSkillPreview: null,
    skillUpdateChecksByInstallationId: {},
    skillCatalogLoading: false,
    skillCatalogError: null,
    skillsMutationBlocked: false,
    skillsMutationBlockedReason: null,
    skillMutationPendingKeys: {},
    skillMutationError: null,
    pluginMutationPendingKeys: {},
    pluginMutationError: null,
    marketplaces: null,
    marketplacesLoading: false,
    marketplacesError: null,
    marketplaceMutationPendingKeys: {},
    marketplaceMutationError: null,
    selectedMarketplaceId: null,
    selectedMarketplaceDetail: null,
    marketplaceDetailLoading: false,
    marketplaceDetailError: null,
    importItemsByKey: {},
    importPendingKeys: {},
    memories: [],
    memoriesLoading: false,
    advancedMemories: [],
    advancedMemoryFolders: [],
    advancedMemoryActiveFolder: null,
    advancedMemoriesLoading: false,
    skillImprovementStatus: null,
    skillImprovementLoading: false,
    skillImprovementPendingActionKeys: {},
    workspaceBackupsPath: null,
    workspaceBackups: [],
    workspaceBackupsLoading: false,
    workspaceBackupsError: null,
    workspaceBackupPendingActionKeys: {},
    workspaceBackupDelta: null,
    workspaceBackupDeltaLoading: false,
    workspaceBackupDeltaError: null,
  };
}

export function defaultThreadRuntime(): ThreadRuntime {
  return {
    wsUrl: null,
    connected: false,
    sessionId: null,
    lastEventSeq: 0,
    config: null,
    sessionConfig: null,
    sessionKind: null,
    parentSessionId: null,
    role: null,
    mode: null,
    depth: 0,
    nickname: null,
    requestedModel: null,
    effectiveModel: null,
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: null,
    agents: [],
    sessionUsage: null,
    lastTurnUsage: null,
    enableMcp: null,
    busy: false,
    busySince: null,
    activeTurnId: null,
    pendingTurnStart: null,
    pendingSteer: null,
    feed: [],
    hydrating: false,
    transcriptOnly: false,
    composerReasoningEffort: null,
  };
}

export function getEffectiveThreadLastEventSeq(
  state: Pick<AppStoreState, "threadRuntimeById" | "threads">,
  threadId: string,
): number {
  const persistedSequence =
    state.threads.find((thread) => thread.id === threadId)?.lastEventSeq ?? 0;
  const runtimeSequence = state.threadRuntimeById[threadId]?.lastEventSeq ?? 0;
  return Math.max(0, Math.floor(Math.max(persistedSequence, runtimeSequence)));
}

export function getWorkspaceJsonRpcSocketGeneration(workspaceId: string): number {
  return RUNTIME.workspaceJsonRpcSocketGenerations.get(workspaceId) ?? 0;
}

export function bumpWorkspaceJsonRpcSocketGeneration(workspaceId: string): number {
  const next = getWorkspaceJsonRpcSocketGeneration(workspaceId) + 1;
  RUNTIME.workspaceJsonRpcSocketGenerations.set(workspaceId, next);
  return next;
}

export function clearWorkspaceJsonRpcSocketGeneration(workspaceId: string): void {
  RUNTIME.workspaceJsonRpcSocketGenerations.delete(workspaceId);
}

export function getWorkspaceStartGeneration(workspaceId: string): number {
  return RUNTIME.workspaceStartGenerations.get(workspaceId) ?? 0;
}

export function bumpWorkspaceStartGeneration(workspaceId: string): number {
  const next = getWorkspaceStartGeneration(workspaceId) + 1;
  RUNTIME.workspaceStartGenerations.set(workspaceId, next);
  return next;
}

export function clearWorkspaceStartState(workspaceId: string): void {
  RUNTIME.workspaceStartPromises.delete(workspaceId);
  RUNTIME.workspaceStartGenerations.delete(workspaceId);
  clearWorkspaceServerRestartBackoffState(workspaceId);
}

export function clearWorkspaceServerRestartStabilityTimer(workspaceId: string): void {
  const timer = RUNTIME.workspaceServerRestartStabilityTimers.get(workspaceId);
  if (timer) {
    clearTimeout(timer);
  }
  RUNTIME.workspaceServerRestartStabilityTimers.delete(workspaceId);
}

export function clearWorkspaceServerRestartBackoffState(workspaceId: string): void {
  clearWorkspaceServerRestartStabilityTimer(workspaceId);
  RUNTIME.workspaceServerRestartAttempts.delete(workspaceId);
}

export function ensureWorkspaceRuntime(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  workspaceId: string,
) {
  const existing = get().workspaceRuntimeById[workspaceId];
  if (existing) return;
  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: defaultWorkspaceRuntime(),
    },
  }));
}

export function ensureThreadRuntime(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string,
) {
  const existing = get().threadRuntimeById[threadId];
  if (existing) return;
  set((s) => ({
    threadRuntimeById: {
      ...s.threadRuntimeById,
      [threadId]: {
        ...defaultThreadRuntime(),
        lastEventSeq: getEffectiveThreadLastEventSeq(s, threadId),
      },
    },
  }));
}
