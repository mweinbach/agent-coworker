import { create } from "zustand";

import type {
  JsonRpcControlResult,
  WorkspaceBackupEntry,
} from "../../../../../src/shared/jsonrpcControlSchemas";
import { callParsedControlMethod } from "./controlRpc";
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

export const useBackupStore = create<BackupStoreState>((set, get) => ({
  backups: [],
  workspacePath: null,
  deltasByCheckpointKey: {},
  loading: false,
  error: null,

  async fetchBackups() {
    const { client, cwd } = getClientAndCwd();
    set({ loading: true, error: null });
    try {
      const result = await callParsedControlMethod(client, "cowork/backups/workspace/read", { cwd });
      set({
        backups: result.event.backups,
        workspacePath: result.event.workspacePath,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async createCheckpoint(targetSessionId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/backups/workspace/checkpoint", {
        cwd,
        targetSessionId,
      });
      set({
        backups: result.event.backups,
        workspacePath: result.event.workspacePath,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async fetchDelta(targetSessionId: string, checkpointId: string) {
    const { client, cwd } = getClientAndCwd();
    const checkpointKey = `${targetSessionId}:${checkpointId}`;
    try {
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
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async restoreBackup(targetSessionId: string, checkpointId?: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/backups/workspace/restore", {
        cwd,
        targetSessionId,
        ...(checkpointId ? { checkpointId } : {}),
      });
      set({
        backups: result.event.backups,
        workspacePath: result.event.workspacePath,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async deleteCheckpoint(targetSessionId: string, checkpointId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/backups/workspace/deleteCheckpoint", {
        cwd,
        targetSessionId,
        checkpointId,
      });
      const nextDeltas = { ...get().deltasByCheckpointKey };
      delete nextDeltas[`${targetSessionId}:${checkpointId}`];
      set({
        backups: result.event.backups,
        workspacePath: result.event.workspacePath,
        deltasByCheckpointKey: nextDeltas,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async deleteEntry(targetSessionId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/backups/workspace/deleteEntry", {
        cwd,
        targetSessionId,
      });
      const nextDeltas = Object.fromEntries(
        Object.entries(get().deltasByCheckpointKey).filter(([key]) => !key.startsWith(`${targetSessionId}:`)),
      );
      set({
        backups: result.event.backups,
        workspacePath: result.event.workspacePath,
        deltasByCheckpointKey: nextDeltas,
      });
    } catch (error) {
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
