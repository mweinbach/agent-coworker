import type { PersistedState, TranscriptEvent } from "../app/types";
import type {
  ConfirmActionInput,
  DesktopMenuCommand,
  DesktopNotificationInput,
  FileEntry,
  SetWindowAppearanceInput,
  SystemAppearance,
} from "./desktopApi";

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
  if (typeof window === "undefined") {
    return [];
  }
  const api = window.cowork;
  if (!api || typeof api.listDirectory !== "function") {
    console.warn("listDirectory not implemented in desktop bridge");
    return [];
  }
  return await api.listDirectory({ path });
}

export async function confirmAction(opts: ConfirmActionInput): Promise<boolean> {
  return await requireDesktopApi().confirmAction(opts);
}

export async function showNotification(opts: DesktopNotificationInput): Promise<boolean> {
  return await requireDesktopApi().showNotification(opts);
}

export async function getSystemAppearance(): Promise<SystemAppearance> {
  return await requireDesktopApi().getSystemAppearance();
}

export async function setWindowAppearance(opts: SetWindowAppearanceInput): Promise<SystemAppearance> {
  return await requireDesktopApi().setWindowAppearance(opts);
}

export function onSystemAppearanceChanged(listener: (appearance: SystemAppearance) => void): () => void {
  return requireDesktopApi().onSystemAppearanceChanged(listener);
}

export function onMenuCommand(listener: (command: DesktopMenuCommand) => void): () => void {
  return requireDesktopApi().onMenuCommand(listener);
}
