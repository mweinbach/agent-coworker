import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";

import {
  DESKTOP_EVENT_CHANNELS,
  DESKTOP_IPC_CHANNELS,
  type ConfirmActionInput,
  type DeleteTranscriptInput,
  type DesktopMenuCommand,
  type MobileRelayBridgeState,
  type MobileRelayStartInput,
  type CopyPathInput,
  type CreateDirectoryInput,
  type DesktopApi,
  type DesktopNotificationInput,
  type ListDirectoryInput,
  type OpenExternalUrlInput,
  type OpenPathInput,
  type PreferredFileAppInput,
  type PreviewOSFileInput,
  type ReadFileForPreviewInput,
  type ReadFileInput,
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
  type UpdaterState,
  type WindowDragPointInput,
} from "../src/lib/desktopApi";
import type { PersistedState } from "../src/app/types";
import {
  confirmActionInputSchema,
  copyPathInputSchema,
  createDirectoryInputSchema,
  deleteTranscriptInputSchema,
  desktopMenuCommandSchema,
  desktopNotificationInputSchema,
  listDirectoryInputSchema,
  mobileRelayBridgeStateSchema,
  mobileRelayStartInputSchema,
  openPathInputSchema,
  preferredFileAppInputSchema,
  openExternalUrlInputSchema,
  previewOSFileInputSchema,
  readFileForPreviewInputSchema,
  readFileInputSchema,
  persistedStateInputSchema,
  readTranscriptInputSchema,
  renamePathInputSchema,
  revealPathInputSchema,
  setWindowAppearanceInputSchema,
  showContextMenuInputSchema,
  startWorkspaceServerInputSchema,
  stopWorkspaceServerInputSchema,
  systemAppearanceSchema,
  transcriptBatchInputSchema,
  trashPathInputSchema,
  updaterStateSchema,
  windowDragPointInputSchema,
} from "../src/lib/desktopSchemas";
import {
  normalizeDesktopFeatureFlagOverrides,
  resolveDesktopFeatureFlags,
  type DesktopFeatureFlagOverrides,
} from "../../../src/shared/featureFlags";

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  const detail = issue?.message ?? "is invalid";
  throw new Error(`${label} ${detail}`);
}

function assertStartWorkspaceServerInput(opts: StartWorkspaceServerInput): void {
  parseWithSchema(startWorkspaceServerInputSchema, opts, "startWorkspaceServer options");
}

function assertStopWorkspaceServerInput(opts: StopWorkspaceServerInput): void {
  parseWithSchema(stopWorkspaceServerInputSchema, opts, "stopWorkspaceServer options");
}

function assertReadTranscriptInput(opts: ReadTranscriptInput): void {
  parseWithSchema(readTranscriptInputSchema, opts, "readTranscript options");
}

function assertDeleteTranscriptInput(opts: DeleteTranscriptInput): void {
  parseWithSchema(deleteTranscriptInputSchema, opts, "deleteTranscript options");
}

function assertTranscriptBatchInput(opts: TranscriptBatchInput): void {
  parseWithSchema(transcriptBatchInputSchema, opts, "transcript event");
}

function assertShowContextMenuInput(opts: ShowContextMenuInput): void {
  parseWithSchema(showContextMenuInputSchema, opts, "showContextMenu options");
}

function assertWindowDragPointInput(opts: WindowDragPointInput): void {
  parseWithSchema(windowDragPointInputSchema, opts, "window drag options");
}

function assertListDirectoryInput(opts: ListDirectoryInput): void {
  parseWithSchema(listDirectoryInputSchema, opts, "listDirectory options");
}

function assertReadFileInput(opts: ReadFileInput): void {
  parseWithSchema(readFileInputSchema, opts, "readFile options");
}

function assertReadFileForPreviewInput(opts: ReadFileForPreviewInput): void {
  parseWithSchema(readFileForPreviewInputSchema, opts, "readFileForPreview options");
}

function assertPreviewOSFileInput(opts: PreviewOSFileInput): void {
  parseWithSchema(previewOSFileInputSchema, opts, "previewOSFile options");
}

function assertOpenPathInput(opts: OpenPathInput): void {
  parseWithSchema(openPathInputSchema, opts, "openPath options");
}

function assertPreferredFileAppInput(opts: PreferredFileAppInput): void {
  parseWithSchema(preferredFileAppInputSchema, opts, "getPreferredFileApp options");
}

function assertOpenExternalUrlInput(opts: OpenExternalUrlInput): void {
  parseWithSchema(openExternalUrlInputSchema, opts, "openExternalUrl options");
}

function assertRevealPathInput(opts: RevealPathInput): void {
  parseWithSchema(revealPathInputSchema, opts, "revealPath options");
}

function assertCopyPathInput(opts: CopyPathInput): void {
  parseWithSchema(copyPathInputSchema, opts, "copyPath options");
}

function assertCreateDirectoryInput(opts: CreateDirectoryInput): void {
  parseWithSchema(createDirectoryInputSchema, opts, "createDirectory options");
}

function assertRenamePathInput(opts: RenamePathInput): void {
  parseWithSchema(renamePathInputSchema, opts, "renamePath options");
}

function assertTrashPathInput(opts: TrashPathInput): void {
  parseWithSchema(trashPathInputSchema, opts, "trashPath options");
}

function assertPersistedState(state: PersistedState): void {
  parseWithSchema(persistedStateInputSchema, state, "state");
}

function assertConfirmActionInput(opts: ConfirmActionInput): void {
  parseWithSchema(confirmActionInputSchema, opts, "confirmAction options");
}

function assertDesktopNotificationInput(opts: DesktopNotificationInput): void {
  parseWithSchema(desktopNotificationInputSchema, opts, "showNotification options");
}

