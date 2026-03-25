import { create } from "zustand";

import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useWorkspaceStore } from "./workspaceStore";
import type { BackupEntry } from "./protocolTypes";

type BackupStoreState = {
  backups: BackupEntry[];
  loading: boolean;
  error: string | null;

  fetchBackups(): Promise<void>;
  createCheckpoint(targetSessionId: string): Promise<void>;
  restoreBackup(targetSessionId: string, checkpointId?: string): Promise<void>;
  deleteCheckpoint(targetSessionId: string, checkpointId: string): Promise<void>;
  clear(): void;
};

function getClientAndCwd() {
  const client = getActiveCoworkJsonRpcClient();
  if (!client) throw new Error("No active JSON-RPC client.");
  const cwd = useWorkspaceStore.getState().activeWorkspaceCwd;
  if (!cwd) throw new Error("No active workspace.");
  return { client, cwd };
}

export const useBackupStore = create<BackupStoreState>((set, get) => ({
  backups: [],
  loading: false,
  error: null,

  async fetchBackups() {
    const { client, cwd } = getClientAndCwd();
    set({ loading: true, error: null });
    try {
      const result = await client.call<{ event: { backups: BackupEntry[] } }>(
        "cowork/backups/list",
        { cwd },
      );
      set({ backups: result?.event?.backups ?? [], loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async createCheckpoint(targetSessionId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      await client.call("cowork/backups/checkpoint/create", { cwd, targetSessionId });
      await get().fetchBackups();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async restoreBackup(targetSessionId: string, checkpointId?: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      await client.call("cowork/backups/restore", { cwd, targetSessionId, checkpointId });
      await get().fetchBackups();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async deleteCheckpoint(targetSessionId: string, checkpointId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      await client.call("cowork/backups/checkpoint/delete", { cwd, targetSessionId, checkpointId });
      await get().fetchBackups();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  clear() {
    set({ backups: [], loading: false, error: null });
  },
}));
