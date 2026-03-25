import { create } from "zustand";

import type { MemoryEntry } from "../../../../../src/shared/jsonrpcControlSchemas";
import { callParsedControlMethod } from "./controlRpc";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useWorkspaceStore } from "./workspaceStore";

type MemoryStoreState = {
  entries: MemoryEntry[];
  loading: boolean;
  error: string | null;
  filterScope: "all" | "workspace" | "user";

  fetchMemories(): Promise<void>;
  upsertMemory(scope: "workspace" | "user", id: string | undefined, content: string): Promise<void>;
  deleteMemory(scope: "workspace" | "user", id: string): Promise<void>;
  setFilterScope(scope: "all" | "workspace" | "user"): void;
  clear(): void;
};

function getClientAndCwd() {
  const client = getActiveCoworkJsonRpcClient();
  if (!client) throw new Error("No active JSON-RPC client.");
  const cwd = useWorkspaceStore.getState().activeWorkspaceCwd;
  if (!cwd) throw new Error("No active workspace.");
  return { client, cwd };
}

export const useMemoryStore = create<MemoryStoreState>((set, get) => ({
  entries: [],
  loading: false,
  error: null,
  filterScope: "all",

  async fetchMemories() {
    const { client, cwd } = getClientAndCwd();
    set({ loading: true, error: null });
    try {
      const result = await callParsedControlMethod(client, "cowork/memory/list", { cwd });
      set({
        entries: result.event.memories,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async upsertMemory(scope: "workspace" | "user", id: string | undefined, content: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/memory/upsert", {
        cwd,
        scope,
        id: id?.trim() ? id.trim() : "hot",
        content,
      });
      set({ entries: result.event.memories });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async deleteMemory(scope: "workspace" | "user", id: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/memory/delete", { cwd, scope, id });
      set({ entries: result.event.memories });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  setFilterScope(scope) {
    set({ filterScope: scope });
  },

  clear() {
    set({ entries: [], loading: false, error: null, filterScope: "all" });
  },
}));
