import { BrowserWindow, Menu, type WebContents } from "electron";

import { DESKTOP_IPC_CHANNELS, type ShowContextMenuInput, type WindowDragPointInput } from "../../src/lib/desktopApi";
import { showContextMenuInputSchema, windowDragPointInputSchema } from "../../src/lib/desktopSchemas";
import type { DesktopIpcModuleContext } from "./types";

type ActiveWindowDrag = {
  startScreenX: number;
  startScreenY: number;
  startWindowX: number;
  startWindowY: number;
};

export function registerWindowIpc(context: DesktopIpcModuleContext): void {
  const { handleDesktopInvoke, parseWithSchema } = context;
  const activeWindowDrags = new Map<number, ActiveWindowDrag>();
  const trackedWindowDragSenders = new Set<number>();

  const ensureWindowDragCleanup = (sender: WebContents) => {
    if (trackedWindowDragSenders.has(sender.id)) {
      return;
    }
    trackedWindowDragSenders.add(sender.id);
    sender.once("destroyed", () => {
      activeWindowDrags.delete(sender.id);
      trackedWindowDragSenders.delete(sender.id);
    });
  };

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

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.windowDragStart, (event, args: WindowDragPointInput) => {
    const input = parseWithSchema(windowDragPointInputSchema, args, "window drag options");
    ensureWindowDragCleanup(event.sender);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) {
      activeWindowDrags.delete(event.sender.id);
      return;
    }
    const { x, y } = win.getBounds();
    activeWindowDrags.set(event.sender.id, {
      startScreenX: input.screenX,
      startScreenY: input.screenY,
      startWindowX: x,
      startWindowY: y,
    });
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.windowDragMove, (event, args: WindowDragPointInput) => {
    const input = parseWithSchema(windowDragPointInputSchema, args, "window drag options");
    const dragState = activeWindowDrags.get(event.sender.id);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!dragState) {
      return;
    }
    if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) {
      activeWindowDrags.delete(event.sender.id);
      return;
    }
    const nextX = Math.round(dragState.startWindowX + (input.screenX - dragState.startScreenX));
    const nextY = Math.round(dragState.startWindowY + (input.screenY - dragState.startScreenY));
    win.setPosition(nextX, nextY);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.windowDragEnd, (event) => {
    activeWindowDrags.delete(event.sender.id);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.getPlatform, () => {
    return process.platform;
  });
}
