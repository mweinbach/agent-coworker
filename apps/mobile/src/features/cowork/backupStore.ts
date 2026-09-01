import { create } from "zustand";

import type {
  JsonRpcControlResult,
  WorkspaceBackupEntry,
} from "@/cowork-shared/jsonrpcControlSchemas";
import { callParsedControlMethod, isStaleWorkspaceRequestError } from "./controlRpc";
import { saveToOfflineCache } from "./offlineCacheStorage";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useWorkspaceStore } from "./workspaceStore";

type WorkspaceBackupDelta = JsonRpcControlResult<"cowork/backups/workspace/delta/read">["event"];

type BackupStoreState = {
  backups: WorkspaceBackupEntry[];
  workspacePath: string | null;
  deltasByCheckpointKey: Record<string, WorkspaceBackupDelta>;
  loading: boolean;
  error: string | null;

  fetchBackups(): Promise<void>;
  createCheckpoint(targetSessionId: string): Promise<void>;
  fetchDelta(targetSessionId: string, checkpointId: string): Promise<void>;
  restoreBackup(targetSessionId: string, checkpointId?: string): Promise<void>;
  deleteCheckpoint(targetSessionId: string, checkpointId: string): Promise<void>;
  deleteEntry(targetSessionId: string): Promise<void>;
  clear(): void;
};

function getClientAndCwd() {
  const client = getActiveCoworkJsonRpcClient();
  if (!client) throw new Error("No active JSON-RPC client.");
  const cwd = useWorkspaceStore.getState().activeWorkspaceCwd;
  if (!cwd) throw new Error("No active workspace.");
  return { client, cwd };
}

function applyBackupsEvent(event: JsonRpcControlResult<"cowork/backups/workspace/read">["event"]) {
  void saveToOfflineCache("backups", event.backups);
  void saveToOfflineCache("workspacePath", event.workspacePath);
  return { backups: event.backups, workspacePath: event.workspacePath };
}

export const useBackupStore = create<BackupStoreState>((set, get) => ({
  backups: [],
  workspacePath: null,
  deltasByCheckpointKey: {},
  loading: false,
  error: null,

  async fetchBackups() {
    set({ loading: true, error: null });
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/backups/workspace/read", {
        cwd,
      });
      set({
        ...applyBackupsEvent(result.event),
        loading: false,
      });
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async createCheckpoint(targetSessionId: string) {
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/backups/workspace/checkpoint", {
        cwd,
        targetSessionId,
      });
      set({
        ...applyBackupsEvent(result.event),
      });
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async fetchDelta(targetSessionId: string, checkpointId: string) {
    const checkpointKey = `${targetSessionId}:${checkpointId}`;
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/backups/workspace/delta/read", {
        cwd,
        targetSessionId,
        checkpointId,
      });
      set({
        deltasByCheckpointKey: {
          ...get().deltasByCheckpointKey,
          [checkpointKey]: result.event,
        },
      });
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async restoreBackup(targetSessionId: string, checkpointId?: string) {
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/backups/workspace/restore", {
        cwd,
        targetSessionId,
        ...(checkpointId ? { checkpointId } : {}),
      });
      set({
        ...applyBackupsEvent(result.event),
      });
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async deleteCheckpoint(targetSessionId: string, checkpointId: string) {
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(
        client,
        "cowork/backups/workspace/deleteCheckpoint",
        {
          cwd,
          targetSessionId,
          checkpointId,
        },
      );
      const nextDeltas = { ...get().deltasByCheckpointKey };
      delete nextDeltas[`${targetSessionId}:${checkpointId}`];
      set({
        ...applyBackupsEvent(result.event),
        deltasByCheckpointKey: nextDeltas,
      });
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async deleteEntry(targetSessionId: string) {
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/backups/workspace/deleteEntry", {
        cwd,
        targetSessionId,
      });
      const nextDeltas = Object.fromEntries(
        Object.entries(get().deltasByCheckpointKey).filter(
          ([key]) => !key.startsWith(`${targetSessionId}:`),
        ),
      );
      set({
        ...applyBackupsEvent(result.event),
        deltasByCheckpointKey: nextDeltas,
      });
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  clear() {
    set({
      backups: [],
      workspacePath: null,
      deltasByCheckpointKey: {},
      loading: false,
      error: null,
    });
  },
}));
