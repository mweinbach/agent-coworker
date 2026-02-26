import { BrowserWindow, Menu } from "electron";

import { DESKTOP_IPC_CHANNELS, type ShowContextMenuInput } from "../../src/lib/desktopApi";
import { showContextMenuInputSchema } from "../../src/lib/desktopSchemas";
import type { DesktopIpcModuleContext } from "./types";

export function registerWindowIpc(context: DesktopIpcModuleContext): void {
  const { handleDesktopInvoke, parseWithSchema } = context;

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.showContextMenu, async (event, args: ShowContextMenuInput) => {
    const input = parseWithSchema(showContextMenuInputSchema, args, "showContextMenu options");
    return new Promise<string | null>((resolve) => {
      const menu = Menu.buildFromTemplate(
        input.items.map((item) => ({
          id: item.id,
          label: item.label,
          enabled: item.enabled !== false,
          click: () => resolve(item.id),
        }))
      );

      const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
      if (!ownerWindow) {
        resolve(null);
        return;
      }

      menu.popup({ window: ownerWindow, callback: () => resolve(null) });
    });
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.windowMinimize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.windowMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.windowClose, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.getPlatform, () => {
    return process.platform;
  });
}
