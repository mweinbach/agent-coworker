import { create } from "zustand";

import type { CoworkJsonRpcClient } from "./jsonRpcClient";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import type { WorkspaceSummary, WorkspaceListResult, WorkspaceSwitchResult } from "./protocolTypes";
import { workspaceListResultSchema, workspaceSwitchResultSchema } from "./protocolTypes";

type WorkspaceSessionState = {
  provider: string | null;
  model: string | null;
  effectiveModel: string | null;
  reasoningEffort: string | null;
};

type WorkspaceStoreState = {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  activeWorkspaceName: string | null;
  activeWorkspaceCwd: string | null;
  sessionState: WorkspaceSessionState | null;
  loading: boolean;
  error: string | null;

  fetchWorkspaces(): Promise<void>;
  switchWorkspace(workspaceId: string): Promise<void>;
  fetchSessionState(): Promise<void>;
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
  sessionState: null,
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
      set({ error: `Workspace ${workspaceId} not found.` });
      return;
    }
    set({ loading: true, error: null });
    try {
      const result = await client.call<WorkspaceSwitchResult>("workspace/switch", { workspaceId });
      const parsed = workspaceSwitchResultSchema.parse(result);
      set({
        activeWorkspaceId: parsed.workspaceId,
        activeWorkspaceName: parsed.name,
        activeWorkspaceCwd: parsed.path,
        loading: false,
        sessionState: null,
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async fetchSessionState() {
    const client = getClient();
    const { activeWorkspaceCwd } = get();
    if (!activeWorkspaceCwd) return;
    try {
      const result = await client.call<Record<string, unknown>>("cowork/session/state/read", {
        cwd: activeWorkspaceCwd,
      });
      const events = Array.isArray(result?.events) ? result.events as Record<string, unknown>[] : [];
      let provider: string | null = null;
      let model: string | null = null;
      let effectiveModel: string | null = null;
      let reasoningEffort: string | null = null;
      for (const event of events) {
        if (typeof event.provider === "string") provider = event.provider;
        if (typeof event.model === "string") model = event.model;
        if (typeof event.effectiveModel === "string") effectiveModel = event.effectiveModel;
        if (typeof event.effectiveReasoningEffort === "string") reasoningEffort = event.effectiveReasoningEffort;
      }
      set({
        sessionState: { provider, model, effectiveModel, reasoningEffort },
      });
    } catch {
      // Non-critical — session state is supplemental
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
      sessionState: null,
      loading: false,
      error: null,
    });
  },
}));
