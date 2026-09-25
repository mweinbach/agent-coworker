import { beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import { getPlatformChrome } from "../electron/services/windowChrome/platformChrome";
import { DESKTOP_IPC_CHANNELS, type PlatformChromeInfo } from "../src/lib/desktopApi";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

type FakeWindow = {
  closeCalls: number;
  hideCalls: number;
  close(): void;
  hide(): void;
};

const windowsBySenderId = new Map<number, FakeWindow>();

const electronMockOverrides = {
  app: {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getName: () => "Cowork Test",
    isPackaged: false,
  },
  BrowserWindow: {
    fromWebContents(sender: { id: number }) {
      return windowsBySenderId.get(sender.id) ?? null;
    },
    getFocusedWindow() {
      return null;
    },
  },
  Menu: {
    buildFromTemplate() {
      return {
        popup({ callback }: { callback?: () => void }) {
          callback?.();
        },
      };
    },
  },
  dialog: {
    async showOpenDialog() {
      return { canceled: true, filePaths: [] };
    },
  },
};

setElectronMockOverrides(electronMockOverrides);

mock.module("electron", () => createElectronMock());

const { registerWindowIpc } = await import("../electron/ipc/window");

class FakeWebContents extends EventEmitter {
  constructor(
    readonly id: number,
    private readonly url = "file:///renderer/index.html",
  ) {
    super();
  }

  getURL() {
    return this.url;
  }
}

function createFakeWindow(): FakeWindow {
  return {
    closeCalls: 0,
    hideCalls: 0,
    close() {
      this.closeCalls += 1;
    },
    hide() {
      this.hideCalls += 1;
    },
  };
}

function expectedPlatformChromeInfo(): PlatformChromeInfo {
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
}

function createHandlers(options: { shouldKeepPopupWindowsAlive?: () => boolean } = {}) {
  const handlers = new Map<
    string,
    (event: { sender: FakeWebContents }, args?: unknown) => unknown
  >();
  const showMainWindow = mock(async () => {});
  const consumePendingMenuCommands = mock(() => ["openSettings"] as const);
  const showQuickChatWindow = mock(async () => {});
  registerWindowIpc({
    deps: {
      showMainWindow,
      consumePendingMenuCommands,
      showQuickChatWindow,
      shouldKeepPopupWindowsAlive: options.shouldKeepPopupWindowsAlive,
    } as never,
    workspaceRoots: {} as never,
    handleDesktopInvoke(channel, handler) {
      handlers.set(channel, handler as never);
    },
    parseWithSchema(_schema, value) {
      return value as never;
    },
  });
  return { handlers, consumePendingMenuCommands, showMainWindow, showQuickChatWindow };
}

describe("window IPC", () => {
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
  });

  test("exposes show window IPC actions", async () => {
    const { handlers, consumePendingMenuCommands, showMainWindow, showQuickChatWindow } =
      createHandlers();
    const sender = new FakeWebContents(21);

    await handlers.get(DESKTOP_IPC_CHANNELS.showMainWindow)?.({ sender });
    expect(
      await handlers.get(DESKTOP_IPC_CHANNELS.consumePendingMenuCommands)?.({ sender }),
    ).toEqual(["openSettings"]);
    await handlers.get(DESKTOP_IPC_CHANNELS.showQuickChatWindow)?.(
      { sender },
      { threadId: "thread-21", newThread: true },
    );

    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(consumePendingMenuCommands).toHaveBeenCalledTimes(1);
    expect(showQuickChatWindow).toHaveBeenCalledTimes(1);
    expect(showQuickChatWindow).toHaveBeenCalledWith({ threadId: "thread-21", newThread: true });
  });

  test("projects platform chrome contract through IPC", () => {
    const { handlers } = createHandlers();
    const sender = new FakeWebContents(25);
    const handler = handlers.get(DESKTOP_IPC_CHANNELS.getPlatformChrome);

    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error("getPlatformChrome IPC handler was not registered");
    }

    expect(handler({ sender })).toEqual(expectedPlatformChromeInfo());
  });

  test("hides popup windows while popup keep-alive is active", () => {
    windowsBySenderId.clear();
    const { handlers } = createHandlers({ shouldKeepPopupWindowsAlive: () => true });
    const sender = new FakeWebContents(31, "file:///renderer/index.html?window=utility");
    const win = createFakeWindow();
    windowsBySenderId.set(sender.id, win);

    handlers.get(DESKTOP_IPC_CHANNELS.windowClose)?.({ sender });

    expect(win.hideCalls).toBe(1);
    expect(win.closeCalls).toBe(0);
  });

  test("closes canvas windows even while popup keep-alive is active", () => {
    windowsBySenderId.clear();
    const { handlers } = createHandlers({ shouldKeepPopupWindowsAlive: () => true });
    const sender = new FakeWebContents(35, "file:///renderer/index.html?window=canvas");
    const win = createFakeWindow();
    windowsBySenderId.set(sender.id, win);

    handlers.get(DESKTOP_IPC_CHANNELS.windowClose)?.({ sender });

    expect(win.hideCalls).toBe(0);
    expect(win.closeCalls).toBe(1);
  });

  test("closes popup windows when popup keep-alive is inactive", () => {
    windowsBySenderId.clear();
    const { handlers } = createHandlers({ shouldKeepPopupWindowsAlive: () => false });
    const sender = new FakeWebContents(33, "file:///renderer/index.html?window=quick-chat");
    const win = createFakeWindow();
    windowsBySenderId.set(sender.id, win);

    handlers.get(DESKTOP_IPC_CHANNELS.windowClose)?.({ sender });

    expect(win.closeCalls).toBe(1);
    expect(win.hideCalls).toBe(0);
  });

  test("keeps normal close behavior for the main window", () => {
    windowsBySenderId.clear();
    const { handlers } = createHandlers();
    const sender = new FakeWebContents(32, "file:///renderer/index.html");
    const win = createFakeWindow();
    windowsBySenderId.set(sender.id, win);

    handlers.get(DESKTOP_IPC_CHANNELS.windowClose)?.({ sender });

    expect(win.closeCalls).toBe(1);
    expect(win.hideCalls).toBe(0);
  });
});
