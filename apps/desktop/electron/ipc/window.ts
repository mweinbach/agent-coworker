import { BrowserWindow, Menu } from "electron";

import {
  DESKTOP_IPC_CHANNELS,
  type PlatformChromeInfo,
  type ShowContextMenuInput,
  type ShowQuickChatWindowInput,
  type WindowCloseResponseInput,
} from "../../src/lib/desktopApi";
import {
  showCanvasWindowInputSchema,
  showContextMenuInputSchema,
  showQuickChatWindowInputSchema,
  windowCloseResponseInputSchema,
} from "../../src/lib/desktopSchemas";
import { getPlatformChrome } from "../services/windowChrome/platformChrome";
import type { DesktopIpcModuleContext } from "./types";
import { resolveDesktopIpcWindowMode } from "./windowMode";

export function registerWindowIpc(context: DesktopIpcModuleContext): void {
  const { deps, handleDesktopInvoke, parseWithSchema } = context;
  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.showContextMenu,
    async (event, args: ShowContextMenuInput) => {
      const input = parseWithSchema(showContextMenuInputSchema, args, "showContextMenu options");
      return new Promise<string | null>((resolve) => {
        const menu = Menu.buildFromTemplate(
          input.items.map((item) => ({
            id: item.id,
            label: item.label,
            enabled: item.enabled !== false,
            click: () => resolve(item.id),
          })),
        );

        const ownerWindow =
          BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
        if (!ownerWindow) {
          resolve(null);
          return;
        }

        menu.popup({ window: ownerWindow, callback: () => resolve(null) });
      });
    },
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.windowClose, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }

    const windowMode = resolveDesktopIpcWindowMode(event);
    if (
      (windowMode === "quick-chat" || windowMode === "utility") &&
      deps.shouldKeepPopupWindowsAlive?.() === true
    ) {
      win.hide();
      return;
    }

    win.close();
  });

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.resolveWindowCloseRequest,
    (event, args: WindowCloseResponseInput) => {
      const input = parseWithSchema(windowCloseResponseInputSchema, args, "window close response");
      deps.resolveWindowCloseRequest(event.sender, input);
    },
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.getPlatformChrome, (): PlatformChromeInfo => {
    const chrome = getPlatformChrome(process.platform as NodeJS.Platform);
    return {
      platform: chrome.platform,
      titlebarHeight: chrome.titlebarHeight,
      dragStripHeight: chrome.dragStripHeight,
      leftNativeReserve: chrome.leftNativeReserve,
      rightNativeReserve: chrome.rightNativeReserve,
      captionButtonReserve: chrome.captionButtonReserve,
      collapsedLeftRailWidth: chrome.collapsedLeftRailWidth,
      topbarToolbarGap: chrome.topbarToolbarGap,
      sidebarTitlebandMode: chrome.sidebarTitlebandMode,
      topbarControlPlacement: chrome.topbarControlPlacement,
      usesNativeGlass: chrome.usesNativeGlass,
      disableCssBlur: chrome.disableCssBlur,
    };
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.showMainWindow, async () => {
    await deps.showMainWindow();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.consumePendingMenuCommands, () => {
    return deps.consumePendingMenuCommands();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.showCanvasWindow, async (_event, args) => {
    const input = parseWithSchema(
      showCanvasWindowInputSchema,
      args ?? {},
      "showCanvasWindow options",
    );
    await deps.showCanvasWindow(input);
  });

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.showQuickChatWindow,
    async (_event, args?: ShowQuickChatWindowInput) => {
      const input = parseWithSchema(
        showQuickChatWindowInputSchema,
        args ?? {},
        "showQuickChatWindow options",
      );
      await deps.showQuickChatWindow(input);
    },
  );
}
