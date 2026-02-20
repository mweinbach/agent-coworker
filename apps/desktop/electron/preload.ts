import { contextBridge, ipcRenderer } from "electron";

import {
  DESKTOP_EVENT_CHANNELS,
  DESKTOP_IPC_CHANNELS,
  type ConfirmActionInput,
  type DeleteTranscriptInput,
  type DesktopMenuCommand,
  type CopyPathInput,
  type CreateDirectoryInput,
  type DesktopApi,
  type DesktopNotificationInput,
  type ListDirectoryInput,
  type OpenPathInput,
  type ReadTranscriptInput,
  type RenamePathInput,
  type RevealPathInput,
  type SetWindowAppearanceInput,
  type ShowContextMenuInput,
  type StartWorkspaceServerInput,
  type StopWorkspaceServerInput,
  type SystemAppearance,
  type TranscriptBatchInput,
  type TrashPathInput,
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

function assertOptionalString(value: unknown, label: string): asserts value is string | undefined {
  if (value === undefined) {
    return;
  }
  assertString(value, label);
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
  if (opts.includeHidden !== undefined && typeof opts.includeHidden !== "boolean") {
    throw new Error("includeHidden must be a boolean when provided");
  }
}

function assertOpenPathInput(opts: OpenPathInput): void {
  assertObject(opts, "openPath options");
  assertString(opts.path, "path");
}

function assertRevealPathInput(opts: RevealPathInput): void {
  assertObject(opts, "revealPath options");
  assertString(opts.path, "path");
}

function assertCopyPathInput(opts: CopyPathInput): void {
  assertObject(opts, "copyPath options");
  assertString(opts.path, "path");
}

function assertCreateDirectoryInput(opts: CreateDirectoryInput): void {
  assertObject(opts, "createDirectory options");
  assertString(opts.parentPath, "parentPath");
  assertString(opts.name, "name");
  if (opts.name.includes("/") || opts.name.includes("\\") || opts.name.includes("\0") || opts.name === ".." || opts.name === ".") {
    throw new Error("Invalid directory name");
  }
}

function assertRenamePathInput(opts: RenamePathInput): void {
  assertObject(opts, "renamePath options");
  assertString(opts.path, "path");
  assertString(opts.newName, "newName");
  if (opts.newName.includes("/") || opts.newName.includes("\\") || opts.newName.includes("\0") || opts.newName === ".." || opts.newName === ".") {
    throw new Error("Invalid new name");
  }
}

function assertTrashPathInput(opts: TrashPathInput): void {
  assertObject(opts, "trashPath options");
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

function assertConfirmActionInput(opts: ConfirmActionInput): void {
  assertObject(opts, "confirmAction options");
  assertString(opts.title, "title");
  assertString(opts.message, "message");
  assertOptionalString(opts.detail, "detail");
  assertOptionalString(opts.confirmLabel, "confirmLabel");
  assertOptionalString(opts.cancelLabel, "cancelLabel");
  if (opts.kind && !["none", "info", "warning", "error"].includes(opts.kind)) {
    throw new Error("kind must be one of: none, info, warning, error");
  }
  if (opts.defaultAction && !["confirm", "cancel"].includes(opts.defaultAction)) {
    throw new Error("defaultAction must be one of: confirm, cancel");
  }
}

function assertDesktopNotificationInput(opts: DesktopNotificationInput): void {
  assertObject(opts, "showNotification options");
  assertString(opts.title, "title");
  assertOptionalString(opts.body, "body");
  if (opts.silent !== undefined && typeof opts.silent !== "boolean") {
    throw new Error("silent must be a boolean when provided");
  }
}

function assertSetWindowAppearanceInput(opts: SetWindowAppearanceInput): void {
  assertObject(opts, "setWindowAppearance options");
  if (opts.themeSource && !["system", "light", "dark"].includes(opts.themeSource)) {
    throw new Error("themeSource must be one of: system, light, dark");
  }
  if (opts.backgroundMaterial && !["auto", "none", "mica", "acrylic", "tabbed"].includes(opts.backgroundMaterial)) {
    throw new Error("backgroundMaterial must be one of: auto, none, mica, acrylic, tabbed");
  }
}

function assertDesktopMenuCommand(value: unknown): asserts value is DesktopMenuCommand {
  if (!["newThread", "toggleSidebar", "openSettings", "openWorkspacesSettings", "openSkills"].includes(String(value))) {
    throw new Error("Invalid menu command");
  }
}

function assertSystemAppearance(value: unknown): asserts value is SystemAppearance {
  assertObject(value, "system appearance");
  if (!["darwin", "linux", "win32", "aix", "freebsd", "openbsd", "sunos", "android"].includes(String(value.platform))) {
    throw new Error("system appearance platform is invalid");
  }
  if (!["system", "light", "dark"].includes(String(value.themeSource))) {
    throw new Error("system appearance themeSource is invalid");
  }
  if (typeof value.shouldUseDarkColors !== "boolean") {
    throw new Error("system appearance shouldUseDarkColors must be a boolean");
  }
  if (typeof value.shouldUseHighContrastColors !== "boolean") {
    throw new Error("system appearance shouldUseHighContrastColors must be a boolean");
  }
  if (typeof value.shouldUseInvertedColorScheme !== "boolean") {
    throw new Error("system appearance shouldUseInvertedColorScheme must be a boolean");
  }
  if (typeof value.prefersReducedTransparency !== "boolean") {
    throw new Error("system appearance prefersReducedTransparency must be a boolean");
  }
  if (typeof value.inForcedColorsMode !== "boolean") {
    throw new Error("system appearance inForcedColorsMode must be a boolean");
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

  openPath: (opts: OpenPathInput) => {
    assertOpenPathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.openPath, opts);
  },

  revealPath: (opts: RevealPathInput) => {
    assertRevealPathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.revealPath, opts);
  },

  copyPath: (opts: CopyPathInput) => {
    assertCopyPathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.copyPath, opts);
  },

  createDirectory: (opts: CreateDirectoryInput) => {
    assertCreateDirectoryInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.createDirectory, opts);
  },

  renamePath: (opts: RenamePathInput) => {
    assertRenamePathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.renamePath, opts);
  },

  trashPath: (opts: TrashPathInput) => {
    assertTrashPathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.trashPath, opts);
  },

  confirmAction: (opts: ConfirmActionInput) => {
    assertConfirmActionInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.confirmAction, opts);
  },

  showNotification: (opts: DesktopNotificationInput) => {
    assertDesktopNotificationInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.showNotification, opts);
  },

  getSystemAppearance: async () => {
    const appearance = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getSystemAppearance);
    assertSystemAppearance(appearance);
    return appearance;
  },

  setWindowAppearance: async (opts: SetWindowAppearanceInput) => {
    assertSetWindowAppearanceInput(opts);
    const appearance = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setWindowAppearance, opts);
    assertSystemAppearance(appearance);
    return appearance;
  },

  onSystemAppearanceChanged: (listener: (appearance: SystemAppearance) => void) => {
    if (typeof listener !== "function") {
      throw new Error("onSystemAppearanceChanged listener must be a function");
    }
    const wrapped = (_event: unknown, payload: unknown) => {
      assertSystemAppearance(payload);
      listener(payload);
    };
    ipcRenderer.on(DESKTOP_EVENT_CHANNELS.systemAppearanceChanged, wrapped);
    return () => {
      ipcRenderer.off(DESKTOP_EVENT_CHANNELS.systemAppearanceChanged, wrapped);
    };
  },

  onMenuCommand: (listener: (command: DesktopMenuCommand) => void) => {
    if (typeof listener !== "function") {
      throw new Error("onMenuCommand listener must be a function");
    }
    const wrapped = (_event: unknown, payload: unknown) => {
      assertDesktopMenuCommand(payload);
      listener(payload);
    };
    ipcRenderer.on(DESKTOP_EVENT_CHANNELS.menuCommand, wrapped);
    return () => {
      ipcRenderer.off(DESKTOP_EVENT_CHANNELS.menuCommand, wrapped);
    };
  },
});

contextBridge.exposeInMainWorld("cowork", desktopApi);