function assertSetWindowAppearanceInput(opts: SetWindowAppearanceInput): void {
  parseWithSchema(setWindowAppearanceInputSchema, opts, "setWindowAppearance options");
}

function assertUpdaterState(value: unknown): asserts value is UpdaterState {
  parseWithSchema(updaterStateSchema, value, "update state");
}

function assertDesktopMenuCommand(value: unknown): asserts value is DesktopMenuCommand {
  parseWithSchema(desktopMenuCommandSchema, value, "menu command");
}

function assertMobileRelayStartInput(opts: MobileRelayStartInput): void {
  parseWithSchema(mobileRelayStartInputSchema, opts, "mobileRelay.start options");
}

function assertMobileRelayBridgeState(value: unknown): asserts value is MobileRelayBridgeState {
  parseWithSchema(mobileRelayBridgeStateSchema, value, "mobile relay state");
}

function assertSystemAppearance(value: unknown): asserts value is SystemAppearance {
  parseWithSchema(systemAppearanceSchema, value, "system appearance");
}

function resolvePreloadDesktopFeatureFlags(overrides?: DesktopFeatureFlagOverrides) {
  return resolveDesktopFeatureFlags({
    isPackaged: process.env.COWORK_IS_PACKAGED === "true",
    env: process.env,
    ...(overrides ? { overrides } : {}),
  });
}

const desktopFeatures = Object.freeze(resolvePreloadDesktopFeatureFlags());

const desktopApi = Object.freeze<DesktopApi>({
  features: desktopFeatures,
  resolveDesktopFeatureFlags: (overrides) => resolvePreloadDesktopFeatureFlags(
    normalizeDesktopFeatureFlagOverrides(overrides),
  ),
  startWorkspaceServer: (opts: StartWorkspaceServerInput) => {
    assertStartWorkspaceServerInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.startWorkspaceServer, opts);
  },

  stopWorkspaceServer: (opts: StopWorkspaceServerInput) => {
    assertStopWorkspaceServerInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.stopWorkspaceServer, opts);
  },

  startMobileRelay: async (opts: MobileRelayStartInput) => {
    assertMobileRelayStartInput(opts);
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileRelayStart, opts);
    assertMobileRelayBridgeState(state);
    return state;
  },

  stopMobileRelay: async () => {
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileRelayStop);
    assertMobileRelayBridgeState(state);
    return state;
  },

  getMobileRelayState: async () => {
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileRelayGetState);
    assertMobileRelayBridgeState(state);
    return state;
  },

  rotateMobileRelaySession: async () => {
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileRelayRotateSession);
    assertMobileRelayBridgeState(state);
    return state;
  },

  forgetMobileRelayTrustedPhone: async () => {
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileRelayForgetTrustedPhone);
    assertMobileRelayBridgeState(state);
    return state;
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

  hydrateTranscript: (opts: ReadTranscriptInput) => {
    assertReadTranscriptInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.hydrateTranscript, opts);
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

  windowDragStart: (opts: WindowDragPointInput) => {
    assertWindowDragPointInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowDragStart, opts);
  },

  windowDragMove: (opts: WindowDragPointInput) => {
    assertWindowDragPointInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowDragMove, opts);
  },

  windowDragEnd: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowDragEnd),

  getPlatform: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getPlatform),

  listDirectory: (opts: ListDirectoryInput) => {
    assertListDirectoryInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.listDirectory, opts);
  },

  readFile: (opts: ReadFileInput) => {
    assertReadFileInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.readFile, opts);
  },

  readFileForPreview: (opts: ReadFileForPreviewInput) => {
    assertReadFileForPreviewInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.readFileForPreview, opts);
  },

  getPreferredFileApp: (opts: PreferredFileAppInput) => {
    assertPreferredFileAppInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getPreferredFileApp, opts);
  },

  previewOSFile: (opts: PreviewOSFileInput) => {
    assertPreviewOSFileInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.previewOSFile, opts);
  },

  openPath: (opts: OpenPathInput) => {
    assertOpenPathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.openPath, opts);
  },

  openExternalUrl: (opts: OpenExternalUrlInput) => {
    assertOpenExternalUrlInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.openExternalUrl, opts);
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

  getUpdateState: async () => {
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getUpdateState);
    assertUpdaterState(state);
    return state;
  },

  checkForUpdates: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.checkForUpdates),

  quitAndInstallUpdate: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.quitAndInstallUpdate),

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

  onUpdateStateChanged: (listener: (state: UpdaterState) => void) => {
    if (typeof listener !== "function") {
      throw new Error("onUpdateStateChanged listener must be a function");
    }
    const wrapped = (_event: unknown, payload: unknown) => {
      assertUpdaterState(payload);
      listener(payload);
    };
    ipcRenderer.on(DESKTOP_EVENT_CHANNELS.updateStateChanged, wrapped);
    return () => {
      ipcRenderer.off(DESKTOP_EVENT_CHANNELS.updateStateChanged, wrapped);
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

  onMobileRelayStateChanged: (listener: (state: MobileRelayBridgeState) => void) => {
    if (typeof listener !== "function") {
      throw new Error("onMobileRelayStateChanged listener must be a function");
    }
    const wrapped = (_event: unknown, payload: unknown) => {
      assertMobileRelayBridgeState(payload);
      listener(payload);
    };
    ipcRenderer.on(DESKTOP_EVENT_CHANNELS.mobileRelayStateChanged, wrapped);
    return () => {
      ipcRenderer.off(DESKTOP_EVENT_CHANNELS.mobileRelayStateChanged, wrapped);
    };
  },
});

contextBridge.exposeInMainWorld("cowork", desktopApi);
