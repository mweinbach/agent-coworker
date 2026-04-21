import path from "node:path";

import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  globalShortcut,
  nativeImage,
  screen,
  type Rectangle,
} from "electron";

import type { PersistedState } from "../../src/app/types";
import { normalizeDesktopSettings } from "../../src/app/types";
import type { ShowQuickChatWindowInput } from "../../src/lib/desktopApi";
import {
  DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
  formatQuickChatShortcutLabel,
} from "../../src/lib/quickChatShortcut";
import { createTrayMaskBitmap } from "./trayImage";

const QUICK_CHAT_WINDOW_EDGE_PADDING = 12;
const QUICK_CHAT_WINDOW_OFFSET = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

type QuickChatControllerOptions = {
  appName: string;
  platform?: NodeJS.Platform;
  trayIconPath: string;
  getMainWindow: () => BrowserWindow | null;
  createMainWindow: () => Promise<BrowserWindow>;
  createQuickChatWindow: (opts?: ShowQuickChatWindowInput) => Promise<BrowserWindow>;
  createUtilityWindow: () => Promise<BrowserWindow>;
};

export class QuickChatController {
  private readonly appName: string;
  private readonly platform: NodeJS.Platform;
  private readonly trayIconPath: string;
  private readonly getMainWindow: () => BrowserWindow | null;
  private readonly createMainWindow: () => Promise<BrowserWindow>;
  private readonly createQuickChatWindow: (opts?: ShowQuickChatWindowInput) => Promise<BrowserWindow>;
  private readonly createUtilityWindow: () => Promise<BrowserWindow>;

  private tray: Tray | null = null;
  private quickChatWindow: BrowserWindow | null = null;
  private utilityWindow: BrowserWindow | null = null;
  private quickChatThreadId: string | null = null;
  private quickChatShortcutEnabled = false;
  private quickChatShortcutAccelerator = DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR;
  private registeredShortcutAccelerator: string | null = null;
  private quitting = false;

  constructor(options: QuickChatControllerOptions) {
    this.appName = options.appName;
    this.platform = options.platform ?? process.platform;
    this.trayIconPath = options.trayIconPath;
    this.getMainWindow = options.getMainWindow;
    this.createMainWindow = options.createMainWindow;
    this.createQuickChatWindow = options.createQuickChatWindow;
    this.createUtilityWindow = options.createUtilityWindow;
  }

  initialize(): void {
    if (this.platform === "darwin" || this.platform === "win32") {
      this.ensureTray();
    }
    this.syncShortcutRegistration();
  }

  applyPersistedState(state: PersistedState): void {
    const settings = normalizeDesktopSettings(state.desktopSettings);
    this.quickChatShortcutEnabled = settings.quickChat.shortcutEnabled;
    this.quickChatShortcutAccelerator = settings.quickChat.shortcutAccelerator;
    this.syncShortcutRegistration();
    this.refreshTrayMenu();
  }

  async showMainWindow(): Promise<void> {
    this.hideUtilityWindow();
    this.hideQuickChatWindow();
    const existingWindow = this.getMainWindow();
    const win = existingWindow && !existingWindow.isDestroyed()
      ? existingWindow
      : await this.createMainWindow();
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
  }

  async showQuickChatWindow(opts: ShowQuickChatWindowInput & { anchorBounds?: Rectangle } = {}): Promise<void> {
    this.hideUtilityWindow();
    const win = await this.ensureQuickChatWindow(opts.threadId);
    this.positionPopupWindow(win, opts.anchorBounds ?? this.tray?.getBounds());
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
  }

  async toggleQuickChatWindow(anchorBounds?: Rectangle): Promise<void> {
    const win = await this.ensureQuickChatWindow();
    if (win.isVisible() && win.isFocused()) {
      this.hideQuickChatWindow();
      return;
    }
    await this.showQuickChatWindow({ anchorBounds });
  }

