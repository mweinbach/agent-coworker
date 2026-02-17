import type { PersistedState, TranscriptEvent } from "../app/types";
import type { FileEntry } from "./desktopApi";

function requireDesktopApi() {
  const api = window.cowork;
  if (!api) {
    throw new Error("Desktop bridge unavailable. Start the app via Electron.");
  }
  return api;
}

export async function startWorkspaceServer(opts: {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
}): Promise<{ url: string }> {
  return await requireDesktopApi().startWorkspaceServer(opts);
}

export async function stopWorkspaceServer(opts: { workspaceId: string }): Promise<void> {
  await requireDesktopApi().stopWorkspaceServer(opts);
}

export async function loadState(): Promise<PersistedState> {
  return await requireDesktopApi().loadState();
}

export async function saveState(state: PersistedState): Promise<void> {
  await requireDesktopApi().saveState(state);
}

export async function readTranscript(opts: { threadId: string }): Promise<TranscriptEvent[]> {
  return await requireDesktopApi().readTranscript(opts);
}

export async function appendTranscriptEvent(opts: {
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
}): Promise<void> {
  await requireDesktopApi().appendTranscriptEvent(opts);
}

export async function appendTranscriptBatch(events: {
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
}[]): Promise<void> {
  await requireDesktopApi().appendTranscriptBatch(events);
}

export async function deleteTranscript(opts: { threadId: string }): Promise<void> {
  await requireDesktopApi().deleteTranscript(opts);
}

export async function pickWorkspaceDirectory(): Promise<string | null> {
  return await requireDesktopApi().pickWorkspaceDirectory();
}

export async function showContextMenu(items: { id: string; label: string; enabled?: boolean }[]): Promise<string | null> {
  return await requireDesktopApi().showContextMenu({ items });
}

export async function windowMinimize(): Promise<void> {
  await requireDesktopApi().windowMinimize();
}

export async function windowMaximize(): Promise<void> {
  await requireDesktopApi().windowMaximize();
}

export async function windowClose(): Promise<void> {
  await requireDesktopApi().windowClose();
}

export async function getPlatform(): Promise<string> {
  return await requireDesktopApi().getPlatform();
}

export async function listDirectory(path: string): Promise<FileEntry[]> {
  const api = requireDesktopApi();
  if (typeof api.listDirectory !== "function") {
    console.warn("listDirectory not implemented in desktop bridge");
    return [];
  }
  return await api.listDirectory({ path });
}
