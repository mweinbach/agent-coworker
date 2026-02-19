import { contextBridge, ipcRenderer } from "electron";

import {
  DESKTOP_IPC_CHANNELS,
  type DeleteTranscriptInput,
  type DesktopApi,
  type ListDirectoryInput,
  type ReadTranscriptInput,
  type ShowContextMenuInput,
  type StartWorkspaceServerInput,
  type StopWorkspaceServerInput,
  type TranscriptBatchInput,
} from "../src/lib/desktopApi";
import type { PersistedState } from "../src/app/types";

const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} contains invalid characters`);
  }
}

function assertDirection(value: unknown, label: string): asserts value is "server" | "client" {
  if (value !== "server" && value !== "client") {
    throw new Error(`${label} must be 'server' or 'client'`);
  }
}

function assertStartWorkspaceServerInput(opts: StartWorkspaceServerInput): void {
  assertObject(opts, "startWorkspaceServer options");
  assertSafeId(opts.workspaceId, "workspaceId");
  assertString(opts.workspacePath, "workspacePath");
  if (typeof opts.yolo !== "boolean") {
    throw new Error("yolo must be a boolean");
  }
}

function assertStopWorkspaceServerInput(opts: StopWorkspaceServerInput): void {
  assertObject(opts, "stopWorkspaceServer options");
  assertSafeId(opts.workspaceId, "workspaceId");
}

function assertReadTranscriptInput(opts: ReadTranscriptInput): void {
  assertObject(opts, "readTranscript options");
  assertSafeId(opts.threadId, "threadId");
}

function assertDeleteTranscriptInput(opts: DeleteTranscriptInput): void {
  assertObject(opts, "deleteTranscript options");
  assertSafeId(opts.threadId, "threadId");
}

function assertTranscriptBatchInput(opts: TranscriptBatchInput): void {
  assertObject(opts, "transcript event");
  assertString(opts.ts, "ts");
  assertSafeId(opts.threadId, "threadId");
  assertDirection(opts.direction, "direction");
}

function assertShowContextMenuInput(opts: ShowContextMenuInput): void {
  assertObject(opts, "showContextMenu options");
  if (!Array.isArray(opts.items)) {
    throw new Error("items must be an array");
  }

  for (const item of opts.items) {
    assertObject(item, "context menu item");
    assertSafeId(item.id, "context menu item id");
    assertString(item.label, "context menu item label");
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
      throw new Error("context menu item enabled must be a boolean when provided");
    }
  }
}

function assertListDirectoryInput(opts: ListDirectoryInput): void {
  assertObject(opts, "listDirectory options");
  assertString(opts.path, "path");
}

function assertPersistedState(state: PersistedState): void {
  assertObject(state, "state");
  if (!Array.isArray(state.workspaces)) {
    throw new Error("state.workspaces must be an array");
  }
  if (!Array.isArray(state.threads)) {
    throw new Error("state.threads must be an array");
  }
  if (state.developerMode !== undefined && typeof state.developerMode !== "boolean") {
    throw new Error("state.developerMode must be a boolean when provided");
  }
}

const desktopApi = Object.freeze<DesktopApi>({
  startWorkspaceServer: (opts: StartWorkspaceServerInput) => {
    assertStartWorkspaceServerInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.startWorkspaceServer, opts);
  },

  stopWorkspaceServer: (opts: StopWorkspaceServerInput) => {
    assertStopWorkspaceServerInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.stopWorkspaceServer, opts);
  },

  loadState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.loadState),

  saveState: (state: PersistedState) => {
    assertPersistedState(state);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.saveState, state);
  },

  readTranscript: (opts: ReadTranscriptInput) => {
    assertReadTranscriptInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.readTranscript, opts);
  },

  appendTranscriptEvent: (opts: TranscriptBatchInput) => {
    assertTranscriptBatchInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appendTranscriptEvent, opts);
  },

  appendTranscriptBatch: (events: TranscriptBatchInput[]) => {
    events.forEach(assertTranscriptBatchInput);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appendTranscriptBatch, events);
  },

  deleteTranscript: (opts: DeleteTranscriptInput) => {
    assertDeleteTranscriptInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.deleteTranscript, opts);
  },

  pickWorkspaceDirectory: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.pickWorkspaceDirectory),

  showContextMenu: (opts: ShowContextMenuInput) => {
    assertShowContextMenuInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.showContextMenu, opts);
  },

  windowMinimize: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowMinimize),

  windowMaximize: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowMaximize),

  windowClose: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowClose),

  getPlatform: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getPlatform),

  listDirectory: (opts: ListDirectoryInput) => {
    assertListDirectoryInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.listDirectory, opts);
  },
});

contextBridge.exposeInMainWorld("cowork", desktopApi);
