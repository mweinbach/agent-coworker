import type { PersistedState, TranscriptEvent } from "../app/types";

export type StartWorkspaceServerInput = {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
};

export type StopWorkspaceServerInput = {
  workspaceId: string;
};

export type ReadTranscriptInput = {
  threadId: string;
};

export type DeleteTranscriptInput = {
  threadId: string;
};

export type TranscriptBatchInput = {
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
};

export type ContextMenuItem = {
  id: string;
  label: string;
  enabled?: boolean;
};

export type ShowContextMenuInput = {
  items: ContextMenuItem[];
};

export type ListDirectoryInput = {
  path: string;
};

export type FileEntry = {
  name: string;
  isDirectory: boolean;
};

export interface DesktopApi {
  startWorkspaceServer(opts: StartWorkspaceServerInput): Promise<{ url: string }>;
  stopWorkspaceServer(opts: StopWorkspaceServerInput): Promise<void>;
  loadState(): Promise<PersistedState>;
  saveState(state: PersistedState): Promise<void>;
  readTranscript(opts: ReadTranscriptInput): Promise<TranscriptEvent[]>;
  appendTranscriptEvent(opts: TranscriptBatchInput): Promise<void>;
  appendTranscriptBatch(events: TranscriptBatchInput[]): Promise<void>;
  deleteTranscript(opts: DeleteTranscriptInput): Promise<void>;
  pickWorkspaceDirectory(): Promise<string | null>;
  showContextMenu(opts: ShowContextMenuInput): Promise<string | null>;
  windowMinimize(): Promise<void>;
  windowMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  getPlatform(): Promise<string>;
  listDirectory(opts: ListDirectoryInput): Promise<FileEntry[]>;
}

export const DESKTOP_IPC_CHANNELS = {
  startWorkspaceServer: "desktop:startWorkspaceServer",
  stopWorkspaceServer: "desktop:stopWorkspaceServer",
  loadState: "desktop:loadState",
  saveState: "desktop:saveState",
  readTranscript: "desktop:readTranscript",
  appendTranscriptEvent: "desktop:appendTranscriptEvent",
  appendTranscriptBatch: "desktop:appendTranscriptBatch",
  deleteTranscript: "desktop:deleteTranscript",
  pickWorkspaceDirectory: "desktop:pickWorkspaceDirectory",
  showContextMenu: "desktop:showContextMenu",
  windowMinimize: "desktop:windowMinimize",
  windowMaximize: "desktop:windowMaximize",
  windowClose: "desktop:windowClose",
  getPlatform: "desktop:getPlatform",
  listDirectory: "desktop:listDirectory",
} as const;