  async showUtilityWindow(anchorBounds?: Rectangle): Promise<void> {
    this.hideQuickChatWindow();
    const win = await this.ensureUtilityWindow();
    this.positionPopupWindow(win, anchorBounds ?? this.tray?.getBounds());
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
  }

  async toggleUtilityWindow(anchorBounds?: Rectangle): Promise<void> {
    const win = await this.ensureUtilityWindow();
    if (win.isVisible() && win.isFocused()) {
      this.hideUtilityWindow();
      return;
    }
    await this.showUtilityWindow(anchorBounds);
  }

  dispose(): void {
    this.quitting = true;
    this.unregisterCurrentShortcut();
    this.tray?.destroy();
    this.tray = null;
    this.destroyWindow(this.utilityWindow);
    this.destroyWindow(this.quickChatWindow);
    this.utilityWindow = null;
    this.quickChatWindow = null;
    this.quickChatThreadId = null;
  }

  private syncShortcutRegistration(): void {
    this.unregisterCurrentShortcut();
    if (!this.quickChatShortcutEnabled) {
      return;
    }

    try {
      const registered = globalShortcut.register(this.quickChatShortcutAccelerator, () => {
        void this.toggleQuickChatWindow();
      });
      if (!registered) {
        console.warn(`[desktop] Quick chat shortcut is unavailable: ${this.quickChatShortcutAccelerator}`);
        return;
      }
      this.registeredShortcutAccelerator = this.quickChatShortcutAccelerator;
    } catch (error) {
      console.warn(`[desktop] Failed to register quick chat shortcut: ${String(error)}`);
    }
  }

  private unregisterCurrentShortcut(): void {
    if (!this.registeredShortcutAccelerator) {
      return;
    }
    globalShortcut.unregister(this.registeredShortcutAccelerator);
    this.registeredShortcutAccelerator = null;
  }

  private ensureTray(): void {
    if (this.tray) {
      return;
    }
    const icon = this.buildTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip(`${this.appName} quick chat`);
    this.tray.on("click", () => {
      void this.toggleUtilityWindow(this.tray?.getBounds());
    });
    this.tray.on("double-click", () => {
      void this.toggleUtilityWindow(this.tray?.getBounds());
    });
    this.tray.on("right-click", () => {
      this.tray?.popUpContextMenu(this.buildTrayMenu());
    });
    this.refreshTrayMenu();
  }

  private refreshTrayMenu(): void {
    if (!this.tray) {
      return;
    }
    this.tray.setContextMenu(this.buildTrayMenu());
  }

  private buildTrayMenu() {
    const shortcutSuffix = this.quickChatShortcutEnabled
      ? ` (${formatQuickChatShortcutLabel(this.quickChatShortcutAccelerator)})`
      : "";
    return Menu.buildFromTemplate([
      {
        label: `Open Quick Chat${shortcutSuffix}`,
        click: () => {
          void this.showQuickChatWindow({ anchorBounds: this.tray?.getBounds() });
        },
      },
      {
        label: `Open ${this.appName}`,
        click: () => {
          void this.showMainWindow();
        },
      },
      { type: "separator" },
      {
        label: `Quit ${this.appName}`,
        click: () => {
          this.quitting = true;
          app.quit();
        },
      },
    ]);
  }

  private buildTrayIcon() {
    const iconPathCandidates = path.extname(this.trayIconPath).toLowerCase() === ".ico"
      ? [this.trayIconPath, this.trayIconPath.slice(0, -4) + ".png"]
      : [this.trayIconPath];
    const image = iconPathCandidates
      .map((candidatePath) => nativeImage.createFromPath(candidatePath))
      .find((candidateImage) => !candidateImage.isEmpty()) ?? nativeImage.createEmpty();
    if (image.isEmpty()) {
      console.warn(`[desktop] Tray icon asset was not found: ${this.trayIconPath}`);
    }
    const resized = image.resize({ height: this.platform === "darwin" ? 18 : 16 });
    if (this.platform === "darwin" && !resized.isEmpty()) {
      const { width, height } = resized.getSize();
      if (width > 0 && height > 0) {
        const templated = nativeImage.createFromBitmap(createTrayMaskBitmap(resized.toBitmap()), {
          width,
          height,
          scaleFactor: 1,
        });
        templated.setTemplateImage(true);
        return templated;
      }
    }
    return resized;
  }

