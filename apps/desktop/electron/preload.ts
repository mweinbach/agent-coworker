import { contextBridge, ipcRenderer } from "electron";

import { DESKTOP_IPC_CHANNELS, type DesktopApi, type DeleteTranscriptInput, type ReadTranscriptInput, type StartWorkspaceServerInput, type StopWorkspaceServerInput, type TranscriptBatchInput } from "../src/lib/desktopApi";
import type { PersistedState } from "../src/app/types";

const desktopApi: DesktopApi = {
  startWorkspaceServer: (opts: StartWorkspaceServerInput) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.startWorkspaceServer, opts),

  stopWorkspaceServer: (opts: StopWorkspaceServerInput) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.stopWorkspaceServer, opts),

  loadState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.loadState),

  saveState: (state: PersistedState) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.saveState, state),

  readTranscript: (opts: ReadTranscriptInput) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.readTranscript, opts),

  appendTranscriptEvent: (opts: TranscriptBatchInput) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appendTranscriptEvent, opts),

  appendTranscriptBatch: (events: TranscriptBatchInput[]) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appendTranscriptBatch, events),

  deleteTranscript: (opts: DeleteTranscriptInput) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.deleteTranscript, opts),

  pickWorkspaceDirectory: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.pickWorkspaceDirectory),
};

contextBridge.exposeInMainWorld("cowork", desktopApi);
