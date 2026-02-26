import { BrowserWindow, Notification, dialog, nativeTheme } from "electron";

import {
  DESKTOP_IPC_CHANNELS,
  type ConfirmActionInput,
  type DesktopNotificationInput,
  type SetWindowAppearanceInput,
} from "../../src/lib/desktopApi";
import {
  confirmActionInputSchema,
  desktopNotificationInputSchema,
  setWindowAppearanceInputSchema,
} from "../../src/lib/desktopSchemas";
import { applyWindowAppearance, getSystemAppearanceSnapshot } from "../services/appearance";
import { buildConfirmDialog } from "../services/dialogs";
import type { DesktopIpcModuleContext } from "./types";

export function registerSystemIpc(context: DesktopIpcModuleContext): void {
  const { handleDesktopInvoke, parseWithSchema } = context;

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.confirmAction, async (event, args: ConfirmActionInput) => {
    const input = parseWithSchema(confirmActionInputSchema, args, "confirmAction options");
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const built = buildConfirmDialog(input);

    const response = ownerWindow
      ? await dialog.showMessageBox(ownerWindow, built.options)
      : await dialog.showMessageBox(built.options);
    return response.response === built.confirmButtonIndex;
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.showNotification, async (_event, args: DesktopNotificationInput) => {
    const input = parseWithSchema(desktopNotificationInputSchema, args, "showNotification options");
    if (!Notification.isSupported()) {
      return false;
    }
    const notification = new Notification({
      title: input.title.trim(),
      body: input.body?.trim(),
      silent: input.silent,
    });
    notification.show();
    return true;
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.getSystemAppearance, async () => {
    return getSystemAppearanceSnapshot();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.setWindowAppearance, async (event, args: SetWindowAppearanceInput) => {
    const input = parseWithSchema(setWindowAppearanceInputSchema, args, "setWindowAppearance options");
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!ownerWindow) {
      if (input.themeSource) {
        nativeTheme.themeSource = input.themeSource;
      }
      return getSystemAppearanceSnapshot();
    }
    return applyWindowAppearance(ownerWindow, input);
  });
}
