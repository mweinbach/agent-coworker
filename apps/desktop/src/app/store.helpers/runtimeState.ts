import { AgentSocket } from "../../lib/agentSocket";
import type { ProviderName } from "../../lib/wsProtocol";
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
  expectedTurnId: string;
  accepted: boolean;
};

export type WorkspaceDefaultApplyMode = "auto" | "auto-resume" | "explicit";

export type DraftModelSelection = {
  provider: ProviderName;
  model: string;
};

export type PendingWorkspaceDefaultApply = {
  mode: WorkspaceDefaultApplyMode;
  draftModelSelection: DraftModelSelection | null;
};

export type SkillInstallWaiter = {
  pendingKey: string;
  resolve: () => void;
  reject: (err: Error) => void;
};

export type RuntimeMaps = {
  controlSockets: Map<string, AgentSocket>;
  /** Latest in-flight skill install per workspace; resolved when `skills_catalog` completes the matching pending key. */
  skillInstallWaiters: Map<string, SkillInstallWaiter>;
  threadSockets: Map<string, AgentSocket>;
  optimisticUserMessageIds: Map<string, Set<string>>;
  pendingThreadMessages: Map<string, string[]>;
  pendingThreadSteers: Map<string, Map<string, PendingThreadSteer>>;
  threadSelectionRequests: Map<string, number>;
  nextThreadSelectionRequestId: number;
  pendingWorkspaceDefaultApplyByThread: Map<string, PendingWorkspaceDefaultApply>;
  workspaceStartPromises: Map<string, { generation: number; promise: Promise<void> }>;
  workspaceStartGenerations: Map<string, number>;
  modelStreamByThread: Map<string, ThreadModelStreamRuntime>;
  sessionSnapshots: Map<string, CachedSessionSnapshot>;
  workspacePickerOpen: boolean;
};

export const RUNTIME: RuntimeMaps = {
  controlSockets: new Map(),
  skillInstallWaiters: new Map(),
  threadSockets: new Map(),
  optimisticUserMessageIds: new Map(),
  pendingThreadMessages: new Map(),
  pendingThreadSteers: new Map(),
  threadSelectionRequests: new Map(),
  nextThreadSelectionRequestId: 0,
  pendingWorkspaceDefaultApplyByThread: new Map(),
  workspaceStartPromises: new Map(),
  workspaceStartGenerations: new Map(),
  modelStreamByThread: new Map(),
  sessionSnapshots: new Map(),
  workspacePickerOpen: false,
};

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

export function queuePendingThreadMessage(threadId: string, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const existing = RUNTIME.pendingThreadMessages.get(threadId) ?? [];
  existing.push(trimmed);
  RUNTIME.pendingThreadMessages.set(threadId, existing);
}

export function drainPendingThreadMessages(threadId: string): string[] {
  const existing = RUNTIME.pendingThreadMessages.get(threadId);
  if (!existing || existing.length === 0) return [];
  RUNTIME.pendingThreadMessages.delete(threadId);
  return existing;
}

export function shiftPendingThreadMessage(threadId: string): string | undefined {
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

export function rememberPendingThreadSteer(threadId: string, steer: PendingThreadSteer) {
  const existing = RUNTIME.pendingThreadSteers.get(threadId) ?? new Map<string, PendingThreadSteer>();
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

  moveMapEntry(RUNTIME.threadSockets, fromThreadId, toThreadId);
  moveMapEntry(RUNTIME.optimisticUserMessageIds, fromThreadId, toThreadId);
  moveMapEntry(RUNTIME.pendingThreadMessages, fromThreadId, toThreadId);
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
    error: null,
    controlSessionId: null,
    controlConfig: null,
    controlSessionConfig: null,
    controlEnableMcp: null,
    mcpServers: [],
    mcpLegacy: null,
    mcpFiles: [],
    mcpWarnings: [],
    mcpValidationByName: {},
    mcpLastAuthChallenge: null,
    mcpLastAuthResult: null,
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
    memories: [],
    memoriesLoading: false,
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
    pendingSteer: null,
    feed: [],
    hydrating: false,
    transcriptOnly: false,
  };
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
      [threadId]: defaultThreadRuntime(),
    },
  }));
}
