import { create } from "zustand";

import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useWorkspaceStore } from "./workspaceStore";
import type { McpServerEntry } from "./protocolTypes";

type McpStoreState = {
  servers: McpServerEntry[];
  validationByName: Record<string, { valid: boolean; error?: string }>;
  loading: boolean;
  error: string | null;

  fetchServers(): Promise<void>;
  validateServer(name: string): Promise<void>;
  deleteServer(name: string): Promise<void>;
  clear(): void;
};

function getClientAndCwd() {
  const client = getActiveCoworkJsonRpcClient();
  if (!client) throw new Error("No active JSON-RPC client.");
  const cwd = useWorkspaceStore.getState().activeWorkspaceCwd;
  if (!cwd) throw new Error("No active workspace.");
  return { client, cwd };
}

export const useMcpStore = create<McpStoreState>((set, get) => ({
  servers: [],
  validationByName: {},
  loading: false,
  error: null,

  async fetchServers() {
    const { client, cwd } = getClientAndCwd();
    set({ loading: true, error: null });
    try {
      const result = await client.call<{ event: { servers: McpServerEntry[] } }>(
        "cowork/mcp/servers/read",
        { cwd },
      );
      set({ servers: result?.event?.servers ?? [], loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async validateServer(name: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await client.call<{ valid: boolean; error?: string }>(
        "cowork/mcp/server/validate",
        { cwd, name },
      );
      set({
        validationByName: {
          ...get().validationByName,
          [name]: { valid: result?.valid ?? false, error: result?.error },
        },
      });
    } catch (error) {
      set({
        validationByName: {
          ...get().validationByName,
          [name]: { valid: false, error: error instanceof Error ? error.message : String(error) },
        },
      });
    }
  },

  async deleteServer(name: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      await client.call("cowork/mcp/server/delete", { cwd, name });
      await get().fetchServers();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  clear() {
    set({ servers: [], validationByName: {}, loading: false, error: null });
  },
}));
