import { create } from "zustand";

import type { JsonRpcControlRequest } from "@/cowork-shared/jsonrpcControlSchemas";
import {
  callParsedControlMethod,
  captureWorkspaceRequest,
  isStaleWorkspaceRequestError,
  parseWorkspaceControlSnapshot,
  StaleWorkspaceRequestError,
  type WorkspaceControlSnapshot,
} from "./controlRpc";
import type { CoworkJsonRpcClient } from "./jsonRpcClient";
import { saveToOfflineCache, setOfflineCacheWorkspace } from "./offlineCacheStorage";
import type { WorkspaceListResult, WorkspaceSummary, WorkspaceSwitchResult } from "./protocolTypes";
import { workspaceListResultSchema, workspaceSwitchResultSchema } from "./protocolTypes";
import { getActiveCoworkJsonRpcClient, invalidateWorkspaceRequests } from "./runtimeClient";

type WorkspaceStoreState = {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  activeWorkspaceName: string | null;
  activeWorkspaceCwd: string | null;
  controlSnapshot: WorkspaceControlSnapshot | null;
  loading: boolean;
  error: string | null;
  switchingWorkspaceId: string | null;
  switchIncomplete: boolean;

  fetchWorkspaces(): Promise<void>;
  switchWorkspace(workspaceId: string): Promise<WorkspaceSwitchResult>;
  fetchControlState(): Promise<void>;
  applyWorkspaceDefaults(
    patch: Omit<JsonRpcControlRequest<"cowork/session/defaults/apply">, "cwd">,
  ): Promise<boolean>;
  setActiveFromCwd(cwd: string): void;
  clear(): void;
};

let workspaceListRequest = 0;

function getClient(): CoworkJsonRpcClient {
  const client = getActiveCoworkJsonRpcClient();
  if (!client) {
    throw new Error("No active JSON-RPC client.");
  }
  return client;
}

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  activeWorkspaceName: null,
  activeWorkspaceCwd: null,
  controlSnapshot: null,
  loading: false,
  error: null,
  switchingWorkspaceId: null,
  switchIncomplete: false,

  async fetchWorkspaces() {
    const request = ++workspaceListRequest;
    let isCurrent = () => true;
    set({ loading: true, error: null });
    try {
      const client = getClient();
      isCurrent = captureWorkspaceRequest(client);
      const result = await client.call<WorkspaceListResult>("workspace/list");
      if (!isCurrent() || request !== workspaceListRequest) return;
      const parsed = workspaceListResultSchema.parse(result);
      const active = parsed.activeWorkspaceId
        ? (parsed.workspaces.find((w) => w.id === parsed.activeWorkspaceId) ?? null)
        : null;
      set({
        workspaces: parsed.workspaces,
        activeWorkspaceId: parsed.activeWorkspaceId,
        activeWorkspaceName: active?.name ?? null,
        activeWorkspaceCwd: active?.path ?? null,
        ...(get().activeWorkspaceCwd !== (active?.path ?? null) ? { controlSnapshot: null } : {}),
        loading: false,
      });
      // Save to offline cache
      void saveToOfflineCache("workspaces", parsed.workspaces);
      void saveToOfflineCache("activeWorkspaceId", parsed.activeWorkspaceId);
      void saveToOfflineCache("activeWorkspaceName", active?.name ?? null);
      void saveToOfflineCache("activeWorkspaceCwd", active?.path ?? null);
    } catch (error) {
      if (!isCurrent() || request !== workspaceListRequest) return;
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async switchWorkspace(workspaceId: string) {
    const client = getClient();
    const { workspaces } = get();
    const target = workspaces.find((w) => w.id === workspaceId);
    if (!target) {
      const error = new Error(`Workspace ${workspaceId} not found.`);
      set({ error: error.message });
      throw error;
    }
    invalidateWorkspaceRequests();
    const isCurrent = captureWorkspaceRequest(client);
    set({ loading: true, error: null });
    try {
      const result = await client.call<WorkspaceSwitchResult>("workspace/switch", { workspaceId });
      if (!isCurrent()) throw new StaleWorkspaceRequestError();
      const parsed = workspaceSwitchResultSchema.parse(result);
      client.resetTransportSession("Workspace switched.");
      set({
        activeWorkspaceId: parsed.workspaceId,
        activeWorkspaceName: parsed.name,
        activeWorkspaceCwd: parsed.path,
        loading: false,
        controlSnapshot: null,
      });
      // Save to offline cache
      void saveToOfflineCache("activeWorkspaceId", parsed.workspaceId);
      void saveToOfflineCache("activeWorkspaceName", parsed.name);
      void saveToOfflineCache("activeWorkspaceCwd", parsed.path);
      void saveToOfflineCache("controlSnapshot", null);
      return parsed;
    } catch (error) {
      if (isStaleWorkspaceRequestError(error) || !isCurrent())
        throw new StaleWorkspaceRequestError();
      const nextError = error instanceof Error ? error : new Error(String(error));
      set({
        loading: false,
        error: nextError.message,
      });
      throw nextError;
    }
  },

  async fetchControlState() {
    const { activeWorkspaceCwd } = get();
    if (!activeWorkspaceCwd) return;
    try {
      const client = getClient();
      const result = await callParsedControlMethod(client, "cowork/session/state/read", {
        cwd: activeWorkspaceCwd,
      });
      const snapshot = parseWorkspaceControlSnapshot(result);
      set({
        controlSnapshot: snapshot,
      });
      void saveToOfflineCache("controlSnapshot", snapshot);
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async applyWorkspaceDefaults(patch) {
    set({ error: null });
    try {
      const client = getClient();
      const { activeWorkspaceCwd } = get();
      if (!activeWorkspaceCwd) throw new Error("No active workspace.");
      await callParsedControlMethod(client, "cowork/session/defaults/apply", {
        cwd: activeWorkspaceCwd,
        ...patch,
      });
      await get().fetchControlState();
      return true;
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return false;
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  setActiveFromCwd(cwd: string) {
    if (get().activeWorkspaceCwd === cwd) return;
    const { workspaces } = get();
    const match = workspaces.find((w) => w.path === cwd);
    if (match) {
      set({
        activeWorkspaceId: match.id,
        activeWorkspaceName: match.name,
        activeWorkspaceCwd: match.path,
        controlSnapshot: null,
      });
    } else {
      set({
        activeWorkspaceCwd: cwd,
        activeWorkspaceId: null,
        activeWorkspaceName: null,
        controlSnapshot: null,
      });
    }
  },

  clear() {
    workspaceListRequest += 1;
    invalidateWorkspaceRequests();
    set({
      workspaces: [],
      activeWorkspaceId: null,
      activeWorkspaceName: null,
      activeWorkspaceCwd: null,
      controlSnapshot: null,
      loading: false,
      error: null,
      switchingWorkspaceId: null,
      switchIncomplete: false,
    });
  },
}));

useWorkspaceStore.subscribe((state, previous) => {
  if (
    state.activeWorkspaceId !== previous.activeWorkspaceId ||
    state.activeWorkspaceCwd !== previous.activeWorkspaceCwd
  ) {
    setOfflineCacheWorkspace(state.activeWorkspaceCwd);
    invalidateWorkspaceRequests();
  }
});
