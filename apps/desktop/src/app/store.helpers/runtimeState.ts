import { AgentSocket } from "../../lib/agentSocket";
import {
  clearThreadModelStreamRuntime,
  createThreadModelStreamRuntime,
  type ThreadModelStreamRuntime,
} from "../store.feedMapping";
import type { AppStoreState } from "../store.helpers";
import type { ThreadRuntime, WorkspaceRuntime } from "../types";

export type RuntimeMaps = {
  controlSockets: Map<string, AgentSocket>;
  threadSockets: Map<string, AgentSocket>;
  optimisticUserMessageIds: Map<string, Set<string>>;
  pendingThreadMessages: Map<string, string[]>;
  pendingWorkspaceDefaultApplyThreadIds: Set<string>;
  workspaceStartPromises: Map<string, Promise<void>>;
  modelStreamByThread: Map<string, ThreadModelStreamRuntime>;
  workspacePickerOpen: boolean;
};

export const RUNTIME: RuntimeMaps = {
  controlSockets: new Map(),
  threadSockets: new Map(),
  optimisticUserMessageIds: new Map(),
  pendingThreadMessages: new Map(),
  pendingWorkspaceDefaultApplyThreadIds: new Set(),
  workspaceStartPromises: new Map(),
  modelStreamByThread: new Map(),
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
    selectedSkillName: null,
    selectedSkillContent: null,
  };
}

export function defaultThreadRuntime(): ThreadRuntime {
  return {
    wsUrl: null,
    connected: false,
    sessionId: null,
    config: null,
    sessionConfig: null,
    enableMcp: null,
    busy: false,
    busySince: null,
    feed: [],
    transcriptOnly: false,
  };
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
