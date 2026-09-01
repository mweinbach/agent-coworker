import { create } from "zustand";

import type { MemoryEntry } from "@/cowork-shared/jsonrpcControlSchemas";
import { callParsedControlMethod, isStaleWorkspaceRequestError } from "./controlRpc";
import { saveToOfflineCache } from "./offlineCacheStorage";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useWorkspaceStore } from "./workspaceStore";

type MemoryStoreState = {
  entries: MemoryEntry[];
  loading: boolean;
  error: string | null;
  filterScope: "all" | "workspace" | "user";

  fetchMemories(): Promise<void>;
  upsertMemory(
    scope: "workspace" | "user",
    id: string | undefined,
    content: string,
  ): Promise<boolean>;
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

export const useMemoryStore = create<MemoryStoreState>((set, _get) => ({
  entries: [],
  loading: false,
  error: null,
  filterScope: "all",

  async fetchMemories() {
    set({ loading: true, error: null });
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/memory/list", { cwd });
      set({
        entries: result.event.memories,
        loading: false,
      });
      void saveToOfflineCache("memories", result.event.memories);
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async upsertMemory(scope: "workspace" | "user", id: string | undefined, content: string) {
    set({ error: null });
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/memory/upsert", {
        cwd,
        scope,
        id: id?.trim() ? id.trim() : "hot",
        content,
      });
      set({ entries: result.event.memories });
      void saveToOfflineCache("memories", result.event.memories);
      return true;
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return false;
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  async deleteMemory(scope: "workspace" | "user", id: string) {
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/memory/delete", {
        cwd,
        scope,
        id,
      });
      set({ entries: result.event.memories });
      void saveToOfflineCache("memories", result.event.memories);
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
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
