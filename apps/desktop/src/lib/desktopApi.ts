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
  includeHidden?: boolean;
};

export type OpenPathInput = {
  path: string;
};

export type PreviewOSFileInput = {
  path: string;
};

export type RevealPathInput = {
  path: string;
};

export type ReadFileInput = {
  path: string;
};

export type ReadFileOutput = {
  content: string;
};

export type CopyPathInput = {
  path: string;
};

export type CreateDirectoryInput = {
  parentPath: string;
  name: string;
};

export type RenamePathInput = {
  path: string;
  newName: string;
};

export type TrashPathInput = {
  path: string;
};

export type ExplorerEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isHidden: boolean;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
};

export type DesktopMenuCommand =
  | "newThread"
  | "toggleSidebar"
  | "openSettings"
  | "openWorkspacesSettings"
  | "openSkills";

export type ThemeSource = "system" | "light" | "dark";

export type WindowsBackgroundMaterial = "auto" | "none" | "mica" | "acrylic" | "tabbed";

export type SystemAppearance = {
  platform: string;
  themeSource: ThemeSource;
  shouldUseDarkColors: boolean;
  shouldUseHighContrastColors: boolean;
  shouldUseInvertedColorScheme: boolean;
  prefersReducedTransparency: boolean;
  inForcedColorsMode: boolean;
};

export type ConfirmActionInput = {
  title: string;
  message: string;
  detail?: string;
  kind?: "none" | "info" | "warning" | "error";
  confirmLabel?: string;
  cancelLabel?: string;
  defaultAction?: "confirm" | "cancel";
};

export type DesktopNotificationInput = {
  title: string;
  body?: string;
  silent?: boolean;
};

export type SetWindowAppearanceInput = {
  themeSource?: ThemeSource;
  backgroundMaterial?: WindowsBackgroundMaterial;
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
  listDirectory(opts: ListDirectoryInput): Promise<ExplorerEntry[]>;
  readFile(opts: ReadFileInput): Promise<ReadFileOutput>;
  previewOSFile(opts: PreviewOSFileInput): Promise<void>;
  openPath(opts: OpenPathInput): Promise<void>;
  revealPath(opts: RevealPathInput): Promise<void>;
  copyPath(opts: CopyPathInput): Promise<void>;
  createDirectory(opts: CreateDirectoryInput): Promise<void>;
  renamePath(opts: RenamePathInput): Promise<void>;
  trashPath(opts: TrashPathInput): Promise<void>;
  confirmAction(opts: ConfirmActionInput): Promise<boolean>;
  showNotification(opts: DesktopNotificationInput): Promise<boolean>;
  getSystemAppearance(): Promise<SystemAppearance>;
  setWindowAppearance(opts: SetWindowAppearanceInput): Promise<SystemAppearance>;
  onSystemAppearanceChanged(listener: (appearance: SystemAppearance) => void): () => void;
  onMenuCommand(listener: (command: DesktopMenuCommand) => void): () => void;
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
  readFile: "desktop:readFile",
  previewOSFile: "desktop:previewOSFile",
  openPath: "desktop:openPath",
  revealPath: "desktop:revealPath",
  copyPath: "desktop:copyPath",
  createDirectory: "desktop:createDirectory",
  renamePath: "desktop:renamePath",
  trashPath: "desktop:trashPath",
  confirmAction: "desktop:confirmAction",
  showNotification: "desktop:showNotification",
  getSystemAppearance: "desktop:getSystemAppearance",
  setWindowAppearance: "desktop:setWindowAppearance",
} as const;

export const DESKTOP_EVENT_CHANNELS = {
  menuCommand: "desktop:event:menuCommand",
  systemAppearanceChanged: "desktop:event:systemAppearanceChanged",
} as const;