  private async ensureQuickChatWindow(threadId?: string): Promise<BrowserWindow> {
    if (threadId && this.quickChatWindow && !this.quickChatWindow.isDestroyed() && this.quickChatThreadId !== threadId) {
      this.destroyWindow(this.quickChatWindow);
      this.quickChatWindow = null;
      this.quickChatThreadId = null;
    }

    if (this.quickChatWindow && !this.quickChatWindow.isDestroyed()) {
      return this.quickChatWindow;
    }

    const win = await this.createQuickChatWindow(threadId ? { threadId } : undefined);
    this.quickChatWindow = win;
    this.quickChatThreadId = threadId ?? null;
    win.on("close", (event) => {
      if (this.quitting) {
        return;
      }
      event.preventDefault();
      win.hide();
    });
    win.on("closed", () => {
      if (this.quickChatWindow === win) {
        this.quickChatWindow = null;
        this.quickChatThreadId = null;
      }
    });
    return win;
  }

  private hideQuickChatWindow(): void {
    if (!this.quickChatWindow || this.quickChatWindow.isDestroyed()) {
      return;
    }
    this.quickChatWindow.hide();
  }

  private async ensureUtilityWindow(): Promise<BrowserWindow> {
    if (this.utilityWindow && !this.utilityWindow.isDestroyed()) {
      return this.utilityWindow;
    }

    const win = await this.createUtilityWindow();
    this.utilityWindow = win;
    win.on("blur", () => {
      if (!this.quitting) {
        win.hide();
      }
    });
    win.on("close", (event) => {
      if (this.quitting) {
        return;
      }
      event.preventDefault();
      win.hide();
    });
    win.on("closed", () => {
      if (this.utilityWindow === win) {
        this.utilityWindow = null;
      }
    });
    return win;
  }

  private hideUtilityWindow(): void {
    if (!this.utilityWindow || this.utilityWindow.isDestroyed()) {
      return;
    }
    this.utilityWindow.hide();
  }

  private destroyWindow(win: BrowserWindow | null): void {
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  }

  private positionPopupWindow(win: BrowserWindow, anchorBounds?: Rectangle): void {
    const currentBounds = win.getBounds();
    const display = anchorBounds
      ? screen.getDisplayMatching(anchorBounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const workArea = display.workArea;

    let x = workArea.x + Math.round((workArea.width - currentBounds.width) / 2);
    let y = workArea.y + Math.round((workArea.height - currentBounds.height) / 2);

    if (anchorBounds) {
      if (this.platform === "darwin") {
        x = Math.round(anchorBounds.x + (anchorBounds.width / 2) - (currentBounds.width / 2));
        y = Math.round(anchorBounds.y + anchorBounds.height + QUICK_CHAT_WINDOW_OFFSET);
      } else {
        x = Math.round(anchorBounds.x + anchorBounds.width - currentBounds.width);
        y = Math.round(anchorBounds.y - currentBounds.height - QUICK_CHAT_WINDOW_OFFSET);
      }
    }

    const minX = workArea.x + QUICK_CHAT_WINDOW_EDGE_PADDING;
    const maxX = workArea.x + workArea.width - currentBounds.width - QUICK_CHAT_WINDOW_EDGE_PADDING;
    const minY = workArea.y + QUICK_CHAT_WINDOW_EDGE_PADDING;
    const maxY = workArea.y + workArea.height - currentBounds.height - QUICK_CHAT_WINDOW_EDGE_PADDING;

    win.setBounds({
      ...currentBounds,
      x: clamp(x, minX, Math.max(minX, maxX)),
      y: clamp(y, minY, Math.max(minY, maxY)),
    });
  }
}
