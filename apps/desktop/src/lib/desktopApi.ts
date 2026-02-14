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
} as const;
