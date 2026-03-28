import { create } from "zustand";

import type { JsonRpcControlRequest } from "../../../../../src/shared/jsonrpcControlSchemas";
import { callParsedControlMethod, parseWorkspaceControlSnapshot, type WorkspaceControlSnapshot } from "./controlRpc";
import type { CoworkJsonRpcClient } from "./jsonRpcClient";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import type { WorkspaceSummary, WorkspaceListResult, WorkspaceSwitchResult } from "./protocolTypes";
import { workspaceListResultSchema, workspaceSwitchResultSchema } from "./protocolTypes";

type WorkspaceStoreState = {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  activeWorkspaceName: string | null;
  activeWorkspaceCwd: string | null;
  controlSnapshot: WorkspaceControlSnapshot | null;
  loading: boolean;
  error: string | null;

  fetchWorkspaces(): Promise<void>;
  switchWorkspace(workspaceId: string): Promise<WorkspaceSwitchResult>;
  fetchControlState(): Promise<void>;
  applyWorkspaceDefaults(patch: Omit<JsonRpcControlRequest<"cowork/session/defaults/apply">, "cwd">): Promise<void>;
  setActiveFromCwd(cwd: string): void;
  clear(): void;
};

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

  async fetchWorkspaces() {
    const client = getClient();
    set({ loading: true, error: null });
    try {
      const result = await client.call<WorkspaceListResult>("workspace/list");
      const parsed = workspaceListResultSchema.parse(result);
      const active = parsed.activeWorkspaceId
        ? parsed.workspaces.find((w) => w.id === parsed.activeWorkspaceId) ?? null
        : null;
      set({
        workspaces: parsed.workspaces,
        activeWorkspaceId: parsed.activeWorkspaceId,
        activeWorkspaceName: active?.name ?? null,
        activeWorkspaceCwd: active?.path ?? null,
        loading: false,
      });
    } catch (error) {
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
    set({ loading: true, error: null });
    try {
      const result = await client.call<WorkspaceSwitchResult>("workspace/switch", { workspaceId });
      const parsed = workspaceSwitchResultSchema.parse(result);
      client.resetTransportSession("Workspace switched.");
      set({
        activeWorkspaceId: parsed.workspaceId,
        activeWorkspaceName: parsed.name,
        activeWorkspaceCwd: parsed.path,
        loading: false,
        controlSnapshot: null,
      });
      return parsed;
    } catch (error) {
      const nextError = error instanceof Error ? error : new Error(String(error));
      set({
        loading: false,
        error: nextError.message,
      });
      throw nextError;
    }
  },

  async fetchControlState() {
    const client = getClient();
    const { activeWorkspaceCwd } = get();
    if (!activeWorkspaceCwd) return;
    try {
      const result = await callParsedControlMethod(client, "cowork/session/state/read", {
        cwd: activeWorkspaceCwd,
      });
      set({
        controlSnapshot: parseWorkspaceControlSnapshot(result),
      });
    } catch {
      // Non-critical — session state is supplemental
    }
  },

  async applyWorkspaceDefaults(patch) {
    const client = getClient();
    const { activeWorkspaceCwd } = get();
    if (!activeWorkspaceCwd) {
      set({ error: "No active workspace." });
      return;
    }
    try {
      await callParsedControlMethod(client, "cowork/session/defaults/apply", {
        cwd: activeWorkspaceCwd,
        ...patch,
      });
      await get().fetchControlState();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  setActiveFromCwd(cwd: string) {
    const { workspaces } = get();
    const match = workspaces.find((w) => w.path === cwd);
    if (match) {
      set({
        activeWorkspaceId: match.id,
        activeWorkspaceName: match.name,
        activeWorkspaceCwd: match.path,
      });
    } else {
      set({ activeWorkspaceCwd: cwd });
    }
  },

  clear() {
    set({
      workspaces: [],
      activeWorkspaceId: null,
      activeWorkspaceName: null,
      activeWorkspaceCwd: null,
      controlSnapshot: null,
      loading: false,
      error: null,
    });
  },
}));
